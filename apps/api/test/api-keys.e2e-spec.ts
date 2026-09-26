import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import { AdminUser, ApiKey, AuditLog } from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { ADMIN_AUDIT_ACTIONS, ApiKeyStatus } from "@gateway/contracts";

describe("ApiKeys (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;

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
    await adminRepo.save({
      email: "admin@example.com",
      passwordHash: pass,
      enabled: true,
    });

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

  describe("Admin Auth & CSRF", () => {
    it("admin endpoints require auth", async () => {
      await request(app.getHttpServer())
        .post("/admin/api-keys")
        .send({ name: "Test" })
        .expect(401);
    });

    it("admin endpoints require csrf token for mutations", async () => {
      await request(app.getHttpServer())
        .post("/admin/api-keys")
        .set("Cookie", sessionHeader)
        .send({ name: "Test" })
        .expect(403);
    });
    
    it("suspend key requires CSRF", async () => {
      const { apiKey } = await createKey();
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .expect(403);
    });
  });

  describe("API Key Material & Storage", () => {
    it("raw key is not recoverable from database or audit logs", async () => {
      const { apiKey, rawKey } = await createKey();
      
      expect(rawKey).toMatch(/^lvg_[a-zA-Z0-9]{32}$/);
      
      const dbKey = await dataSource.getRepository(ApiKey).findOne({ where: { id: apiKey.id } });
      expect(dbKey!.keyHash).not.toBe(rawKey);
      expect(dbKey!.keyHash).toBeDefined();
      
      const audits = await dataSource.getRepository(AuditLog).find();
      const stringifiedAudits = JSON.stringify(audits);
      expect(stringifiedAudits).not.toContain(rawKey);
      expect(stringifiedAudits).not.toContain(dbKey!.keyHash);
    });
    
    it("400 from admin API showing zod issues", async () => {
      const badCreateRes = await request(app.getHttpServer())
        .post("/admin/api-keys")
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .send({ name: "" })
        .expect(400);
        
      expect(badCreateRes.body.message[0]).toContain("name");
    });
    
    it("audits exist for all mutations and never contain secrets", async () => {
      const { apiKey, rawKey } = await createKey();
      
      await request(app.getHttpServer())
        .patch(`/admin/api-keys/${apiKey.id}`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .send({ description: "test" })
        .expect(200);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/reactivate`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/revoke`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      const audits = await dataSource.getRepository(AuditLog).find({ 
        where: { entityType: "api_key" },
        order: { createdAt: "ASC" }
      });
      
      const actions = audits.map(a => a.action);
      expect(actions).toEqual([
        ADMIN_AUDIT_ACTIONS.API_KEY_CREATED,
        ADMIN_AUDIT_ACTIONS.API_KEY_UPDATED,
        ADMIN_AUDIT_ACTIONS.API_KEY_SUSPENDED,
        ADMIN_AUDIT_ACTIONS.API_KEY_REACTIVATED,
        ADMIN_AUDIT_ACTIONS.API_KEY_REVOKED,
      ]);
      
      const stringifiedAudits = JSON.stringify(audits);
      expect(stringifiedAudits).not.toContain(rawKey);
    });
  });

  describe("Authentication Mechanisms", () => {
    it("authenticates via x-goog-api-key", async () => {
      const { rawKey } = await createKey();
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(200);
    });
    
    it("authenticates via ?key=", async () => {
      const { rawKey } = await createKey();
      await request(app.getHttpServer())
        .get(`/v1beta/__e2e/models/gemini-pro?key=${rawKey}`)
        .expect(200);
    });
    
    it("header wins over a WRONG ?key=", async () => {
      const { rawKey } = await createKey();
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro?key=invalid_key")
        .set("x-goog-api-key", rawKey)
        .expect(200);
    });
    
    it("malformed key -> 401 with exact Gemini error shape", async () => {
      const invalidKeyRes = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", "invalid_key")
        .expect(401);
      
      expect(invalidKeyRes.body).toEqual({
        error: {
          code: 401,
          message: "API key not valid. Please pass a valid API key.",
          status: "UNAUTHENTICATED"
        }
      });
    });
    
    it("unknown well-formed key -> 401 with exact Gemini error shape", async () => {
      const invalidKeyRes = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", "lvg_12345678901234567890123456789012")
        .expect(401);
        
      expect(invalidKeyRes.body).toEqual({
        error: {
          code: 401,
          message: "API key not valid. Please pass a valid API key.",
          status: "UNAUTHENTICATED"
        }
      });
    });
  });

  describe("Access Rejection Statuses", () => {
    it("revoked key -> 403", async () => {
      const { apiKey, rawKey } = await createKey();
      
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/revoke`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("API key has been revoked.");
    });
    
    it("suspended key -> 403", async () => {
      const { apiKey, rawKey } = await createKey();
      
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("API key is suspended.");
    });
    
    it("expired key -> 403, and updates DB status", async () => {
      const { apiKey, rawKey } = await createKey({ name: "Test Key" });
      
      // Manually backdate in DB to simulate expiry
      await dataSource.getRepository(ApiKey).update(apiKey.id, {
        expiresAt: new Date(Date.now() - 10000)
      });
        
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("API key has expired.");
      
      const dbKey = await dataSource.getRepository(ApiKey).findOne({ where: { id: apiKey.id } });
      expect(dbKey!.status).toBe(ApiKeyStatus.EXPIRED);
    });
    
    it("credit_exhausted -> 429", async () => {
      const { apiKey, rawKey } = await createKey();
      
      // Set status directly in DB
      await dataSource.getRepository(ApiKey).update(apiKey.id, {
        status: ApiKeyStatus.CREDIT_EXHAUSTED
      });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(429);
        
      expect(res.body.error.message).toBe("API key credit has been exhausted.");
      expect(res.body.error.status).toBe("RESOURCE_EXHAUSTED");
    });
  });

  describe("Model Restrictions", () => {
    it("allowedModels only", async () => {
      const { rawKey } = await createKey({ name: "Test", allowedModels: ["gemini-pro"] });
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(200);
        
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-ultra")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("This API key is not allowed to use model gemini-ultra.");
    });
    
    it("blockedModels only", async () => {
      const { rawKey } = await createKey({ name: "Test", blockedModels: ["gemini-pro"] });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("This API key is not allowed to use model gemini-pro.");
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-ultra")
        .set("x-goog-api-key", rawKey)
        .expect(200);
    });
    
    it("same model in both (blocked wins)", async () => {
      const { rawKey } = await createKey({ 
        name: "Test", 
        allowedModels: ["gemini-pro"],
        blockedModels: ["gemini-pro"]
      });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toBe("This API key is not allowed to use model gemini-pro.");
    });
  });

  describe("IP Restrictions", () => {
    it("blockedIPs exact match -> 403", async () => {
      const { rawKey } = await createKey({ name: "Test", blockedIPs: ["198.51.100.1"] });
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .set("X-Forwarded-For", "198.51.100.1")
        .expect(403);
    });
    
    it("blockedIPs CIDR -> 403", async () => {
      const { rawKey } = await createKey({ name: "Test", blockedIPs: ["198.51.100.0/24"] });
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .set("X-Forwarded-For", "198.51.100.42")
        .expect(403);
        
      // Outside CIDR works
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .set("X-Forwarded-For", "198.51.200.1")
        .expect(200);
    });
    
    it("allowedIPs set and the client outside it -> 403", async () => {
      const { rawKey } = await createKey({ name: "Test", allowedIPs: ["198.51.100.0/24"] });
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .set("X-Forwarded-For", "198.51.200.1")
        .expect(403);
    });
    
    it("client inside an allowed CIDR -> 200", async () => {
      const { rawKey } = await createKey({ name: "Test", allowedIPs: ["198.51.100.0/24"] });
      
      await request(app.getHttpServer())
        .get("/v1beta/__e2e/models/gemini-pro")
        .set("x-goog-api-key", rawKey)
        .set("X-Forwarded-For", "198.51.100.42")
        .expect(200);
    });
  });

  describe("Admin List & Filters", () => {
    it("search matches name and prefix, including literal %", async () => {
      const { apiKey: key1 } = await createKey({ name: "UniqueName123" });
      const { apiKey: key2 } = await createKey({ name: "Contains%Symbol" });
      
      // Search by name
      let listRes = await request(app.getHttpServer())
        .get("/admin/api-keys?search=UniqueName")
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys).toHaveLength(1);
      expect(listRes.body.apiKeys[0].id).toBe(key1.id);
      
      // Search by prefix
      listRes = await request(app.getHttpServer())
        .get(`/admin/api-keys?search=${key1.keyPrefix}`)
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys).toHaveLength(1);
      
      // Search by literal %
      listRes = await request(app.getHttpServer())
        .get("/admin/api-keys?search=%25Symbol") // URL-encoded %
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys).toHaveLength(1);
      expect(listRes.body.apiKeys[0].id).toBe(key2.id);
    });
    
    it("filters by status (suspended, expired), handles limit/offset", async () => {
      const { apiKey: suspendedKey } = await createKey({ name: "Suspended Key" });
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${suspendedKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      const { apiKey: expiredKey } = await createKey({ name: "Expired Key" });
      await dataSource.getRepository(ApiKey).update(expiredKey.id, {
        expiresAt: new Date(Date.now() - 10000)
      });
      
      let listRes = await request(app.getHttpServer())
        .get("/admin/api-keys?status=suspended")
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys.some((k: Record<string, unknown>) => k.id === suspendedKey.id)).toBe(true);
      expect(listRes.body.apiKeys.some((k: Record<string, unknown>) => k.id === expiredKey.id)).toBe(false);
      
      listRes = await request(app.getHttpServer())
        .get("/admin/api-keys?status=expired")
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys.some((k: Record<string, unknown>) => k.id === expiredKey.id)).toBe(true);
      
      // Limit and offset
      listRes = await request(app.getHttpServer())
        .get("/admin/api-keys?limit=1&offset=0")
        .set("Cookie", sessionHeader)
        .expect(200);
      expect(listRes.body.apiKeys).toHaveLength(1);
      expect(listRes.body.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Admin Transitions & PATCH", () => {
    it("suspend -> reactivate -> revoke works", async () => {
      const { apiKey } = await createKey();
      
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/reactivate`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/revoke`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
    });
    
    it("reactivate after revoke -> 409", async () => {
      const { apiKey } = await createKey();
      
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/revoke`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/reactivate`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(409);
    });
    
    it("suspend of revoked key -> 409", async () => {
      const { apiKey } = await createKey();
      
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/revoke`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(201);
        
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${apiKey.id}/suspend`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .expect(409);
    });
    
    it("PATCH with expiresAt: null clears it", async () => {
      const { apiKey } = await createKey({ 
        name: "Expiring Key",
        expiresAt: new Date(Date.now() + 100000).toISOString()
      });
      
      expect(apiKey.expiresAt).not.toBeNull();
      
      const patchRes = await request(app.getHttpServer())
        .patch(`/admin/api-keys/${apiKey.id}`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .send({ expiresAt: null })
        .expect(200);
        
      expect(patchRes.body.apiKey.expiresAt).toBe(null);
    });
    
    it("PATCH with unknown field -> 400", async () => {
      const { apiKey } = await createKey();
      
      const badPatch = await request(app.getHttpServer())
        .patch(`/admin/api-keys/${apiKey.id}`)
        .set("Cookie", sessionHeader)
        .set("x-csrf-token", csrfToken)
        .send({ someUnknownField: "test" })
        .expect(400);
        
      expect(badPatch.body.message[0]).toContain("Unrecognized key");
    });
  });
});
