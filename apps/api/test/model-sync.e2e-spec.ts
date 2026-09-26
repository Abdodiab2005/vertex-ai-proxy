import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AuditLog, Model, ModelAlias, PricingRule, Upstream } from "@gateway/database";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapOwner } from "../src/cli/bootstrap-owner.js";
import type { ModelSyncSummary } from "../src/models/model-sync-plan.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { UpstreamError } from "../src/upstreams/providers/upstream-errors.js";
import type {
  AIUpstreamProvider,
  ProviderModelInfo,
} from "../src/upstreams/providers/upstream-provider.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import { cookieHeaderValue, createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";

const OWNER_PASSWORD = "correct-horse-1";
const MISSING_ID = "22222222-2222-4222-8222-222222222222";

interface LoggedInSession {
  adminId: string;
  csrfToken: string;
  cookieHeader: string;
}

interface StoredConfig {
  model: {
    id: string;
    publicName: string;
    upstreamModelName: string;
    displayName: string;
    provider: string;
    enabled: boolean;
    availabilityStatus: string;
    supportsText: boolean;
    supportsVision: boolean;
    supportsAudio: boolean;
    supportsVideo: boolean;
    supportsFiles: boolean;
    supportsTools: boolean;
    supportsStreaming: boolean;
    supportsEmbeddings: boolean;
    inputTokenLimit: number | null;
    outputTokenLimit: number | null;
    upstreamId: string;
    createdAt: string;
  };
  aliases: Array<{ id: string; alias: string }>;
  pricing: Array<{
    id: string;
    billingDimension: string;
    unitSize: string;
    price: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
}

function unused(): Promise<never> {
  return Promise.reject(new Error("not used by model sync"));
}

class FakeUpstreamProviderFactory {
  forUpstreamCalls = 0;
  listModels: () => Promise<{ models: ProviderModelInfo[] }> = async () => ({ models: [] });

