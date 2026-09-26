import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import { AdminUser, Model, ModelAlias, Upstream } from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";

describe("PublicModels (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
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
    
    await seedModels();
  });

  async function createKey(payload: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", sessionHeader)
      .set("x-csrf-token", csrfToken)
      .send({ name: "Test Key", ...payload })
      .expect(201);
    return res.body;
  }

  async function seedModels() {
    const upstreamRepo = dataSource.getRepository(Upstream);
    const u1 = await upstreamRepo.save({
      name: "google-main",
      projectId: "test-project",
      location: "global",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMethod: "api_key",
      authMethodOptions: { key: "foo" },
      enabled: true,
      description: "google upstream",
    });

    const uDisabled = await upstreamRepo.save({
      name: "google-disabled",
      projectId: "test-project",
      location: "global",
      provider: "google",
      baseUrl: "https://disabled.googleapis.com",
      authMethod: "api_key",
      authMethodOptions: { key: "foo" },
      enabled: false,
      description: "disabled upstream",
    });

    const modelRepo = dataSource.getRepository(Model);
    await modelRepo.save([
      { publicName: "model-a", displayName: "A", provider: "google", upstreamModelName: "models/a", upstreamId: u1.id, supportsText: true, supportsEmbeddings: false, inputTokenLimit: 10, outputTokenLimit: null, enabled: true, availabilityStatus: "available" },
      { publicName: "model-b", displayName: "B", provider: "google", upstreamModelName: "models/b", upstreamId: u1.id, supportsText: true, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: true, availabilityStatus: "available" },
      { publicName: "model-c", displayName: "C", provider: "google", upstreamModelName: "models/c", upstreamId: u1.id, supportsText: false, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: true, availabilityStatus: "available" },
      { publicName: "model-d", displayName: "D2", provider: "google", upstreamModelName: "models/d", upstreamId: u1.id, supportsText: true, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: true, availabilityStatus: "available" },
      { publicName: "model-disabled", displayName: "D", provider: "google", upstreamModelName: "models/d", upstreamId: u1.id, supportsText: true, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: false, availabilityStatus: "available" },
      { publicName: "model-unavailable", displayName: "U", provider: "google", upstreamModelName: "models/u", upstreamId: u1.id, supportsText: true, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: true, availabilityStatus: "unavailable" },
      { publicName: "model-upstream-disabled", displayName: "UD", provider: "google", upstreamModelName: "models/ud", upstreamId: uDisabled.id, supportsText: true, supportsEmbeddings: true, inputTokenLimit: null, outputTokenLimit: null, enabled: true, availabilityStatus: "available" },
    ]);

    const aliasRepo = dataSource.getRepository(ModelAlias);
    await aliasRepo.save({ alias: "alias-for-a", modelId: (await modelRepo.findOneBy({ publicName: "model-a" }))!.id });
  }

  describe("GET /v1beta/models", () => {
    it("list shows only serving + allowed models", async () => {
      const { rawKey } = await createKey();
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      expect(res.body.models).toBeDefined();
      const names = res.body.models.map((m: Record<string, unknown>) => m.name);
      expect(names).toEqual([
        "models/model-a",
        "models/model-b",
        "models/model-c",
        "models/model-d"
      ]);
    });

    it("per-key allowedModels / blockedModels filter the list", async () => {
      const { rawKey } = await createKey({ allowedModels: ["model-a", "model-b"], blockedModels: ["model-b"] });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      const names = res.body.models.map((m: Record<string, unknown>) => m.name);
      expect(names).toEqual(["models/model-a"]);
    });

    it("models.list hides model when blocked by alias", async () => {
      const { rawKey } = await createKey({ blockedModels: ["alias-for-a"] });

      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      const names = res.body.models.map((m: Record<string, unknown>) => m.name);
      expect(names).toEqual([
        "models/model-b",
        "models/model-c",
        "models/model-d",
      ]);
    });

    it("models.list shows model when allowed only by alias", async () => {
      const { rawKey } = await createKey({ allowedModels: ["alias-for-a"] });

      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      const names = res.body.models.map((m: Record<string, unknown>) => m.name);
      expect(names).toEqual(["models/model-a"]);
    });

    it("pagination across 3+ models with pageSize=2", async () => {
      const { rawKey } = await createKey();
      
      // Page 1
      let res = await request(app.getHttpServer())
        .get("/v1beta/models?pageSize=2")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      expect(res.body.models).toHaveLength(2);
      expect(res.body.models.map((m: Record<string, unknown>) => m.name)).toEqual(["models/model-a", "models/model-b"]);
      expect(res.body.nextPageToken).toBeDefined();

      // Page 2
      res = await request(app.getHttpServer())
        .get(`/v1beta/models?pageSize=2&pageToken=${res.body.nextPageToken}`)
        .set("x-goog-api-key", rawKey)
        .expect(200);

      expect(res.body.models).toHaveLength(2);
      expect(res.body.models.map((m: Record<string, unknown>) => m.name)).toEqual(["models/model-c", "models/model-d"]);
      expect(res.body.nextPageToken).toBeUndefined(); // no token on last page
    });

    it("missing/invalid key -> 401 Gemini body", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", "invalid")
        .expect(401);

      expect(res.body).toEqual({
        error: {
          code: 401,
          message: "API key not valid. Please pass a valid API key.",
          status: "UNAUTHENTICATED"
        }
      });
    });

    it("?key= works", async () => {
      const { rawKey } = await createKey();
      
      await request(app.getHttpServer())
        .get(`/v1beta/models?key=${rawKey}`)
        .expect(200);
    });

    it("allowedEndpoints without models.list -> 403 on list", async () => {
      const { rawKey } = await createKey({ allowedEndpoints: ["models.get"] });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models")
        .set("x-goog-api-key", rawKey)
        .expect(403);
        
      expect(res.body.error.message).toContain("not allowed to use models.list");
    });
  });

  describe("GET /v1beta/models/:model", () => {
    it("get by public name", async () => {
      const { rawKey } = await createKey();
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models/model-a")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      expect(res.body.name).toBe("models/model-a");
      expect(res.body.baseModelId).toBe("model-a");
      expect(res.body.displayName).toBe("A");
    });

    it("get by alias (name echoes the alias)", async () => {
      const { rawKey } = await createKey();
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models/alias-for-a")
        .set("x-goog-api-key", rawKey)
        .expect(200);

      expect(res.body.name).toBe("models/alias-for-a");
      expect(res.body.baseModelId).toBe("model-a");
    });

    it("get disabled / unavailable / upstream-disabled -> 404", async () => {
      const { rawKey } = await createKey();
      
      await request(app.getHttpServer())
        .get("/v1beta/models/model-disabled")
        .set("x-goog-api-key", rawKey)
        .expect(404);
        
      await request(app.getHttpServer())
        .get("/v1beta/models/model-unavailable")
        .set("x-goog-api-key", rawKey)
        .expect(404);
        
      await request(app.getHttpServer())
        .get("/v1beta/models/model-upstream-disabled")
        .set("x-goog-api-key", rawKey)
        .expect(404);
    });

    it("get blocked -> 403", async () => {
      const { rawKey } = await createKey({ blockedModels: ["model-a"] });
      
      const res = await request(app.getHttpServer())
        .get("/v1beta/models/model-a")
        .set("x-goog-api-key", rawKey)
        .expect(403);

      expect(res.body.error.message).toContain("This API key is not allowed to use model model-a");
    });

    it("block by alias -> 403 for both the public name and the alias", async () => {
      const { rawKey } = await createKey({ blockedModels: ["alias-for-a"] });

      const resPublic = await request(app.getHttpServer())
        .get("/v1beta/models/model-a")
        .set("x-goog-api-key", rawKey)
        .expect(403);
      expect(resPublic.body.error.message).toContain("This API key is not allowed to use model model-a");

      const resAlias = await request(app.getHttpServer())
        .get("/v1beta/models/alias-for-a")
        .set("x-goog-api-key", rawKey)
        .expect(403);
      expect(resAlias.body.error.message).toContain("This API key is not allowed to use model alias-for-a");
    });

    it("allow only an alias -> works via public name and alias", async () => {
      const { rawKey } = await createKey({ allowedModels: ["alias-for-a"] });

      const resPublic = await request(app.getHttpServer())
        .get("/v1beta/models/model-a")
        .set("x-goog-api-key", rawKey)
        .expect(200);
      expect(resPublic.body.name).toBe("models/model-a");
      expect(resPublic.body.baseModelId).toBe("model-a");

      const resAlias = await request(app.getHttpServer())
        .get("/v1beta/models/alias-for-a")
        .set("x-goog-api-key", rawKey)
        .expect(200);
      expect(resAlias.body.name).toBe("models/alias-for-a");
      expect(resAlias.body.baseModelId).toBe("model-a");
    });
  });
});
