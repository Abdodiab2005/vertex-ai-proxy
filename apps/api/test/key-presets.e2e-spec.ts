import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import { AdminUser, ApiKey, AuditLog, CreditTransaction, KeyPreset } from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { ADMIN_AUDIT_ACTIONS, CreditTransactionType } from "@gateway/contracts";
import { CreditLedgerService } from "../src/credits/credit-ledger.service.js";
import { toMicros } from "../src/credits/money.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Key presets and bulk keys (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await dataSource.query(`DROP TRIGGER IF EXISTS e2e_fail_mid_bulk ON api_keys`);
    await dataSource.query(`DROP FUNCTION IF EXISTS e2e_fail_mid_bulk()`);
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(`DROP TRIGGER IF EXISTS e2e_fail_mid_bulk ON api_keys`);
    await dataSource.query(`DROP FUNCTION IF EXISTS e2e_fail_mid_bulk()`);
    await resetE2eState(app);

    const hasher = app.get(PasswordHasher);
    await dataSource.getRepository(AdminUser).save({
      email: "admin@example.com",
      passwordHash: await hasher.hash("password"),
      enabled: true,
    });

    const res = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .send({ email: "admin@example.com", password: "password" })
      .expect(200);

    sessionHeader = cookieHeaderValue(sessionCookie(res));
    csrfToken = res.body.csrfToken;
  });

  function authed(method: "get" | "post" | "put" | "patch" | "delete", path: string) {
    const req = request(app.getHttpServer())[method](path).set("Cookie", sessionHeader);
    if (method !== "get") {
      req.set("x-csrf-token", csrfToken);
    }
    return req;
  }

  describe("session and CSRF", () => {
    it("requires a session", async () => {
      await request(app.getHttpServer()).get("/admin/key-presets").expect(401);
      await request(app.getHttpServer()).post("/admin/key-presets").send({ name: "Play" }).expect(401);
      await request(app.getHttpServer())
        .post("/admin/api-keys/bulk")
        .send({ namePrefix: "play", quantity: 1 })
        .expect(401);
    });

    it("requires a CSRF token for mutations", async () => {
      await request(app.getHttpServer())
        .post("/admin/key-presets")
        .set("Cookie", sessionHeader)
        .send({ name: "Play" })
        .expect(403);

      const created = await authed("post", "/admin/key-presets").send({ name: "Play" }).expect(201);

      await request(app.getHttpServer())
        .patch(`/admin/key-presets/${created.body.preset.id}`)
        .set("Cookie", sessionHeader)
        .send({ description: "updated" })
        .expect(403);

      await request(app.getHttpServer())
        .delete(`/admin/key-presets/${created.body.preset.id}`)
        .set("Cookie", sessionHeader)
        .expect(403);

      await request(app.getHttpServer())
        .post("/admin/api-keys/bulk")
        .set("Cookie", sessionHeader)
        .send({ namePrefix: "play", quantity: 1 })
        .expect(403);
    });
  });

  describe("preset CRUD", () => {
    it("creates, lists, updates, and deletes a preset and audits each change", async () => {
      const created = await authed("post", "/admin/key-presets")
        .send({
          name: "Play testers",
          description: "Closed testing",
          allowedModels: ["gemini-2.5-flash"],
          requestsPerMinute: 30,
          initialCredit: "12.5",
          lifetimeDays: 7,
          tags: ["play"],
        })
        .expect(201);

      expect(created.body.preset.name).toBe("Play testers");
      expect(created.body.preset.requestsPerMinute).toBe(30);
      expect(toMicros(created.body.preset.initialCredit)).toBe(toMicros("12.5"));
      expect(created.body.preset.lifetimeDays).toBe(7);
      expect(created.body.preset.allowedModels).toEqual(["gemini-2.5-flash"]);
      expect(typeof created.body.preset.createdAt).toBe("string");

      const listed = await authed("get", "/admin/key-presets").expect(200);
      expect(listed.body.presets.map((preset: { id: string }) => preset.id)).toEqual([
        created.body.preset.id,
      ]);

      const fetched = await authed("get", `/admin/key-presets/${created.body.preset.id}`).expect(200);
      expect(fetched.body.preset.tags).toEqual(["play"]);

      const updated = await authed("patch", `/admin/key-presets/${created.body.preset.id}`)
        .send({ name: "Play testers renamed", requestsPerMinute: null })
        .expect(200);
      expect(updated.body.preset.name).toBe("Play testers renamed");
      expect(updated.body.preset.requestsPerMinute).toBeNull();
      expect(updated.body.preset.allowedModels).toEqual(["gemini-2.5-flash"]);

      await authed("post", "/admin/key-presets").send({ name: "Play testers renamed" }).expect(409);

      await authed("delete", `/admin/key-presets/${created.body.preset.id}`).expect(204);
      await authed("get", `/admin/key-presets/${created.body.preset.id}`).expect(404);
      await authed("get", "/admin/key-presets/not-a-uuid").expect(404);

      const audits = await dataSource.getRepository(AuditLog).find({
        where: { entityType: "key_preset" },
        order: { createdAt: "ASC" },
      });
      expect(audits.map((audit) => audit.action)).toEqual([
        ADMIN_AUDIT_ACTIONS.KEY_PRESET_CREATED,
        ADMIN_AUDIT_ACTIONS.KEY_PRESET_UPDATED,
        ADMIN_AUDIT_ACTIONS.KEY_PRESET_DELETED,
      ]);
      expect(audits[0]?.entityId).toBe(created.body.preset.id);
      expect(audits[1]?.before).toMatchObject({ name: "Play testers", requestsPerMinute: 30 });
      expect(audits[1]?.after).toMatchObject({ name: "Play testers renamed", requestsPerMinute: null });
      expect(audits[2]?.before).toMatchObject({ name: "Play testers renamed" });
      expect(await dataSource.getRepository(KeyPreset).count()).toBe(0);
    });

    it("rejects invalid preset bodies", async () => {
      const emptyName = await authed("post", "/admin/key-presets").send({ name: "" }).expect(400);
      expect(emptyName.body.message[0]).toContain("name");

      const extra = await authed("post", "/admin/key-presets")
        .send({ name: "Play", nope: true })
        .expect(400);
      expect(JSON.stringify(extra.body.message)).toContain("nope");

      await authed("post", "/admin/key-presets")
        .send({ name: "Play", requestsPerMinute: 0 })
        .expect(400);
      await authed("post", "/admin/key-presets")
        .send({ name: "Play", allowedModels: ["bad model"] })
        .expect(400);
      await authed("post", "/admin/key-presets")
        .send({ name: "Play", initialCredit: "-1" })
        .expect(400);
      await authed("post", "/admin/key-presets")
        .send({ name: "Play", lifetimeDays: 0 })
        .expect(400);

      const created = await authed("post", "/admin/key-presets").send({ name: "Play" }).expect(201);
      await authed("patch", `/admin/key-presets/${created.body.preset.id}`)
        .send({ name: "Play", evil: true })
        .expect(400);
      expect(await dataSource.getRepository(KeyPreset).count()).toBe(1);
    });
  });

  describe("bulk generation", () => {
    it("creates 12 independent keys from a preset, with raw keys only in the response", async () => {
      await authed("put", "/admin/settings")
        .send({
          "keys.defaultRequestsPerMinute": 99,
          "keys.defaultRequestsPerDay": 500,
          "keys.defaultMaxConcurrentRequests": 9,
          "keys.defaultAllowedModels": ["gemini-2.5-pro"],
          "keys.defaultLifetimeDays": 30,
          "keys.defaultInitialCredit": "1.5",
        })
        .expect(200);

      const preset = await authed("post", "/admin/key-presets")
        .send({
          name: "Play testers",
          description: "Closed testing",
          allowedModels: ["gemini-2.5-flash"],
          blockedModels: ["gemini-2.0-flash"],
          allowedEndpoints: ["generateContent"],
          requestsPerMinute: 30,
          requestsPerDay: 100,
          tokensPerMinute: 1000,
          tokensPerDay: null,
          tokensPerMonth: 50000,
          maxConcurrentRequests: 2,
          initialCredit: "12.5",
          lifetimeDays: 7,
          tags: ["play"],
        })
        .expect(201);

      const before = Date.now();
      const bulk = await authed("post", "/admin/api-keys/bulk")
        .send({
          presetId: preset.body.preset.id,
          namePrefix: "  play  ",
          quantity: 12,
          overrides: { requestsPerMinute: 4 },
        })
        .expect(201);
      const after = Date.now();

      const keys = bulk.body.keys as Array<{
        apiKey: {
          id: string;
          name: string;
          description: string | null;
          allowedModels: string[];
          blockedModels: string[];
          allowedEndpoints: string[];
          requestsPerMinute: number | null;
          requestsPerDay: number | null;
          tokensPerMinute: number | null;
          tokensPerDay: number | null;
          tokensPerMonth: number | null;
          maxConcurrentRequests: number | null;
          tags: string[];
          expiresAt: string | null;
          metadata: unknown;
        };
        rawKey: string;
      }>;

      expect(keys).toHaveLength(12);
      expect(keys.map((entry) => entry.apiKey.name)).toEqual(
        Array.from({ length: 12 }, (_, index) => `play ${String(index + 1).padStart(2, "0")}`),
      );
      expect(new Set(keys.map((entry) => entry.rawKey)).size).toBe(12);
      expect(new Set(keys.map((entry) => entry.apiKey.id)).size).toBe(12);

      for (const entry of keys) {
        expect(entry.rawKey).toMatch(/^lvg_[A-Za-z0-9]{32}$/);
        expect(entry.apiKey.description).toBe("Closed testing");
        expect(entry.apiKey.allowedModels).toEqual(["gemini-2.5-flash"]);
        expect(entry.apiKey.blockedModels).toEqual(["gemini-2.0-flash"]);
        expect(entry.apiKey.allowedEndpoints).toEqual(["generateContent"]);
        expect(entry.apiKey.requestsPerMinute).toBe(4);
        expect(entry.apiKey.requestsPerDay).toBe(100);
        expect(entry.apiKey.tokensPerMinute).toBe(1000);
        expect(entry.apiKey.tokensPerDay).toBeNull();
        expect(entry.apiKey.tokensPerMonth).toBe(50000);
        expect(entry.apiKey.maxConcurrentRequests).toBe(2);
        expect(entry.apiKey.tags).toEqual(["play"]);
        expect(entry.apiKey.metadata).toBeNull();
        const expires = new Date(entry.apiKey.expiresAt ?? "").getTime();
        expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
        expect(expires).toBeLessThanOrEqual(after + 7 * DAY_MS);
      }
      expect(new Set(keys.map((entry) => entry.apiKey.expiresAt)).size).toBe(1);

      const lines = String(bulk.body.csv)
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      expect(lines[0]).toBe("name,key,credit,expiresAt");
      expect(lines).toHaveLength(13);
      expect(lines[1]).toContain("play 01");
      expect(lines[1]).toContain(keys[0]?.rawKey);
      expect(lines[12]).toContain("play 12");
      expect(toMicros(lines[1]?.split(",")[2] ?? "")).toBe(toMicros("12.5"));
      expect(lines[1]).toContain(keys[0]?.apiKey.expiresAt);

      for (const entry of keys) {
        const row = await dataSource.getRepository(ApiKey).findOneByOrFail({ id: entry.apiKey.id });
        expect(row.keyHash).toMatch(/^[a-f0-9]{64}$/);
        expect(row.keyHash).not.toBe(entry.rawKey);
        expect(JSON.stringify(row)).not.toContain(entry.rawKey);

        const credits = await dataSource.getRepository(CreditTransaction).find({
          where: { apiKeyId: entry.apiKey.id },
        });
        expect(credits).toHaveLength(1);
        expect(credits[0]?.type).toBe(CreditTransactionType.CREDIT_ADDED);
        expect(toMicros(credits[0]?.amount ?? "0")).toBe(toMicros("12.5"));

        const fetched = await authed("get", `/admin/api-keys/${entry.apiKey.id}`).expect(200);
        expect(JSON.stringify(fetched.body)).not.toContain(entry.rawKey);
      }

      const list = await authed("get", "/admin/api-keys?limit=200").expect(200);
      const listed = JSON.stringify(list.body);
      for (const entry of keys) {
        expect(listed).not.toContain(entry.rawKey);
      }

      const audits = await dataSource.getRepository(AuditLog).find({
        where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_BULK_CREATED },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.after).toEqual({
        count: 12,
        presetId: preset.body.preset.id,
        namePrefix: "play",
        keyIds: keys.map((entry) => entry.apiKey.id),
      });
      const auditBlob = JSON.stringify(await dataSource.getRepository(AuditLog).find());
      for (const entry of keys) {
        expect(auditBlob).not.toContain(entry.rawKey);
      }

      const ledger = app.get(CreditLedgerService);
      const targetId = keys[0]?.apiKey.id ?? "";
      await dataSource.transaction(async (manager) => {
        await ledger.append(
          {
            apiKeyId: targetId,
            type: CreditTransactionType.COST_CONSUMED,
            amount: "-1.000000",
            description: "e2e debit",
          },
          manager,
        );
      });

      const debited = await ledger.summary(targetId, dataSource.manager);
      expect(toMicros(debited.remaining)).toBe(toMicros("12.5") - toMicros("1"));
      for (const entry of keys.slice(1)) {
        const summary = await ledger.summary(entry.apiKey.id, dataSource.manager);
        expect(toMicros(summary.remaining)).toBe(toMicros("12.5"));
      }
    });

    it("applies settings defaults when no preset is selected", async () => {
      await authed("put", "/admin/settings")
        .send({
          "keys.defaultRequestsPerMinute": 15,
          "keys.defaultAllowedModels": ["gemini-2.5-flash"],
          "keys.defaultLifetimeDays": 14,
          "keys.defaultInitialCredit": "3.25",
        })
        .expect(200);

      const before = Date.now();
      const bulk = await authed("post", "/admin/api-keys/bulk")
        .send({ namePrefix: "defaulted", quantity: 1 })
        .expect(201);
      const after = Date.now();

      const apiKey = bulk.body.keys[0].apiKey;
      expect(apiKey.name).toBe("defaulted 01");
      expect(apiKey.requestsPerMinute).toBe(15);
      expect(apiKey.allowedModels).toEqual(["gemini-2.5-flash"]);
      const expires = new Date(apiKey.expiresAt).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 14 * DAY_MS);
      expect(expires).toBeLessThanOrEqual(after + 14 * DAY_MS);

      const credits = await dataSource.getRepository(CreditTransaction).find({
        where: { apiKeyId: apiKey.id },
      });
      expect(credits).toHaveLength(1);
      expect(toMicros(credits[0]?.amount ?? "0")).toBe(toMicros("3.25"));
    });

    it("stores each tester on the matching key", async () => {
      const bulk = await authed("post", "/admin/api-keys/bulk")
        .send({
          namePrefix: "tester",
          quantity: 2,
          testers: [
            {
              testerName: "Ada",
              email: "ada@example.com",
              googlePlayTesterNumber: "1",
              notes: "first",
            },
            { email: "bea@example.com" },
          ],
        })
        .expect(201);

      const first = await dataSource.getRepository(ApiKey).findOneByOrFail({
        id: bulk.body.keys[0].apiKey.id,
      });
      const second = await dataSource.getRepository(ApiKey).findOneByOrFail({
        id: bulk.body.keys[1].apiKey.id,
      });
      expect(first.metadata).toEqual({
        testerName: "Ada",
        email: "ada@example.com",
        googlePlayTesterNumber: "1",
        notes: "first",
      });
      expect(second.metadata).toEqual({ email: "bea@example.com" });
      expect(first.name).toBe("tester 01");
      expect(second.name).toBe("tester 02");
    });

    it("rejects a quantity out of range or a testers length mismatch before writing keys", async () => {
      await authed("post", "/admin/api-keys/bulk")
        .send({ namePrefix: "play", quantity: 0 })
        .expect(400);
      await authed("post", "/admin/api-keys/bulk")
        .send({ namePrefix: "play", quantity: 201 })
        .expect(400);
      const mismatch = await authed("post", "/admin/api-keys/bulk")
        .send({
          namePrefix: "play",
          quantity: 2,
          testers: [{ testerName: "Ada" }],
        })
        .expect(400);
      expect(JSON.stringify(mismatch.body.message)).toContain("testers");
      expect(await dataSource.getRepository(ApiKey).count()).toBe(0);
    });

    it("rejects an invalid override model and writes nothing", async () => {
      await authed("post", "/admin/api-keys/bulk")
        .send({
          namePrefix: "play",
          quantity: 4,
          overrides: { allowedModels: ["bad model"] },
        })
        .expect(400);
      expect(await dataSource.getRepository(ApiKey).count()).toBe(0);
      expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
      expect(
        await dataSource.getRepository(AuditLog).count({
          where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_BULK_CREATED },
        }),
      ).toBe(0);
    });

    it("rolls back every key and credit row when an insert fails mid-batch", async () => {
      const preset = await authed("post", "/admin/key-presets")
        .send({ name: "Atomic", initialCredit: "5" })
        .expect(201);

      await dataSource.query(`
        CREATE FUNCTION e2e_fail_mid_bulk() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF (SELECT COUNT(*) FROM api_keys) >= 3 THEN
            RAISE EXCEPTION 'e2e forced mid-bulk failure';
          END IF;
          RETURN NEW;
        END;
        $fn$
      `);
      await dataSource.query(`
        CREATE TRIGGER e2e_fail_mid_bulk
        BEFORE INSERT ON api_keys
        FOR EACH ROW EXECUTE FUNCTION e2e_fail_mid_bulk()
      `);

      try {
        await authed("post", "/admin/api-keys/bulk")
          .send({ presetId: preset.body.preset.id, namePrefix: "atomic", quantity: 12 })
          .expect(500);

        expect(await dataSource.getRepository(ApiKey).count()).toBe(0);
        expect(await dataSource.getRepository(CreditTransaction).count()).toBe(0);
        expect(await dataSource.getRepository(KeyPreset).count()).toBe(1);
        expect(
          await dataSource.getRepository(AuditLog).count({
            where: { action: ADMIN_AUDIT_ACTIONS.API_KEY_BULK_CREATED },
          }),
        ).toBe(0);
      } finally {
        await dataSource.query(`DROP TRIGGER IF EXISTS e2e_fail_mid_bulk ON api_keys`);
        await dataSource.query(`DROP FUNCTION IF EXISTS e2e_fail_mid_bulk()`);
      }
    });
  });
});
