import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AuditLog, PricingRule, Upstream } from "@gateway/database";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapOwner } from "../src/cli/bootstrap-owner.js";
import { ModelResolver } from "../src/models/model-resolver.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { cookieHeaderValue, createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";

const OWNER_PASSWORD = "correct-horse-1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING_ID = "22222222-2222-4222-8222-222222222222";

interface LoggedInSession {
  adminId: string;
  csrfToken: string;
  cookieHeader: string;
}

interface ModelBody {
  publicName: string;
  upstreamModelName: string;
  displayName: string;
  upstreamId: string;
  enabled?: boolean;
  availabilityStatus?: "available" | "unavailable";
  supportsVision?: boolean;
  inputTokenLimit?: number | null;
  outputTokenLimit?: number | null;
}

describe("model registry", () => {
  let app: NestExpressApplication | undefined;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;

  beforeAll(async () => {
    app = await createE2eApp();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetE2eState(requiredApp());
  });

  it("creates, reads, updates, filters, and searches models", async () => {
    const session = await login();
    const upstream = await createUpstream();
    const http = authed(session);

    const missingUpstream = await http.post("/admin/models").send(
      modelBody(MISSING_ID, "gemini-missing"),
    );
    expectNestError(missingUpstream, 400, "Upstream not found.", "Bad Request");

    const extra = await http.post("/admin/models").send({
      ...modelBody(upstream.id, "gemini-extra"),
      unknown: true,
    });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe("Bad Request");

    const created = await http.post("/admin/models").send({
      ...modelBody(upstream.id, "gemini-2.5-flash"),
      displayName: "Flash",
      upstreamModelName: "gemini-2.5-flash-001",
    });
    expect(created.status).toBe(201);
    expect(created.body.model).toMatchObject({
      publicName: "gemini-2.5-flash",
      upstreamModelName: "gemini-2.5-flash-001",
      displayName: "Flash",
      provider: "vertex-ai",
      enabled: false,
      availabilityStatus: "available",
      supportsText: true,
      supportsVision: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsFiles: false,
      supportsTools: false,
      supportsStreaming: false,
      supportsEmbeddings: false,
      inputTokenLimit: null,
      outputTokenLimit: null,
      upstreamId: upstream.id,
      aliases: [],
      currentPricing: [],
      upstream: { id: upstream.id, name: upstream.name },
    });
    expect(created.body.model.id).toMatch(UUID_PATTERN);
    expect(Date.parse(created.body.model.createdAt)).not.toBeNaN();
    expect(Date.parse(created.body.model.updatedAt)).not.toBeNaN();
    const modelId = created.body.model.id as string;

    const fetched = await http.get(`/admin/models/${modelId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.model).toEqual(created.body.model);

    const missing = await http.get(`/admin/models/${MISSING_ID}`);
    expectNestError(missing, 404, "Not Found", "Not Found");
    const notUuid = await http.get("/admin/models/not-a-uuid");
    expectNestError(notUuid, 404, "Not Found", "Not Found");

    const patched = await http.patch(`/admin/models/${modelId}`).send({
      displayName: "Flash 2",
      enabled: true,
      supportsVision: true,
      inputTokenLimit: 8192,
      outputTokenLimit: 4096,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.model).toMatchObject({
      displayName: "Flash 2",
      enabled: true,
      supportsVision: true,
      inputTokenLimit: 8192,
      outputTokenLimit: 4096,
      publicName: "gemini-2.5-flash",
    });

    const cleared = await http.patch(`/admin/models/${modelId}`).send({
      inputTokenLimit: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.model.inputTokenLimit).toBeNull();
    expect(cleared.body.model.outputTokenLimit).toBe(4096);

    const other = await http.post("/admin/models").send({
      ...modelBody(upstream.id, "gemini-2.5-pro"),
      displayName: "Pro",
      enabled: false,
      availabilityStatus: "unavailable",
    });
    expect(other.status).toBe(201);

    const listed = await http.get("/admin/models");
    expect(listed.status).toBe(200);
    expect(listed.body.models.map((model: { publicName: string }) => model.publicName)).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);

    const enabledOnly = await http.get("/admin/models?enabled=true");
    expect(enabledOnly.body.models.map((model: { publicName: string }) => model.publicName)).toEqual([
      "gemini-2.5-flash",
    ]);
    const disabledOnly = await http.get("/admin/models?enabled=false");
    expect(disabledOnly.body.models).toHaveLength(1);
    expect(disabledOnly.body.models[0].publicName).toBe("gemini-2.5-pro");

    const unavailable = await http.get("/admin/models?availability=unavailable");
    expect(unavailable.body.models.map((model: { publicName: string }) => model.publicName)).toEqual([
      "gemini-2.5-pro",
    ]);

    const byDisplay = await http.get("/admin/models?search=flash");
    expect(byDisplay.body.models).toHaveLength(1);
    expect(byDisplay.body.models[0].publicName).toBe("gemini-2.5-flash");

    const byUpstreamName = await http.get("/admin/models?search=flash-001");
    expect(byUpstreamName.body.models).toHaveLength(1);

    const wildcard = await request(httpServer)
      .get("/admin/models")
      .query({ search: "%" })
      .set("Cookie", session.cookieHeader);
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.models).toEqual([]);
    const underscore = await request(httpServer)
      .get("/admin/models")
      .query({ search: "_" })
      .set("Cookie", session.cookieHeader);
    expect(underscore.body.models).toEqual([]);

    const badFilter = await http.get("/admin/models?enabled=yes");
    expect(badFilter.status).toBe(400);
    const badAvailability = await http.get("/admin/models?availability=maybe");
    expect(badAvailability.status).toBe(400);

    const createdAudit = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_CREATED);
    expect(createdAudit).toHaveLength(2);
    expect(createdAudit.every((row) => row.adminUserId === session.adminId)).toBe(true);
    expect(createdAudit.every((row) => row.entityType === "model")).toBe(true);
    const flashAudit = createdAudit.find(
      (row) =>
        typeof row.after === "object" &&
        row.after !== null &&
        row.after.publicName === "gemini-2.5-flash",
    );
    expect(flashAudit?.entityId).toBe(modelId);
    expect(flashAudit?.before).toBeNull();

    const updatedAudit = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_UPDATED);
    expect(updatedAudit.length).toBeGreaterThanOrEqual(2);
    expect(updatedAudit[0]?.adminUserId).toBe(session.adminId);
    const displayUpdate = updatedAudit.find(
      (row) =>
        typeof row.before === "object" &&
        row.before !== null &&
        row.before.displayName === "Flash",
    );
    expect(displayUpdate?.after).toMatchObject({ displayName: "Flash 2", enabled: true });
  });

  it("keeps names unique across public names and aliases", async () => {
    const session = await login();
    const upstream = await createUpstream();
    const http = authed(session);
    const first = await http.post("/admin/models").send(modelBody(upstream.id, "gemini-a"));
    const second = await http.post("/admin/models").send(modelBody(upstream.id, "gemini-b"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = first.body.model.id as string;
    const secondId = second.body.model.id as string;

    const duplicateName = await http.post("/admin/models").send(modelBody(upstream.id, "gemini-a"));
    expectNestError(
      duplicateName,
      409,
      "A model or alias with that name already exists.",
      "Conflict",
    );

    const added = await http.post(`/admin/models/${firstId}/aliases`).send({ alias: "gemini-a-latest" });
    expect(added.status).toBe(201);
    expect(added.body.model.aliases).toEqual(["gemini-a-latest"]);

    const aliasAsName = await http
      .post("/admin/models")
      .send(modelBody(upstream.id, "gemini-a-latest"));
    expect(aliasAsName.status).toBe(409);

    const ownPublicName = await http
      .post(`/admin/models/${firstId}/aliases`)
      .send({ alias: "gemini-a" });
    expect(ownPublicName.status).toBe(409);

    const otherPublicName = await http
      .post(`/admin/models/${secondId}/aliases`)
      .send({ alias: "gemini-a" });
    expect(otherPublicName.status).toBe(409);

    const duplicateAlias = await http
      .post(`/admin/models/${secondId}/aliases`)
      .send({ alias: "gemini-a-latest" });
    expect(duplicateAlias.status).toBe(409);

    const renameClash = await http
      .patch(`/admin/models/${secondId}`)
      .send({ publicName: "gemini-a-latest" });
    expect(renameClash.status).toBe(409);

    const renamed = await http
      .patch(`/admin/models/${secondId}`)
      .send({ publicName: "gemini-b-renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.model.publicName).toBe("gemini-b-renamed");

    const foundByAlias = await http.get("/admin/models?search=a-latest");
    expect(foundByAlias.status).toBe(200);
    expect(foundByAlias.body.models.map((model: { publicName: string }) => model.publicName)).toEqual([
      "gemini-a",
    ]);

    const removed = await http.delete(`/admin/models/${firstId}/aliases/gemini-a-latest`);
    expect(removed.status).toBe(200);
    expect(removed.body.model.aliases).toEqual([]);

    const missingAlias = await http.delete(`/admin/models/${firstId}/aliases/gemini-a-latest`);
    expectNestError(missingAlias, 404, "Not Found", "Not Found");
    const missingModel = await http
      .post(`/admin/models/${MISSING_ID}/aliases`)
      .send({ alias: "gemini-fresh" });
    expectNestError(missingModel, 404, "Not Found", "Not Found");

    const aliasAdded = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_ALIAS_ADDED);
    expect(aliasAdded).toHaveLength(1);
    expect(aliasAdded[0]).toMatchObject({
      adminUserId: session.adminId,
      entityType: "model",
      entityId: firstId,
      after: { alias: "gemini-a-latest" },
    });
    const aliasRemoved = await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_ALIAS_REMOVED);
    expect(aliasRemoved).toHaveLength(1);
    expect(aliasRemoved[0]?.before).toMatchObject({ alias: "gemini-a-latest" });
    expect(aliasRemoved[0]?.entityId).toBe(firstId);

    const aliasGone = await http.get("/admin/models?search=gemini-a-latest");
    expect(aliasGone.body.models).toEqual([]);
  });

  it("closes the open pricing rule, rejects overlap and backdating, and deletes only future rules", async () => {
    const session = await login();
    const upstream = await createUpstream();
    const http = authed(session);
    const created = await http
      .post("/admin/models")
      .send({ ...modelBody(upstream.id, "gemini-priced"), enabled: true });
    expect(created.status).toBe(201);
    const modelId = created.body.model.id as string;

    const startedAt = new Date(Date.now() - 30_000).toISOString();
    const replacesAt = new Date(Date.now() + 120_000).toISOString();

    const first = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "input_tokens",
      price: "1.50",
      effectiveFrom: startedAt,
    });
    expect(first.status).toBe(201);
    expect(first.body.rules).toHaveLength(1);
    expect(first.body.rules[0]).toMatchObject({
      billingDimension: "input_tokens",
      currency: "USD",
      effectiveTo: null,
    });
    expect(first.body.rules[0].unitSize).toBe("1000000");
    expectDecimal(first.body.rules[0].price, "1.50");
    expect(Date.parse(first.body.rules[0].effectiveFrom)).toBe(Date.parse(startedAt));
    expect(typeof first.body.rules[0].price).toBe("string");
    expect(typeof first.body.rules[0].unitSize).toBe("string");

    const replacement = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "input_tokens",
      price: "2.25",
      unitSize: "1000",
      currency: "EUR",
      effectiveFrom: replacesAt,
    });
    expect(replacement.status).toBe(201);
    expect(replacement.body.rules).toHaveLength(2);
    expect(Date.parse(replacement.body.rules[0].effectiveFrom)).toBe(Date.parse(replacesAt));
    expect(replacement.body.rules[0].effectiveTo).toBeNull();
    expectDecimal(replacement.body.rules[0].price, "2.25");
    expect(replacement.body.rules[0].unitSize).toBe("1000");
    expect(replacement.body.rules[0].currency).toBe("EUR");
    expect(Date.parse(replacement.body.rules[1].effectiveFrom)).toBe(Date.parse(startedAt));
    expect(Date.parse(replacement.body.rules[1].effectiveTo)).toBe(Date.parse(replacesAt));
    expectDecimal(replacement.body.rules[1].price, "1.50");
    expect(replacement.body.rules[1].currency).toBe("USD");

    const current = await http.get(`/admin/models/${modelId}`);
    expect(current.body.model.currentPricing).toHaveLength(1);
    expect(current.body.model.currentPricing[0].billingDimension).toBe("input_tokens");
    expectDecimal(current.body.model.currentPricing[0].price, "1.50");
    expect(Date.parse(current.body.model.currentPricing[0].effectiveTo)).toBe(Date.parse(replacesAt));

    const overlap = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "input_tokens",
      price: "9.00",
      effectiveFrom: startedAt,
    });
    expectNestError(
      overlap,
      409,
      "Pricing rule overlaps an existing rule for the same billing dimension.",
      "Conflict",
    );
    const history = await http.get(`/admin/models/${modelId}/pricing`);
    expect(history.status).toBe(200);
    expect(history.body.rules).toHaveLength(2);

    const tooOld = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "audio_input_tokens",
      price: "0.10",
      effectiveFrom: new Date(Date.now() - 120_000).toISOString(),
    });
    expectNestError(
      tooOld,
      400,
      "effectiveFrom cannot be more than 60 seconds in the past.",
      "Bad Request",
    );

    const badPrice = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "output_tokens",
      price: "1.123456789",
    });
    expect(badPrice.status).toBe(400);
    const numericPrice = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "output_tokens",
      price: 1.5,
    });
    expect(numericPrice.status).toBe(400);
    const zeroUnit = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "output_tokens",
      price: "1.00",
      unitSize: "0",
    });
    expect(zeroUnit.status).toBe(400);

    const customStarts = new Date(Date.now() + 3_600_000).toISOString();
    const custom = await http.post(`/admin/models/${modelId}/pricing`).send({
      billingDimension: "custom_widget_units",
      price: "3.00",
      effectiveFrom: customStarts,
    });
    expect(custom.status).toBe(201);
    expect(custom.body.rules.map((rule: { billingDimension: string }) => rule.billingDimension)).toEqual([
      "custom_widget_units",
      "input_tokens",
      "input_tokens",
    ]);

    const stored = await dataSource()
      .getRepository(PricingRule)
      .findOneByOrFail({ id: first.body.rules[0].id as string });
    expect(typeof stored.price).toBe("string");
    expectDecimal(stored.price, "1.50");
    expect(stored.unitSize).toBe("1000000");

    const activeRuleId = replacement.body.rules[1].id as string;
    const futureRuleId = replacement.body.rules[0].id as string;
    const customRuleId = custom.body.rules[0].id as string;

    const deleteActive = await http.delete(`/admin/models/${modelId}/pricing/${activeRuleId}`);
    expectNestError(
      deleteActive,
      409,
      "Pricing rules that have taken effect cannot be deleted.",
      "Conflict",
    );
    const stillThere = await http.get(`/admin/models/${modelId}/pricing`);
    expect(stillThere.body.rules.some((rule: { id: string }) => rule.id === activeRuleId)).toBe(true);

    const deleteFuture = await http.delete(`/admin/models/${modelId}/pricing/${futureRuleId}`);
    expect(deleteFuture.status).toBe(204);
    const afterDelete = await http.get(`/admin/models/${modelId}/pricing`);
    expect(afterDelete.body.rules.map((rule: { id: string }) => rule.id)).toEqual([
      customRuleId,
      activeRuleId,
    ]);
    const closed = afterDelete.body.rules.find((rule: { id: string }) => rule.id === activeRuleId);
    expect(Date.parse(closed.effectiveTo)).toBe(Date.parse(replacesAt));

    const deleteCustom = await http.delete(`/admin/models/${modelId}/pricing/${customRuleId}`);
    expect(deleteCustom.status).toBe(204);

    const missingRule = await http.delete(`/admin/models/${modelId}/pricing/${MISSING_ID}`);
    expectNestError(missingRule, 404, "Not Found", "Not Found");
    const missingModel = await http.get(`/admin/models/${MISSING_ID}/pricing`);
    expectNestError(missingModel, 404, "Not Found", "Not Found");

    const addedAudit = await auditsFor(ADMIN_AUDIT_ACTIONS.PRICING_RULE_ADDED);
    expect(addedAudit.length).toBeGreaterThanOrEqual(2);
    expect(addedAudit.every((row) => row.adminUserId === session.adminId)).toBe(true);
    expect(addedAudit.every((row) => row.entityType === "pricing_rule")).toBe(true);
    const replacementAudit = addedAudit.find((row) => row.entityId === futureRuleId);
    expect(replacementAudit?.before).toMatchObject({
      closed: [expect.objectContaining({ id: activeRuleId })],
    });
    expect(replacementAudit?.after).toMatchObject({
      rule: expect.objectContaining({ billingDimension: "input_tokens" }),
    });
    const addedPrice = rulePrice(replacementAudit?.after);
    expect(typeof addedPrice).toBe("string");
    expectDecimal(addedPrice, "2.25");

    const deletedAudit = await auditsFor(ADMIN_AUDIT_ACTIONS.PRICING_RULE_DELETED);
    expect(deletedAudit.map((row) => row.entityId).sort()).toEqual([customRuleId, futureRuleId].sort());
    const deletedFuture = deletedAudit.find((row) => row.entityId === futureRuleId);
    expect(typeof rulePrice(deletedFuture?.before)).toBe("string");
    expectDecimal(rulePrice(deletedFuture?.before), "2.25");
  });

  it("resolves a public name or alias only when the model and upstream can serve traffic", async () => {
    const session = await login();
    const upstream = await createUpstream();
    const http = authed(session);
    const created = await http.post("/admin/models").send({
      ...modelBody(upstream.id, "gemini-2.5-flash"),
      enabled: true,
    });
    expect(created.status).toBe(201);
    const modelId = created.body.model.id as string;
    const alias = await http
      .post(`/admin/models/${modelId}/aliases`)
      .send({ alias: "flash-latest" });
    expect(alias.status).toBe(201);

    const resolver = requiredApp().get(ModelResolver);
    const byName = await resolver.resolve("gemini-2.5-flash");
    expect(byName?.model.id).toBe(modelId);
    expect(byName?.model.publicName).toBe("gemini-2.5-flash");
    expect(byName?.upstream.id).toBe(upstream.id);

    const byPrefix = await resolver.resolve("models/gemini-2.5-flash");
    expect(byPrefix?.model.id).toBe(modelId);
    const byAlias = await resolver.resolve("flash-latest");
    expect(byAlias?.model.id).toBe(modelId);
    const byAliasPrefix = await resolver.resolve("models/flash-latest");
    expect(byAliasPrefix?.model.id).toBe(modelId);

    expect(await resolver.resolve("missing-model")).toBeNull();
    expect(await resolver.resolve("models/")).toBeNull();
    expect(await resolver.resolve("bad name")).toBeNull();

    const disabled = await http.patch(`/admin/models/${modelId}`).send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(await resolver.resolve("gemini-2.5-flash")).toBeNull();
    expect(await resolver.resolve("flash-latest")).toBeNull();

    const enabled = await http.patch(`/admin/models/${modelId}`).send({ enabled: true });
    expect(enabled.status).toBe(200);
    expect((await resolver.resolve("gemini-2.5-flash"))?.model.id).toBe(modelId);

    const unavailable = await http
      .patch(`/admin/models/${modelId}`)
      .send({ availabilityStatus: "unavailable" });
    expect(unavailable.status).toBe(200);
    expect(await resolver.resolve("gemini-2.5-flash")).toBeNull();
    expect(await resolver.resolve("models/flash-latest")).toBeNull();

    await http.patch(`/admin/models/${modelId}`).send({ availabilityStatus: "available" });
    await dataSource().getRepository(Upstream).update({ id: upstream.id }, { enabled: false });
    expect(await resolver.resolve("gemini-2.5-flash")).toBeNull();
    expect(await resolver.resolve("flash-latest")).toBeNull();

    await dataSource().getRepository(Upstream).update({ id: upstream.id }, { enabled: true });
    expect((await resolver.resolve("models/gemini-2.5-flash"))?.upstream.enabled).toBe(true);
  });

  it("requires an admin session and a CSRF token on mutations", async () => {
    const session = await login();
    const upstream = await createUpstream();

    const anonymous = await request(httpServer).get("/admin/models");
    expectNestError(anonymous, 401, "Unauthorized", "Unauthorized");

    const postAnonymous = await request(httpServer)
      .post("/admin/models")
      .send(modelBody(upstream.id, "gemini-anon"));
    expectNestError(postAnonymous, 401, "Unauthorized", "Unauthorized");

    const noCsrf = await request(httpServer)
      .post("/admin/models")
      .set("Cookie", session.cookieHeader)
      .send(modelBody(upstream.id, "gemini-no-csrf"));
    expectNestError(noCsrf, 403, "Forbidden", "Forbidden");

    const badCsrf = await request(httpServer)
      .patch(`/admin/models/${MISSING_ID}`)
      .set("Cookie", session.cookieHeader)
      .set("x-csrf-token", "not-the-token")
      .send({ enabled: true });
    expectNestError(badCsrf, 403, "Forbidden", "Forbidden");

    const deleteNoCsrf = await request(httpServer)
      .delete(`/admin/models/${MISSING_ID}/pricing/${MISSING_ID}`)
      .set("Cookie", session.cookieHeader);
    expectNestError(deleteNoCsrf, 403, "Forbidden", "Forbidden");

    const listed = await request(httpServer)
      .get("/admin/models")
      .set("Cookie", session.cookieHeader);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ models: [] });
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.MODEL_CREATED)).toHaveLength(0);
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
      delete: (url: string) =>
        request(httpServer).delete(url).set("Cookie", cookie).set("x-csrf-token", csrf),
    };
  }

  async function createUpstream(enabled = true): Promise<Upstream> {
    return dataSource().getRepository(Upstream).save({
      name: "vertex-main",
      enabled,
      projectId: "project-1",
      location: "us-central1",
      authMethod: "application-default-credentials",
      priority: 0,
      status: "unknown",
    });
  }

  function auditsFor(action: string): Promise<AuditLog[]> {
    return dataSource().getRepository(AuditLog).find({ where: { action } });
  }
});

function modelBody(upstreamId: string, publicName: string): ModelBody {
  return {
    publicName,
    upstreamModelName: publicName,
    displayName: publicName,
    upstreamId,
  };
}

function expectNestError(response: Response, status: number, message: string, error: string): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ statusCode: status, message, error });
  expect(response.body).not.toHaveProperty("stack");
}

function expectDecimal(actual: unknown, expected: string): void {
  expect(typeof actual).toBe("string");
  if (typeof actual !== "string") {
    return;
  }
  expect(canonicalizeDecimal(actual)).toBe(canonicalizeDecimal(expected));
}

function canonicalizeDecimal(value: string): string {
  const [whole = "", fraction = ""] = value.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return trimmedFraction.length === 0 ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
}

function rulePrice(snapshot: unknown): unknown {
  if (typeof snapshot !== "object" || snapshot === null) {
    return undefined;
  }
  if ("price" in snapshot) {
    return snapshot.price;
  }
  if ("rule" in snapshot && typeof snapshot.rule === "object" && snapshot.rule !== null && "price" in snapshot.rule) {
    return snapshot.rule.price;
  }
  return undefined;
}
