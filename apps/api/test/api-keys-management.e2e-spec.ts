import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import {
  AdminUser,
  ApiKey,
  AuditLog,
  CreditTransaction,
  Model,
  Upstream,
  UsageRecord,
} from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { ADMIN_AUDIT_ACTIONS, ApiKeyStatus } from "@gateway/contracts";
import { hashApiKey } from "../src/api-keys/api-key-material.js";
import { RequestLimiter } from "../src/rate-limits/request-limiter.js";
import { startOfUtcDay, startOfUtcMonth } from "../src/analytics/analytics-range.js";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const DELETE_CONFLICT = "Keys with usage or credit history can't be deleted. Revoke the key instead.";

describe("Api key management (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;
  let modelId: string;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);

    const hasher = app.get(PasswordHasher);
    const pass = await hasher.hash("password");
    await dataSource.getRepository(AdminUser).save({
      email: "admin@example.com",
      passwordHash: pass,
      enabled: true,
    });

    const res = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .send({ email: "admin@example.com", password: "password" });

    sessionHeader = cookieHeaderValue(sessionCookie(res));
    csrfToken = res.body.csrfToken;

    const upstream = await dataSource.getRepository(Upstream).save({
      name: "Test Upstream",
      provider: "vertex-ai",
      projectId: "test-project",
      location: "us-central1",
      authMethod: "api-key",
    });
    const model = await dataSource.getRepository(Model).save({
      publicName: "gemini-test",
      upstreamModelName: "gemini-test",
      displayName: "Gemini Test",
      provider: "vertex-ai",
      upstreamId: upstream.id,
    });
    modelId = model.id;
  });

  function authed(method: "get" | "post" | "delete", path: string) {
    const req = request(app.getHttpServer())[method](path).set("Cookie", sessionHeader);
    if (method !== "get") {
      req.set("x-csrf-token", csrfToken);
    }
    return req;
  }

  async function createKey(payload: Record<string, unknown> = { name: "Test Key" }) {
    const res = await authed("post", "/admin/api-keys").send(payload);
    expect(res.status).toBe(201);
    return res.body as {
      apiKey: { id: string; keyPrefix: string; credit?: { remaining: string; consumed: string } };
      rawKey: string;
    };
  }

  async function insertUsage(
    apiKeyId: string,
    requestId: string,
    createdAt: Date,
    inputTokens: string | null,
    outputTokens: string | null,
  ) {
    await dataSource.getRepository(UsageRecord).save({
      requestId,
      apiKeyId,
      modelId,
      endpoint: "generateContent",
      status: "success",
      inputTokens,
      outputTokens,
      currency: "USD",
    });
    await dataSource.query("UPDATE usage_records SET created_at = $1 WHERE request_id = $2", [
      createdAt,
      requestId,
    ]);
  }

  describe("session and CSRF", () => {
    it("rejects missing sessions and missing CSRF tokens", async () => {
      const { apiKey } = await createKey();
      const server = app.getHttpServer();

      await request(server).post(`/admin/api-keys/${apiKey.id}/regenerate`).expect(401);
      await request(server)
        .post(`/admin/api-keys/${apiKey.id}/regenerate`)
        .set("Cookie", sessionHeader)
        .expect(403);

      await request(server).post(`/admin/api-keys/${apiKey.id}/reset-counters`).expect(401);
      await request(server)
        .post(`/admin/api-keys/${apiKey.id}/reset-counters`)
        .set("Cookie", sessionHeader)
        .expect(403);

      await request(server).delete(`/admin/api-keys/${apiKey.id}`).expect(401);
      await request(server).delete(`/admin/api-keys/${apiKey.id}`).set("Cookie", sessionHeader).expect(403);

      await request(server).get(`/admin/api-keys/${apiKey.id}/limits-usage`).expect(401);
      await request(server).get("/admin/api-keys").expect(401);
    });

    it("404s unknown keys", async () => {
      await authed("post", `/admin/api-keys/${MISSING_ID}/regenerate`).expect(404);
      await authed("post", `/admin/api-keys/${MISSING_ID}/reset-counters`).expect(404);
      await authed("delete", `/admin/api-keys/${MISSING_ID}`).expect(404);
      await authed("get", `/admin/api-keys/${MISSING_ID}/limits-usage`).expect(404);
    });
  });

  describe("regenerate", () => {
    it("replaces the secret and leaves balance, ledger, and limits in place", async () => {
      const created = await createKey({ name: "Rotate me", initialCredit: "10.00", requestsPerMinute: 7 });
      const id = created.apiKey.id;
      const oldRaw = created.rawKey;
      const oldHash = hashApiKey(oldRaw);

      const before = await authed("get", `/admin/api-keys/${id}`).expect(200);
      const ledgerBefore = await dataSource.getRepository(CreditTransaction).find({
        where: { apiKeyId: id },
        order: { createdAt: "ASC" },
      });
      expect(ledgerBefore.length).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", oldRaw)
        .expect(200);

      const regenerated = await authed("post", `/admin/api-keys/${id}/regenerate`).expect(200);
      const newRaw = regenerated.body.rawKey as string;
      expect(newRaw).toMatch(/^lvg_[A-Za-z0-9]{32}$/);
      expect(newRaw).not.toBe(oldRaw);
      expect(regenerated.body.apiKey.id).toBe(id);
      expect(regenerated.body.apiKey.keyPrefix).toBe(newRaw.slice(0, 12));
      expect(regenerated.body.apiKey.requestsPerMinute).toBe(7);
      expect(regenerated.body.apiKey.credit.remaining).toBe(before.body.apiKey.credit.remaining);

      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", oldRaw)
        .expect(401);
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", newRaw)
        .expect(200);

      const after = await authed("get", `/admin/api-keys/${id}`).expect(200);
      expect(after.body.apiKey.credit.remaining).toBe(before.body.apiKey.credit.remaining);
      expect(after.body.apiKey.credit.consumed).toBe(before.body.apiKey.credit.consumed);
      expect(after.body.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(after.body.apiKey.requestsPerMinute).toBe(7);
      expect(after.body.apiKey.keyPrefix).toBe(newRaw.slice(0, 12));

      const stored = await dataSource.getRepository(ApiKey).findOne({ where: { id } });
      expect(stored?.keyHash).toBe(hashApiKey(newRaw));
      expect(stored?.keyHash).not.toBe(oldHash);
      expect(stored?.status).toBe(ApiKeyStatus.ACTIVE);

      const ledgerAfter = await dataSource.getRepository(CreditTransaction).find({
        where: { apiKeyId: id },
        order: { createdAt: "ASC" },
      });
      expect(ledgerAfter.map((row) => ({ id: row.id, amount: row.amount, type: row.type }))).toEqual(
        ledgerBefore.map((row) => ({ id: row.id, amount: row.amount, type: row.type })),
      );

      const audits = await dataSource.getRepository(AuditLog).find({
        where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_REGENERATED, entityId: id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.before).toEqual({ keyPrefix: oldRaw.slice(0, 12) });
      expect(audits[0]?.after).toEqual({ keyPrefix: newRaw.slice(0, 12) });
      const blob = JSON.stringify(audits[0]);
      expect(blob).not.toContain(oldRaw);
      expect(blob).not.toContain(newRaw);
      expect(blob).not.toContain(oldHash);
      expect(blob).not.toContain(hashApiKey(newRaw));
    });

    it("refuses a revoked key", async () => {
      const { apiKey, rawKey } = await createKey({ name: "Revoked" });
      await authed("post", `/admin/api-keys/${apiKey.id}/revoke`).expect(201);
      const before = await dataSource.getRepository(ApiKey).findOne({ where: { id: apiKey.id } });

      const res = await authed("post", `/admin/api-keys/${apiKey.id}/regenerate`).expect(409);
      expect(res.body.message).toBe("Revoked keys can't be regenerated.");

      const after = await dataSource.getRepository(ApiKey).findOne({ where: { id: apiKey.id } });
      expect(after?.keyHash).toBe(before?.keyHash);
      expect(after?.keyPrefix).toBe(rawKey.slice(0, 12));
      expect(
        await dataSource.getRepository(AuditLog).count({
          where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_REGENERATED },
        }),
      ).toBe(0);
    });
  });

  describe("reset counters", () => {
    it("clears RequestLimiter usage and leaves usage records and the ledger untouched", async () => {
      const { apiKey } = await createKey({ name: "Counted", initialCredit: "3.00" });
      await insertUsage(apiKey.id, "usage-kept", new Date(), "10", "5");

      const limiter = app.get(RequestLimiter);
      const limits = {
        requestsPerMinute: 10,
        requestsPerDay: 100,
        tokensPerMinute: 1000,
        tokensPerDay: 10000,
        tokensPerMonth: 100000,
      };
      await limiter.admitRequest(apiKey.id, limits, 0);
      await limiter.recordTokens(apiKey.id, 40);
      expect(await limiter.usage(apiKey.id)).toMatchObject({
        requestsThisMinute: 1,
        tokensThisMinute: 40,
      });

      const usageBefore = await dataSource.getRepository(UsageRecord).find({ where: { apiKeyId: apiKey.id } });
      const creditsBefore = await dataSource.getRepository(CreditTransaction).find({
        where: { apiKeyId: apiKey.id },
      });

      await authed("post", `/admin/api-keys/${apiKey.id}/reset-counters`).expect(204);

      expect(await limiter.usage(apiKey.id)).toEqual({
        requestsThisMinute: 0,
        requestsToday: 0,
        tokensThisMinute: 0,
        tokensToday: 0,
        tokensThisMonth: 0,
      });

      const usageAfter = await dataSource.getRepository(UsageRecord).find({ where: { apiKeyId: apiKey.id } });
      const creditsAfter = await dataSource.getRepository(CreditTransaction).find({
        where: { apiKeyId: apiKey.id },
      });
      expect(usageAfter.map((row) => ({ id: row.id, inputTokens: row.inputTokens, outputTokens: row.outputTokens }))).toEqual(
        usageBefore.map((row) => ({ id: row.id, inputTokens: row.inputTokens, outputTokens: row.outputTokens })),
      );
      expect(creditsAfter.map((row) => ({ id: row.id, amount: row.amount, type: row.type }))).toEqual(
        creditsBefore.map((row) => ({ id: row.id, amount: row.amount, type: row.type })),
      );

      const audits = await dataSource.getRepository(AuditLog).find({
        where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_COUNTERS_RESET, entityId: apiKey.id },
      });
      expect(audits).toHaveLength(1);
    });
  });

  describe("delete", () => {
    it("deletes a key with no usage or credit history", async () => {
      const { apiKey, rawKey } = await createKey({ name: "Disposable" });
      const detail = await authed("get", `/admin/api-keys/${apiKey.id}`).expect(200);
      expect(detail.body.deletable).toBe(true);

      await authed("delete", `/admin/api-keys/${apiKey.id}`).expect(204);
      await authed("get", `/admin/api-keys/${apiKey.id}`).expect(404);

      const audits = await dataSource.getRepository(AuditLog).find({
        where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_DELETED, entityId: apiKey.id },
      });
      expect(audits).toHaveLength(1);
      const blob = JSON.stringify(audits[0]);
      expect(blob).not.toContain(rawKey);
      expect(blob).not.toContain(hashApiKey(rawKey));
      expect(blob).not.toContain("keyHash");
      expect(audits[0]?.before).toMatchObject({ id: apiKey.id, keyPrefix: rawKey.slice(0, 12) });
    });

    it("refuses a key with credit history", async () => {
      const { apiKey } = await createKey({ name: "Funded", initialCredit: "1.00" });
      const detail = await authed("get", `/admin/api-keys/${apiKey.id}`).expect(200);
      expect(detail.body.deletable).toBe(false);

      const res = await authed("delete", `/admin/api-keys/${apiKey.id}`).expect(409);
      expect(res.body.message).toBe(DELETE_CONFLICT);
      await authed("get", `/admin/api-keys/${apiKey.id}`).expect(200);
      expect(
        await dataSource.getRepository(AuditLog).count({
          where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_DELETED },
        }),
      ).toBe(0);
    });

    it("refuses a key with usage history", async () => {
      const { apiKey } = await createKey({ name: "Used" });
      await insertUsage(apiKey.id, "usage-blocks-delete", new Date(), "1", "1");

      const res = await authed("delete", `/admin/api-keys/${apiKey.id}`).expect(409);
      expect(res.body.message).toBe(DELETE_CONFLICT);
      await authed("get", `/admin/api-keys/${apiKey.id}`).expect(200);
    });
  });

  describe("list aggregates", () => {
    it("adds today's request count and this month's tokens for the page in one pass", async () => {
      const now = new Date();
      const dayStart = startOfUtcDay(now);
      const monthStart = startOfUtcMonth(now);
      const todayStamp = new Date(dayStart.getTime() + 60_000);
      const earlierThisMonth = new Date(monthStart.getTime() + 60_000);
      const previousMonth = new Date(monthStart.getTime() - 60_000);

      const keyA = await createKey({ name: "Aggregated", initialCredit: "2.50" });
      const keyB = await createKey({ name: "Quiet" });
      const keyC = await createKey({ name: "Other" });

      await insertUsage(keyA.apiKey.id, "a-today", todayStamp, "100", "25");
      await insertUsage(keyA.apiKey.id, "a-today-empty", new Date(todayStamp.getTime() + 60_000), null, null);
      await insertUsage(keyA.apiKey.id, "a-earlier", earlierThisMonth, "1000", "2000");
      await insertUsage(keyA.apiKey.id, "a-previous", previousMonth, "7", "8");
      await insertUsage(keyC.apiKey.id, "c-today", todayStamp, "50", "50");

      const list = await authed("get", "/admin/api-keys").expect(200);
      const rows = list.body.apiKeys as Array<{
        id: string;
        requestsToday: number;
        tokensThisMonth: string;
        credit: { remaining: string; consumed: string };
      }>;
      const byId = new Map(rows.map((row) => [row.id, row]));

      const earlierCountsToday = earlierThisMonth.getTime() >= dayStart.getTime();
      const aggregated = byId.get(keyA.apiKey.id);
      expect(aggregated?.requestsToday).toBe(2 + (earlierCountsToday ? 1 : 0));
      expect(aggregated?.tokensThisMonth).toBe("3125");
      expect(aggregated?.credit.remaining).toBe("2.500000");
      expect(aggregated?.credit.consumed).toBe("0");

      expect(byId.get(keyB.apiKey.id)).toMatchObject({
        requestsToday: 0,
        tokensThisMonth: "0",
        credit: { remaining: "0", consumed: "0" },
      });
      expect(byId.get(keyC.apiKey.id)).toMatchObject({
        requestsToday: 1,
        tokensThisMonth: "100",
      });
    });
  });

  describe("limits usage", () => {
    it("returns configured limits next to the live counters", async () => {
      const { apiKey } = await createKey({
        name: "Limited",
        requestsPerMinute: 9,
        requestsPerDay: 80,
        tokensPerMinute: 1000,
        tokensPerDay: 5000,
        tokensPerMonth: 9000,
        maxConcurrentRequests: 3,
      });

      const limiter = app.get(RequestLimiter);
      await limiter.admitRequest(
        apiKey.id,
        {
          requestsPerMinute: 9,
          requestsPerDay: 80,
          tokensPerMinute: 1000,
          tokensPerDay: 5000,
          tokensPerMonth: 9000,
        },
        0,
      );
      await limiter.recordTokens(apiKey.id, 40);

      const res = await authed("get", `/admin/api-keys/${apiKey.id}/limits-usage`).expect(200);
      expect(res.body).toEqual({
        limits: {
          requestsPerMinute: 9,
          requestsPerDay: 80,
          tokensPerMinute: 1000,
          tokensPerDay: 5000,
          tokensPerMonth: 9000,
          maxConcurrentRequests: 3,
        },
        usage: {
          requestsThisMinute: 1,
          requestsToday: 1,
          tokensThisMinute: 40,
          tokensToday: 40,
          tokensThisMonth: 40,
        },
      });
    });
  });
});
