import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AdminUser, AuditLog, Model, SystemSetting, Upstream } from "@gateway/database";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { GeminiApiException } from "../src/public-api/gemini-errors.js";
import {
  MAINTENANCE_MESSAGE_DEFAULT,
  settingKeys,
} from "../src/settings/settings.definitions.js";
import { SpendGuardService } from "../src/settings/spend-guard.service.js";
import { cookieHeaderValue, createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";

interface Session {
  cookieHeader: string;
  csrfToken: string;
  adminId: string;
}

describe("settings", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;
  let session: Session;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    session = await login();
  });

  it("returns defaults and definitions when the table is empty", async () => {
    const response = await request(httpServer)
      .get("/admin/settings")
      .set("Cookie", session.cookieHeader)
      .expect(200);

    expect(response.body.settings["gateway.enabled"]).toBe(true);
    expect(response.body.settings["gateway.maintenanceMode"]).toBe(false);
    expect(response.body.settings["gateway.maintenanceMessage"]).toBe(MAINTENANCE_MESSAGE_DEFAULT);
    expect(response.body.settings["gateway.killSwitch"]).toBe(false);
    expect(response.body.settings["keys.defaultRequestsPerMinute"]).toBeNull();
    expect(response.body.settings["keys.defaultAllowedModels"]).toEqual([]);
    expect(response.body.settings["keys.defaultLifetimeDays"]).toBeNull();
    expect(response.body.settings["timeouts.requestMs"]).toBe(120_000);
    expect(response.body.settings["timeouts.streamIdleMs"]).toBe(60_000);
    expect(response.body.settings["timeouts.upstreamConnectMs"]).toBe(15_000);
    expect(response.body.settings["media.allowFileUris"]).toBe(false);
    expect(response.body.settings["media.fileUriHoldTokens"]).toBe(50_000);
    expect(response.body.settings["logging.metadataRetentionDays"]).toBe(90);
    expect(response.body.settings["logging.contentLoggingEnabled"]).toBe(false);
    expect(response.body.settings["billing.currency"]).toBe("USD");
    expect(response.body.settings["gateway.publicUrl"]).toBeNull();
    expect(response.body.settings["spend.upstreamBudget"]).toBeNull();
    expect(response.body.settings["spend.safetyReserve"]).toBe("0");
    expect(response.body.settings["spend.blockWhenThresholdReached"]).toBe(false);
    expect(response.body.definitions).toHaveLength(settingKeys.length);

    const enabled = response.body.definitions.find(
      (definition: { key?: string }) => definition.key === "gateway.enabled",
    );
    expect(enabled).toMatchObject({
      key: "gateway.enabled",
      type: "boolean",
      default: true,
    });
    expect(typeof enabled.label).toBe("string");
    expect(typeof enabled.description).toBe("string");
    expect(await dataSource.getRepository(SystemSetting).count()).toBe(0);
  });

  it("requires a session and a CSRF token", async () => {
    const missingSession = await request(httpServer).get("/admin/settings");
    expect(missingSession.status).toBe(401);

    const missingSpendSession = await request(httpServer).get("/admin/settings/spend");
    expect(missingSpendSession.status).toBe(401);

    const missingPutSession = await request(httpServer).put("/admin/settings").send({});
    expect(missingPutSession.status).toBe(401);

    const missingCsrf = await request(httpServer)
      .put("/admin/settings")
      .set("Cookie", session.cookieHeader)
      .send({ "gateway.enabled": false });
    expect(missingCsrf.status).toBe(403);

    const read = await request(httpServer)
      .get("/admin/settings")
      .set("Cookie", session.cookieHeader);
    expect(read.status).toBe(200);
  });

  it("rejects an unknown key and a bad value by name without writing", async () => {
    const unknown = await putSettings({ "not.a.setting": true });
    expect(unknown.status).toBe(400);
    expect(messageLines(unknown)).toContain("not.a.setting: Unknown setting");

    const invalid = await putSettings({
      "timeouts.requestMs": 50,
      "billing.currency": "EUR",
    });
    expect(invalid.status).toBe(400);
    expect(messageLines(invalid).some((line) => line.startsWith("timeouts.requestMs:"))).toBe(true);
    expect(messageLines(invalid).some((line) => line.includes("billing.currency"))).toBe(false);
    expect(await dataSource.getRepository(SystemSetting).count()).toBe(0);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED)).toHaveLength(0);
  });

  it("persists and audits only the keys whose values changed", async () => {
    const first = await putSettings({
      "timeouts.requestMs": 5000,
      "gateway.enabled": true,
    });
    expect(first.status).toBe(200);
    expect(first.body.settings["timeouts.requestMs"]).toBe(5000);
    expect(first.body.settings["gateway.enabled"]).toBe(true);

    const rows = await dataSource.getRepository(SystemSetting).find();
    expect(rows).toEqual([
      expect.objectContaining({
        key: "timeouts.requestMs",
        value: 5000,
        updatedByAdminId: session.adminId,
      }),
    ]);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      adminUserId: session.adminId,
      entityType: "system_setting",
      entityId: null,
      before: { "timeouts.requestMs": 120_000 },
      after: { "timeouts.requestMs": 5000 },
    });

    const repeat = await putSettings({ "timeouts.requestMs": 5000 });
    expect(repeat.status).toBe(200);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED)).toHaveLength(1);

    const second = await putSettings({
      "timeouts.requestMs": 5000,
      "gateway.enabled": false,
    });
    expect(second.status).toBe(200);
    const afterSecond = await auditsFor(ADMIN_AUDIT_ACTIONS.SETTINGS_UPDATED);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]).toMatchObject({
      before: { "gateway.enabled": true },
      after: { "gateway.enabled": false },
    });
    expect(afterSecond[1]?.before).not.toHaveProperty("timeouts.requestMs");

    // JSON null must be stored as jsonb null. The column itself is NOT NULL.
    await putSettings({ "gateway.publicUrl": "https://gateway.example.com" }).expect(200);
    await putSettings({ "gateway.publicUrl": null }).expect(200);
    const urlRow = await dataSource.getRepository(SystemSetting).findOneBy({
      key: "gateway.publicUrl",
    });
    expect(urlRow?.value).toBeNull();
    const cleared = await request(httpServer)
      .get("/admin/settings")
      .set("Cookie", session.cookieHeader)
      .expect(200);
    expect(cleared.body.settings["gateway.publicUrl"]).toBeNull();
  });

  it("rejects public traffic with the kill switch, maintenance message, and disabled gateway", async () => {
    const { rawKey } = await seedServingModel();

    const open = await request(httpServer).get("/v1beta/models").set("x-goog-api-key", rawKey);
    expect(open.status, JSON.stringify(open.body)).toBe(200);

    // Update invalidates the in-process cache, so the gate changes without waiting out the TTL.
    await putSettings({ "gateway.killSwitch": true }).expect(200);

    const killed = await request(httpServer).get("/v1beta/models");
    expect(killed.body).toEqual({
      error: {
        code: 503,
        message: "The gateway is temporarily disabled.",
        status: "UNAVAILABLE",
      },
    });
    expect(killed.status).toBe(503);

    const killedWithKey = await request(httpServer)
      .get("/v1beta/models")
      .set("x-goog-api-key", rawKey);
    expect(killedWithKey.status).toBe(503);
    expect(killedWithKey.body.error.message).toBe("The gateway is temporarily disabled.");

    await putSettings({ "gateway.killSwitch": false }).expect(200);
    const unauthenticated = await request(httpServer).get("/v1beta/models");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.status).toBe("UNAUTHENTICATED");

    const restored = await request(httpServer).get("/v1beta/models").set("x-goog-api-key", rawKey);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);

    await putSettings({
      "gateway.killSwitch": true,
      "gateway.enabled": false,
      "gateway.maintenanceMode": true,
      "gateway.maintenanceMessage": "Down for database work.",
    }).expect(200);
    const precedence = await request(httpServer).get("/v1beta/models");
    expect(precedence.status).toBe(503);
    expect(precedence.body.error.message).toBe("The gateway is temporarily disabled.");

    await putSettings({ "gateway.killSwitch": false }).expect(200);
    const disabled = await request(httpServer).get("/v1beta/models");
    expect(disabled.status).toBe(503);
    expect(disabled.body.error.message).toBe("The gateway is disabled.");

    await putSettings({ "gateway.enabled": true }).expect(200);
    const maintenance = await request(httpServer).get("/v1beta/models");
    expect(maintenance.status).toBe(503);
    expect(maintenance.body).toEqual({
      error: {
        code: 503,
        message: "Down for database work.",
        status: "UNAVAILABLE",
      },
    });
  });

  it("reports tracked spend from negative cost debits and enforces the usable target", async () => {
    const first = await createKey({ name: "spend-a" });
    const second = await createKey({ name: "spend-b" });
    await dataSource.query(
      `INSERT INTO credit_transactions (api_key_id, type, amount, currency)
       VALUES ($1, 'cost_consumed', '-10.000000', 'USD'),
              ($1, 'cost_consumed', '-2.500000', 'USD'),
              ($1, 'credit_added', '100.000000', 'USD'),
              ($2, 'cost_consumed', '-1.250000', 'USD')`,
      [first.apiKey.id, second.apiKey.id],
    );

    const initial = await request(httpServer)
      .get("/admin/settings/spend")
      .set("Cookie", session.cookieHeader)
      .expect(200);
    expect(initial.body).toEqual({
      trackedSpendUsd: "13.750000",
      upstreamBudget: null,
      safetyReserve: "0",
      usableTarget: null,
      thresholdReached: false,
      label: "Gateway tracked / estimated upstream spend",
    });

    await putSettings({
      "spend.upstreamBudget": "20",
      "spend.safetyReserve": "0",
    }).expect(200);
    const under = await request(httpServer)
      .get("/admin/settings/spend")
      .set("Cookie", session.cookieHeader)
      .expect(200);
    expect(under.body.usableTarget).toBe("20.000000");
    expect(under.body.thresholdReached).toBe(false);

    await putSettings({
      "spend.upstreamBudget": "20",
      "spend.safetyReserve": "6.25",
      "spend.blockWhenThresholdReached": false,
    }).expect(200);
    const reached = await request(httpServer)
      .get("/admin/settings/spend")
      .set("Cookie", session.cookieHeader)
      .expect(200);
    expect(reached.body).toMatchObject({
      trackedSpendUsd: "13.750000",
      upstreamBudget: "20",
      safetyReserve: "6.25",
      usableTarget: "13.750000",
      thresholdReached: true,
      label: "Gateway tracked / estimated upstream spend",
    });

    const spend = app.get(SpendGuardService);
    await expect(spend.assertWithinBudget()).resolves.toBeUndefined();

    await putSettings({ "spend.blockWhenThresholdReached": true }).expect(200);
    await expect(spend.assertWithinBudget()).rejects.toBeInstanceOf(GeminiApiException);
    try {
      await spend.assertWithinBudget();
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiApiException);
      if (error instanceof GeminiApiException) {
        expect(error.getStatus()).toBe(503);
        expect(error.getResponse()).toEqual({
          error: {
            code: 503,
            message: "The gateway's spending limit has been reached.",
            status: "UNAVAILABLE",
          },
        });
      }
    }

    await putSettings({
      "spend.upstreamBudget": "100",
      "spend.safetyReserve": "0",
    }).expect(200);
    const cleared = await request(httpServer)
      .get("/admin/settings/spend")
      .set("Cookie", session.cookieHeader)
      .expect(200);
    expect(cleared.body.thresholdReached).toBe(false);
    expect(cleared.body.usableTarget).toBe("100.000000");
    await expect(spend.assertWithinBudget()).resolves.toBeUndefined();
  });

  it("applies key defaults only for fields the create request omits", async () => {
    await putSettings({
      "keys.defaultRequestsPerMinute": 15,
      "keys.defaultRequestsPerDay": 200,
      "keys.defaultMaxConcurrentRequests": 3,
      "keys.defaultAllowedModels": ["gemini-2.5-flash"],
      "keys.defaultLifetimeDays": 14,
      "keys.defaultInitialCredit": "25.5",
    }).expect(200);

    const before = Date.now();
    const created = await createKey({ name: "from-defaults" });
    const after = Date.now();
    const day = 24 * 60 * 60 * 1000;
    expect(created.apiKey.expiresAt).toEqual(expect.any(String));
    const expires = new Date(created.apiKey.expiresAt ?? "").getTime();

    expect(created.apiKey.requestsPerMinute).toBe(15);
    expect(created.apiKey.requestsPerDay).toBe(200);
    expect(created.apiKey.maxConcurrentRequests).toBe(3);
    expect(created.apiKey.allowedModels).toEqual(["gemini-2.5-flash"]);
    expect(expires).toBeGreaterThanOrEqual(before + 14 * day);
    expect(expires).toBeLessThanOrEqual(after + 14 * day);

    const explicitExpiry = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const explicit = await createKey({
      name: "explicit",
      requestsPerMinute: null,
      requestsPerDay: 5,
      maxConcurrentRequests: 1,
      allowedModels: [],
      expiresAt: explicitExpiry,
    });
    expect(explicit.apiKey.requestsPerMinute).toBeNull();
    expect(explicit.apiKey.requestsPerDay).toBe(5);
    expect(explicit.apiKey.maxConcurrentRequests).toBe(1);
    expect(explicit.apiKey.allowedModels).toEqual([]);
    expect(explicit.apiKey.expiresAt).toEqual(expect.any(String));
    expect(new Date(explicit.apiKey.expiresAt ?? "").toISOString()).toBe(explicitExpiry);
  });

  async function login(): Promise<Session> {
    const hasher = app.get(PasswordHasher);
    await dataSource.getRepository(AdminUser).save({
      email: "admin@example.com",
      passwordHash: await hasher.hash("password"),
      enabled: true,
    });
    const response = await request(httpServer)
      .post("/admin/auth/login")
      .send({ email: "admin@example.com", password: "password" })
      .expect(200);
    return {
      cookieHeader: cookieHeaderValue(sessionCookie(response)),
      csrfToken: response.body.csrfToken as string,
      adminId: response.body.admin.id as string,
    };
  }

  function putSettings(body: Record<string, unknown>): request.Test {
    return request(httpServer)
      .put("/admin/settings")
      .set("Cookie", session.cookieHeader)
      .set("x-csrf-token", session.csrfToken)
      .send(body);
  }

  async function createKey(body: Record<string, unknown>): Promise<{
    apiKey: {
      id: string;
      requestsPerMinute: number | null;
      requestsPerDay: number | null;
      maxConcurrentRequests: number | null;
      allowedModels: string[];
      expiresAt: string | null;
    };
    rawKey: string;
  }> {
    const response = await request(httpServer)
      .post("/admin/api-keys")
      .set("Cookie", session.cookieHeader)
      .set("x-csrf-token", session.csrfToken)
      .send(body)
      .expect(201);
    return response.body;
  }

  async function seedServingModel(): Promise<{ rawKey: string }> {
    const upstream = await dataSource.getRepository(Upstream).save({
      name: "google-main",
      projectId: "test-project",
      location: "global",
      provider: "vertex-ai",
      authMethod: "api-key",
      enabled: true,
    });
    await dataSource.getRepository(Model).save({
      publicName: "gemini-2.5-flash",
      displayName: "Flash",
      provider: "vertex-ai",
      upstreamModelName: "gemini-2.5-flash",
      upstreamId: upstream.id,
      enabled: true,
      availabilityStatus: "available",
      supportsText: true,
    });
    const created = await createKey({ name: "public" });
    return { rawKey: created.rawKey };
  }

  async function auditsFor(action: string): Promise<AuditLog[]> {
    return dataSource.getRepository(AuditLog).find({
      where: { action },
      order: { createdAt: "ASC" },
    });
  }
});

function messageLines(response: Response): string[] {
  const message = response.body.message;
  if (typeof message === "string") {
    return [message];
  }
  if (Array.isArray(message) && message.every((line) => typeof line === "string")) {
    return message;
  }
  return [];
}
