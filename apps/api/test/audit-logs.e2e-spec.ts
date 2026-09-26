import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import { AdminUser, AuditLog } from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";

describe("AuditLogs (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;
  let adminUserId: string;

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

    const adminRepo = dataSource.getRepository(AdminUser);
    const admin = await adminRepo.save({
      email: "admin@example.com",
      passwordHash: pass,
      enabled: true,
    });
    adminUserId = admin.id;

    const res = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .send({ email: "admin@example.com", password: "password" });

    sessionHeader = cookieHeaderValue(sessionCookie(res));
    csrfToken = res.body.csrfToken;
  });

  async function createKey(payload: Record<string, unknown> = { name: "Test Key" }) {
    const res = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", sessionHeader)
      .set("x-csrf-token", csrfToken)
      .send(payload)
      .expect(201);
    return res.body;
  }

  async function suspendKey(id: string) {
    return request(app.getHttpServer())
      .post(`/admin/api-keys/${id}/suspend`)
      .set("Cookie", sessionHeader)
      .set("x-csrf-token", csrfToken)
      .expect(201);
  }

  async function listAuditLogs(params: Record<string, string> = {}) {
    const searchParams = new URLSearchParams(params);
    return request(app.getHttpServer())
      .get(`/admin/audit-logs?${searchParams.toString()}`)
      .set("Cookie", sessionHeader)
      .expect(200);
  }

  describe("Authentication", () => {
    it("requires admin session", async () => {
      await request(app.getHttpServer())
        .get("/admin/audit-logs")
        .expect(401);
    });

    it("requires admin session for actions endpoint", async () => {
      await request(app.getHttpServer())
        .get("/admin/audit-logs/actions")
        .expect(401);
    });
  });

  describe("GET /admin/audit-logs/actions", () => {
    it("returns distinct actions from audit logs", async () => {
      await createKey({ name: "Key 1" });
      await createKey({ name: "Key 2" });

      const res = await request(app.getHttpServer())
        .get("/admin/audit-logs/actions")
        .set("Cookie", sessionHeader)
        .expect(200);

      expect(res.body.actions).toEqual(
        expect.arrayContaining([ADMIN_AUDIT_ACTIONS.API_KEY_CREATED]),
      );
    });

    it("includes login action from the initial login", async () => {
      const res = await request(app.getHttpServer())
        .get("/admin/audit-logs/actions")
        .set("Cookie", sessionHeader)
        .expect(200);

      expect(res.body.actions).toEqual(
        expect.arrayContaining([ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED]),
      );
    });
  });

  describe("GET /admin/audit-logs - default order and limit", () => {
    it("returns entries ordered by createdAt DESC, id DESC with default limit 50", async () => {
      // Create multiple keys to generate audit logs (5 creates = 5 entries + 1 login = 6)
      for (let i = 0; i < 5; i++) {
        await createKey({ name: `Key ${i}` });
      }

      const res = await listAuditLogs({});
      expect(res.body.entries).toHaveLength(6); // 5 creates + 1 login
      expect(res.body.nextCursor).toBeNull();

      // Check order: newest first
      for (let i = 0; i < res.body.entries.length - 1; i++) {
        const current = new Date(res.body.entries[i].createdAt).getTime();
        const next = new Date(res.body.entries[i + 1].createdAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
        if (current === next) {
          // If timestamps are equal, id should be descending
          expect(res.body.entries[i].id).toBeGreaterThan(res.body.entries[i + 1].id);
        }
      }
    });

    it("limits results to 50 by default", async () => {
      for (let i = 0; i < 55; i++) {
        await createKey({ name: `Key ${i}` });
      }

      const res = await listAuditLogs({});
      expect(res.body.entries).toHaveLength(50);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it("respects custom limit", async () => {
      for (let i = 0; i < 10; i++) {
        await createKey({ name: `Key ${i}` });
      }

      const res = await listAuditLogs({ limit: "3" });
      expect(res.body.entries).toHaveLength(3);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it("rejects limit > 200", async () => {
      await request(app.getHttpServer())
        .get("/admin/audit-logs?limit=201")
        .set("Cookie", sessionHeader)
        .expect(400);
    });

    it("rejects limit < 1", async () => {
      await request(app.getHttpServer())
        .get("/admin/audit-logs?limit=0")
        .set("Cookie", sessionHeader)
        .expect(400);
    });
  });

  describe("GET /admin/audit-logs - filters", () => {
    let key1Id: string;

    beforeEach(async () => {
      const key1 = await createKey({ name: "Key One" });
      key1Id = key1.apiKey.id;
      await suspendKey(key1Id);

      await createKey({ name: "Key Two" });
    });

    it("filters by action", async () => {
      const res = await listAuditLogs({ action: ADMIN_AUDIT_ACTIONS.API_KEY_SUSPENDED });
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].action).toBe(ADMIN_AUDIT_ACTIONS.API_KEY_SUSPENDED);
      expect(res.body.entries[0].entityId).toBe(key1Id);
    });

    it("filters by entityType", async () => {
      const res = await listAuditLogs({ entityType: "api_key" });
      // created + suspended + created = 3 api_key entries (login has entityType = null)
      expect(res.body.entries.length).toBeGreaterThanOrEqual(3);
      for (const entry of res.body.entries) {
        expect(entry.entityType).toBe("api_key");
      }
    });

    it("filters by entityId", async () => {
      const res = await listAuditLogs({ entityId: key1Id });
      for (const entry of res.body.entries) {
        expect(entry.entityId).toBe(key1Id);
      }
    });

    it("filters by adminUserId", async () => {
      const res = await listAuditLogs({ adminUserId: adminUserId });
      for (const entry of res.body.entries) {
        expect(entry.adminUserId).toBe(adminUserId);
      }
    });

    it("filters by from (inclusive)", async () => {
      const beforeCreation = new Date(Date.now() - 1000).toISOString();
      const res = await listAuditLogs({ from: beforeCreation });
      expect(res.body.entries.length).toBeGreaterThanOrEqual(4);
    });

    it("filters by to (exclusive)", async () => {
      const beforeCreation = new Date(Date.now() - 1000).toISOString();
      const res = await listAuditLogs({ to: beforeCreation });
      expect(res.body.entries).toHaveLength(0);
    });

    it("combines from and to range", async () => {
      const now = new Date();
      const from = new Date(now.getTime() - 5000).toISOString();
      const to = new Date(now.getTime() + 5000).toISOString();
      const res = await listAuditLogs({ from, to });
      expect(res.body.entries.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("GET /admin/audit-logs - cursor pagination", () => {
    it("walks every row exactly once with cursor pagination", async () => {
      // Create 15 keys to have more than one page with limit=5
      // 15 creates + 1 login = 16 entries
      for (let i = 0; i < 15; i++) {
        await createKey({ name: `Key ${i}` });
      }

      const allEntries: Array<{ id: string; createdAt: string }> = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const params: Record<string, string> = { limit: "5" };
        if (cursor) params.before = cursor;
        const res = await listAuditLogs(params);
        expect(res.body.entries.length).toBeLessThanOrEqual(5);

        for (const entry of res.body.entries) {
          allEntries.push({ id: entry.id, createdAt: entry.createdAt });
        }
        cursor = res.body.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10); // Safety limit

      // Should have exactly 16 unique entries (15 creates + 1 login)
      expect(allEntries).toHaveLength(16);
      const uniqueIds = new Set(allEntries.map((e) => e.id));
      expect(uniqueIds.size).toBe(16);

      // Verify ordering is maintained across pages
      for (let i = 0; i < allEntries.length - 1; i++) {
        const current = new Date(allEntries[i].createdAt).getTime();
        const next = new Date(allEntries[i + 1].createdAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
        if (current === next) {
          // When timestamps are equal, IDs should be in descending order (lexicographic for UUIDs)
          expect(allEntries[i].id > allEntries[i + 1].id).toBe(true);
        }
      }
    });

    it("returns 400 for invalid cursor", async () => {
      await request(app.getHttpServer())
        .get("/admin/audit-logs?before=invalid-cursor")
        .set("Cookie", sessionHeader)
        .expect(400);
    });

    it("returns 400 for cursor with invalid date", async () => {
      const badCursor = Buffer.from("not-a-date|a1b2c3d4-e5f6-7890-abcd-ef1234567890", "utf8").toString("base64url");
      await request(app.getHttpServer())
        .get(`/admin/audit-logs?before=${badCursor}`)
        .set("Cookie", sessionHeader)
        .expect(400);
    });

    it("returns 400 for cursor with invalid UUID", async () => {
      const badCursor = Buffer.from("2024-01-15T10:30:00.000Z|not-a-uuid", "utf8").toString("base64url");
      await request(app.getHttpServer())
        .get(`/admin/audit-logs?before=${badCursor}`)
        .set("Cookie", sessionHeader)
        .expect(400);
    });
  });

  describe("GET /admin/audit-logs - adminEmail join", () => {
    it("includes adminEmail when admin user exists", async () => {
      await createKey({ name: "Test Key" });

      const res = await listAuditLogs({});
      expect(res.body.entries[0].adminEmail).toBe("admin@example.com");
    });

    it("includes null adminEmail when admin was deleted", async () => {
      await createKey({ name: "Test Key" });

      // Create a second admin to query with
      const hasher = app.get(PasswordHasher);
      const pass2 = await hasher.hash("password");
      const adminRepo = dataSource.getRepository(AdminUser);
      await adminRepo.save({
        email: "admin2@example.com",
        passwordHash: pass2,
        enabled: true,
      });

      // Login as second admin
      const res2 = await request(app.getHttpServer())
        .post("/admin/auth/login")
        .send({ email: "admin2@example.com", password: "password" });
      const sessionHeader2 = cookieHeaderValue(sessionCookie(res2));

      // Delete the first admin user
      await dataSource.getRepository(AdminUser).delete(adminUserId);

      // Query audit logs as second admin
      const searchParams = new URLSearchParams();
      const res = await request(app.getHttpServer())
        .get(`/admin/audit-logs?${searchParams.toString()}`)
        .set("Cookie", sessionHeader2)
        .expect(200);

      // The audit log from the first admin should now have null adminEmail
      const entry = res.body.entries.find(
        (e: { action: string; adminEmail: string | null }) => e.action === ADMIN_AUDIT_ACTIONS.API_KEY_CREATED,
      );
      expect(entry).toBeDefined();
      expect(entry.adminEmail).toBeNull();
    });

    it("includes null adminEmail when adminUserId is null", async () => {
      // Insert an audit log directly with null adminUserId
      await dataSource.getRepository(AuditLog).insert({
        action: "test.action",
        adminUserId: null,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: null,
        after: null,
      });

      const res = await listAuditLogs({ action: "test.action" });
      expect(res.body.entries[0].adminEmail).toBeNull();
      expect(res.body.entries[0].adminUserId).toBeNull();
    });
  });

  describe("GET /admin/audit-logs - redaction", () => {
    it("redacts secret-looking keys in after object", async () => {
      // Insert an audit row directly with a secret in after
      await dataSource.getRepository(AuditLog).insert({
        action: "test.redaction",
        adminUserId: adminUserId,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: null,
        after: { api_key: "sk-secret123", password: "pwd123", normalField: "keep" },
      });

      const res = await listAuditLogs({ action: "test.redaction" });
      expect(res.body.entries[0].after).toEqual({
        api_key: "[redacted]",
        password: "[redacted]",
        normalField: "keep",
      });
    });

    it("redacts secret-looking keys in before object", async () => {
      await dataSource.getRepository(AuditLog).insert({
        action: "test.redaction.before",
        adminUserId: adminUserId,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: { private_key: "key-data", token: "tok123", name: "test" },
        after: null,
      });

      const res = await listAuditLogs({ action: "test.redaction.before" });
      expect(res.body.entries[0].before).toEqual({
        private_key: "[redacted]",
        token: "[redacted]",
        name: "test",
      });
    });

    it("redacts nested secret keys", async () => {
      await dataSource.getRepository(AuditLog).insert({
        action: "test.redaction.nested",
        adminUserId: adminUserId,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: null,
        after: { config: { api_key: "nested-secret", timeout: 30 } },
      });

      const res = await listAuditLogs({ action: "test.redaction.nested" });
      expect(res.body.entries[0].after).toEqual({
        config: { api_key: "[redacted]", timeout: 30 },
      });
    });

    it("redacts secret keys in arrays", async () => {
      await dataSource.getRepository(AuditLog).insert({
        action: "test.redaction.array",
        adminUserId: adminUserId,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: null,
        after: { items: [{ password: "p1" }, { token: "t2", name: "keep" }] },
      });

      const res = await listAuditLogs({ action: "test.redaction.array" });
      expect(res.body.entries[0].after).toEqual({
        items: [{ password: "[redacted]" }, { token: "[redacted]", name: "keep" }],
      });
    });

    it("does not redact non-matching keys", async () => {
      await dataSource.getRepository(AuditLog).insert({
        action: "test.redaction.safe",
        adminUserId: adminUserId,
        entityType: "test",
        entityId: null,
        ipAddress: null,
        before: null,
        after: { name: "test", email: "a@b.com", count: 42, enabled: true },
      });

      const res = await listAuditLogs({ action: "test.redaction.safe" });
      expect(res.body.entries[0].after).toEqual({
        name: "test",
        email: "a@b.com",
        count: 42,
        enabled: true,
      });
    });
  });

  describe("Audit entry shape", () => {
    it("returns all required fields with correct types", async () => {
      await createKey({ name: "Test Key" });

      const res = await listAuditLogs({});
      const entry = res.body.entries[0];

      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof entry.action).toBe("string");
      expect(entry.adminUserId).toBe(adminUserId);
      expect(entry.adminEmail).toBe("admin@example.com");
      expect(entry.entityType).toBe("api_key");
      expect(entry.entityId).toMatch(/^[0-9a-f-]{36}$/);
      // IP address is captured in test environment (IPv6 localhost)
      expect(typeof entry.ipAddress).toBe("string");
      expect(entry.before).toBeNull();
      expect(typeof entry.after).toBe("object");
      expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});