  forUpstream(): AIUpstreamProvider {
    this.forUpstreamCalls += 1;
    const listModels = this.listModels;
    return {
      listModels: () => listModels(),
      generateContent: unused,
      streamGenerateContent: unused,
      countTokens: unused,
      getModel: unused,
      embedContent: unused,
      testConnection: unused,
    };
  }
}

describe("model sync", () => {
  const factory = new FakeUpstreamProviderFactory();
  let app: NestExpressApplication | undefined;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: UpstreamProviderFactory, useValue: factory }],
    });
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    factory.forUpstreamCalls = 0;
    factory.listModels = async () => ({ models: [] });
    await resetE2eState(requiredApp());
  });

  it("does not erase admin configuration across syncs", async () => {
    const session = await login();
    const upstream = await createUpstream("vertex-main");
    const http = authed(session);

    factory.listModels = async () => ({
      models: [
        { id: "text-embedding-004" },
        { id: "imagen-3.0-generate-002" },
        { id: "publishers/google/models/gemini-2.0-flash" },
        { id: "gemini-2.5-flash" },
      ],
    });

    const first = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(first.status).toBe(200);
    const firstSummary: ModelSyncSummary = {
      discovered: 4,
      created: ["gemini-2.5-flash", "text-embedding-004"],
      markedAvailable: [],
      markedUnavailable: [],
      conflicts: [],
    };
    expect(first.body).toEqual({ summary: firstSummary });

    const listed = await http.get("/admin/models");
    expect(listed.status).toBe(200);
    const created = listed.body.models as Array<Record<string, unknown>>;
    expect(created.map((model) => model.publicName)).toEqual([
      "gemini-2.5-flash",
      "text-embedding-004",
    ]);
    const flash = created.find((model) => model.publicName === "gemini-2.5-flash");
    const embedding = created.find((model) => model.publicName === "text-embedding-004");
    expect(flash).toMatchObject({
      upstreamModelName: "gemini-2.5-flash",
      displayName: "gemini-2.5-flash",
      provider: "vertex-ai",
      enabled: false,
      availabilityStatus: "available",
      supportsText: true,
      supportsVision: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsFiles: false,
      supportsTools: false,
      supportsStreaming: true,
      supportsEmbeddings: false,
      inputTokenLimit: null,
      outputTokenLimit: null,
      upstreamId: upstream.id,
      aliases: [],
      currentPricing: [],
    });
    expect(embedding).toMatchObject({
      upstreamModelName: "text-embedding-004",
      displayName: "text-embedding-004",
      provider: "vertex-ai",
      enabled: false,
      availabilityStatus: "available",
      supportsText: false,
      supportsVision: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsFiles: false,
      supportsTools: false,
      supportsStreaming: false,
      supportsEmbeddings: true,
      inputTokenLimit: null,
      outputTokenLimit: null,
      upstreamId: upstream.id,
    });
    const flashId = flash?.id;
    const embeddingId = embedding?.id;
    expect(typeof flashId).toBe("string");
    expect(typeof embeddingId).toBe("string");
    if (typeof flashId !== "string" || typeof embeddingId !== "string") {
      return;
    }

    const firstAudit = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_SYNCED);
    expect(firstAudit).toHaveLength(1);
    expect(firstAudit[0]).toMatchObject({
      adminUserId: session.adminId,
      entityType: "upstream",
      entityId: upstream.id,
      before: null,
      after: firstSummary,
    });

    const patched = await http.patch(`/admin/models/${flashId}`).send({
      enabled: true,
      displayName: "Flash (edited)",
    });
    expect(patched.status).toBe(200);
    const alias = await http
      .post(`/admin/models/${flashId}/aliases`)
      .send({ alias: "flash-latest" });
    expect(alias.status).toBe(201);
    const priced = await http.post(`/admin/models/${flashId}/pricing`).send({
      billingDimension: "input_tokens",
      price: "1.25",
    });
    expect(priced.status).toBe(201);

    const manual = await http.post("/admin/models").send({
      publicName: "my-router",
      upstreamModelName: "my-router",
      displayName: "My router",
      upstreamId: upstream.id,
      enabled: true,
    });
    expect(manual.status).toBe(201);
    const manualId = manual.body.model.id as string;

    const flashBeforeHide = await loadConfig(flashId);
    const embeddingBeforeHide = await loadConfig(embeddingId);
    const manualBeforeHide = await loadConfig(manualId);
    const idsBeforeHide = await modelIds();

    factory.listModels = async () => ({ models: [{ id: "text-embedding-004" }] });
    const second = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      summary: {
        discovered: 1,
        created: [],
        markedAvailable: [],
        markedUnavailable: ["gemini-2.5-flash"],
        conflicts: [],
      },
    });
    expect(await modelIds()).toEqual(idsBeforeHide);
    expect(await loadConfig(flashId)).toEqual({
      ...flashBeforeHide,
      model: { ...flashBeforeHide.model, availabilityStatus: "unavailable" },
    });
    expect(await loadConfig(embeddingId)).toEqual(embeddingBeforeHide);
    expect(await loadConfig(manualId)).toEqual(manualBeforeHide);

    const flashBeforeReturn = await loadConfig(flashId);
    factory.listModels = async () => ({
      models: [{ id: "gemini-2.5-flash" }, { id: "text-embedding-004" }],
    });
    const third = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(third.status).toBe(200);
    expect(third.body).toEqual({
      summary: {
        discovered: 2,
        created: [],
        markedAvailable: ["gemini-2.5-flash"],
        markedUnavailable: [],
        conflicts: [],
      },
    });
    expect(await modelIds()).toEqual(idsBeforeHide);
    expect(await loadConfig(flashId)).toEqual({
      ...flashBeforeReturn,
      model: { ...flashBeforeReturn.model, availabilityStatus: "available" },
    });
    expect(await loadConfig(embeddingId)).toEqual(embeddingBeforeHide);
    expect(await loadConfig(manualId)).toEqual(manualBeforeHide);

    const other = await createUpstream("vertex-other");
    const taken = await http.post("/admin/models").send({
      publicName: "gemini-2.0-flash",
      upstreamModelName: "gemini-2.0-flash",
      displayName: "Other flash",
      upstreamId: other.id,
      enabled: true,
    });
    expect(taken.status).toBe(201);
    const takenId = taken.body.model.id as string;
    const flashBeforeConflict = await loadConfig(flashId);
    const takenBeforeConflict = await loadConfig(takenId);
    const idsBeforeConflict = await modelIds();

    factory.listModels = async () => ({
      models: [
        { id: "gemini-2.5-flash" },
        { id: "text-embedding-004" },
        { id: "gemini-2.0-flash" },
      ],
    });
    const fourth = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(fourth.status).toBe(200);
    expect(fourth.body).toEqual({
      summary: {
        discovered: 3,
        created: [],
        markedAvailable: [],
        markedUnavailable: [],
        conflicts: ["gemini-2.0-flash"],
      },
    });
    expect(await modelIds()).toEqual(idsBeforeConflict);
    expect(await loadConfig(flashId)).toEqual(flashBeforeConflict);
    expect(await loadConfig(takenId)).toEqual(takenBeforeConflict);
    const takenRows = await dataSource()
      .getRepository(Model)
      .find({ where: { publicName: "gemini-2.0-flash" } });
    expect(takenRows.map((row) => row.upstreamId)).toEqual([other.id]);
  });

  it("returns 502 and writes nothing when discovery fails", async () => {
    const session = await login();
    const upstream = await createUpstream("vertex-main");
    const http = authed(session);
    const created = await http.post("/admin/models").send({
      publicName: "gemini-2.5-flash",
      upstreamModelName: "gemini-2.5-flash",
      displayName: "Keep me",
      upstreamId: upstream.id,
      enabled: true,
    });
    expect(created.status).toBe(201);
    const modelId = created.body.model.id as string;
    const before = await loadConfig(modelId);
    const auditsBefore = await dataSource().getRepository(AuditLog).count();

    factory.listModels = () =>
      Promise.reject(
        new UpstreamError("denied", { kind: "permission_denied", httpStatus: 403 }),
      );
    const response = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(response.body).toEqual({
      statusCode: 502,
      message: "Model discovery failed: permission_denied.",
      error: "Bad Gateway",
    });
    expect(response.status).toBe(502);
    expect(await loadConfig(modelId)).toEqual(before);
    expect(await dataSource().getRepository(Model).count()).toBe(1);
    expect(await dataSource().getRepository(AuditLog).count()).toBe(auditsBefore);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_SYNCED)).toHaveLength(0);
  });

  it("explains that an express API key upstream can't be synced, without calling Vertex", async () => {
    const session = await login();
    const upstream = await createUpstream("vertex-express", "api-key");
    const response = await authed(session).post("/admin/models/sync").send({ upstreamId: upstream.id });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain("Vertex express API keys can't list models");
    expect(factory.forUpstreamCalls).toBe(0);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_SYNCED)).toHaveLength(0);
  });

  it("returns 404 for a missing upstream and rejects unknown fields", async () => {
    const session = await login();
    const upstream = await createUpstream("vertex-main");
    const http = authed(session);

    const missing = await http.post("/admin/models/sync").send({ upstreamId: MISSING_ID });
    expectNestError(missing, 404, "Upstream not found.", "Not Found");
    expect(factory.forUpstreamCalls).toBe(0);

    const extra = await http
      .post("/admin/models/sync")
      .send({ upstreamId: upstream.id, note: "nope" });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe("Bad Request");
    expect(factory.forUpstreamCalls).toBe(0);
    expect(await dataSource().getRepository(Model).count()).toBe(0);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_SYNCED)).toHaveLength(0);
  });

  it("requires an admin session and a CSRF token, and audits a successful sync", async () => {
    const session = await login();
    const upstream = await createUpstream("vertex-main");
    const http = authed(session);

    const anonymous = await request(httpServer)
      .post("/admin/models/sync")
      .send({ upstreamId: upstream.id });
    expectNestError(anonymous, 401, "Unauthorized", "Unauthorized");

    const noCsrf = await request(httpServer)
      .post("/admin/models/sync")
      .set("Cookie", session.cookieHeader)
      .send({ upstreamId: upstream.id });
    expectNestError(noCsrf, 403, "Forbidden", "Forbidden");

    const badCsrf = await request(httpServer)
      .post("/admin/models/sync")
      .set("Cookie", session.cookieHeader)
      .set("x-csrf-token", "not-the-token")
      .send({ upstreamId: upstream.id });
    expectNestError(badCsrf, 403, "Forbidden", "Forbidden");
    expect(factory.forUpstreamCalls).toBe(0);

    factory.listModels = async () => ({ models: [{ id: "gemini-2.5-flash" }] });
    const ok = await http.post("/admin/models/sync").send({ upstreamId: upstream.id });
    expect(ok.status).toBe(200);
    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_SYNCED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: ADMIN_AUDIT_ACTIONS.MODEL_SYNCED,
      adminUserId: session.adminId,
      entityType: "upstream",
      entityId: upstream.id,
      before: null,
      after: ok.body.summary,
    });
    expect(ok.body.summary).toEqual({
      discovered: 1,
      created: ["gemini-2.5-flash"],
      markedAvailable: [],
      markedUnavailable: [],
      conflicts: [],
    });
  });

  function requiredApp(): NestExpressApplication {
    if (app === undefined) {
      throw new Error("E2E app was not started");
    }
    return app;
  }

  function dataSource(): DataSource {
    return requiredApp().get(DataSource);
  }

  async function login(): Promise<LoggedInSession> {
    await bootstrapOwner(dataSource(), new PasswordHasher(), {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    });
    const response = await request(httpServer)
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "owner@example.com", password: OWNER_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    return {
      adminId: response.body.admin.id as string,
      csrfToken: response.body.csrfToken as string,
      cookieHeader: cookieHeaderValue(cookie),
    };
  }

  function authed(session: LoggedInSession) {
    const cookie = session.cookieHeader;
    const csrf = session.csrfToken;
    return {
      get: (url: string) => request(httpServer).get(url).set("Cookie", cookie),
      post: (url: string) =>
        request(httpServer).post(url).set("Cookie", cookie).set("x-csrf-token", csrf),
      patch: (url: string) =>
        request(httpServer).patch(url).set("Cookie", cookie).set("x-csrf-token", csrf),
    };
  }

  async function createUpstream(
    name: string,
    authMethod: "application-default-credentials" | "api-key" = "application-default-credentials",
  ): Promise<Upstream> {
    return dataSource().getRepository(Upstream).save({
      name,
      enabled: true,
      projectId: "project-1",
      location: "us-central1",
      authMethod,
      priority: 0,
      status: "unknown",
    });
  }

  function auditsFor(action: string): Promise<AuditLog[]> {
    return dataSource().getRepository(AuditLog).find({
      where: { action },
      order: { createdAt: "ASC" },
    });
  }

  async function modelIds(): Promise<string[]> {
    const rows = await dataSource().getRepository(Model).find();
    return rows.map((row) => row.id).sort(compareStrings);
  }

  async function loadConfig(modelId: string): Promise<StoredConfig> {
    const row = await dataSource().getRepository(Model).findOneByOrFail({ id: modelId });
    const aliases = await dataSource().getRepository(ModelAlias).find({ where: { modelId } });
    const pricing = await dataSource().getRepository(PricingRule).find({ where: { modelId } });
    aliases.sort((left, right) => compareStrings(left.alias, right.alias));
    pricing.sort((left, right) => compareStrings(left.id, right.id));
    return {
      model: {
        id: row.id,
        publicName: row.publicName,
        upstreamModelName: row.upstreamModelName,
        displayName: row.displayName,
        provider: row.provider,
        enabled: row.enabled,
        availabilityStatus: row.availabilityStatus,
        supportsText: row.supportsText,
        supportsVision: row.supportsVision,
        supportsAudio: row.supportsAudio,
        supportsVideo: row.supportsVideo,
        supportsFiles: row.supportsFiles,
        supportsTools: row.supportsTools,
        supportsStreaming: row.supportsStreaming,
        supportsEmbeddings: row.supportsEmbeddings,
        inputTokenLimit: row.inputTokenLimit,
        outputTokenLimit: row.outputTokenLimit,
        upstreamId: row.upstreamId,
        createdAt: row.createdAt.toISOString(),
      },
      aliases: aliases.map((alias) => ({ id: alias.id, alias: alias.alias })),
      pricing: pricing.map((rule) => ({
        id: rule.id,
        billingDimension: rule.billingDimension,
        unitSize: rule.unitSize,
        price: rule.price,
        currency: rule.currency,
        effectiveFrom: rule.effectiveFrom.toISOString(),
        effectiveTo: rule.effectiveTo?.toISOString() ?? null,
      })),
    };
  }
});

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function expectNestError(response: Response, status: number, message: string, error: string): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ statusCode: status, message, error });
  expect(response.body).not.toHaveProperty("stack");
}
