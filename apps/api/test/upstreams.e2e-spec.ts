import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AuditLog, Upstream } from "@gateway/database";
import { CredentialCipher, CredentialDecryptionError } from "@gateway/shared";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapOwner } from "../src/cli/bootstrap-owner.js";
import { ConfigService } from "../src/config/config.service.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import {
  cookieHeaderValue,
  createE2eApp,
  resetE2eState,
  sessionCookie,
} from "./e2e-app.js";

const OWNER_PASSWORD = "correct-horse-1";
const PROJECT_ID = "gw-upstream-test";
const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PRIVATE KEY-----\n";
const REPLACEMENT_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ncmVwbGFjZW1lbnQta2V5\n-----END PRIVATE KEY-----\n";
const API_KEY = "express-mode-api-key-sentinel";
const CLIENT_EMAIL = "gateway@example.iam.gserviceaccount.com";
const REPLACEMENT_EMAIL = "replacement@example.iam.gserviceaccount.com";
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

interface Session {
  cookieHeader: string;
  csrfToken: string;
  adminId: string;
}

describe("admin upstreams", () => {
  let app: NestExpressApplication | undefined;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;
  let session: Session;

  beforeAll(async () => {
    app = await createE2eApp();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetE2eState(requiredApp());
    session = await login();
  });

  it("requires a session", async () => {
    // Each request is created only when the previous one has settled. Supertest
    // closes the shared server after the last in-flight request, so building
    // them all up front points the rest at a port that is no longer listening.
    const sends = [
      () => request(httpServer).get("/admin/upstreams"),
      () => request(httpServer).get(`/admin/upstreams/${MISSING_ID}`),
      () => request(httpServer).post("/admin/upstreams").send(adcBody("open")),
      () => request(httpServer).patch(`/admin/upstreams/${MISSING_ID}`).send({ enabled: false }),
      () =>
        request(httpServer)
          .post(`/admin/upstreams/${MISSING_ID}/test`)
          .send({ model: "gemini-2.5-flash" }),
    ];

    for (const send of sends) {
      const response = await send();
      expectNestError(response, 401, "Unauthorized", "Unauthorized");
    }
  });

  it("requires a CSRF token on writes and not on reads", async () => {
    const created = await createUpstream(adcBody("csrf-target"));
    const id = created.body.upstream.id as string;

    const missing = await request(httpServer)
      .post("/admin/upstreams")
      .set("Cookie", session.cookieHeader)
      .send(adcBody("no-csrf"));
    expectNestError(missing, 403, "Forbidden", "Forbidden");

    const wrong = await request(httpServer)
      .patch(`/admin/upstreams/${id}`)
      .set("Cookie", session.cookieHeader)
      .set("x-csrf-token", "not-the-csrf-token")
      .send({ name: "renamed" });
    expectNestError(wrong, 403, "Forbidden", "Forbidden");

    const testMissing = await request(httpServer)
      .post(`/admin/upstreams/${id}/test`)
      .set("Cookie", session.cookieHeader)
      .send({ model: "gemini-2.5-flash" });
    expectNestError(testMissing, 403, "Forbidden", "Forbidden");

    const read = await request(httpServer)
      .get("/admin/upstreams")
      .set("Cookie", session.cookieHeader);
    expect(read.status).toBe(200);
    expect(read.body.upstreams).toHaveLength(1);
  });

  it("creates an application-default-credentials upstream with defaults", async () => {
    const response = await createUpstream({
      name: "adc",
      projectId: PROJECT_ID,
      location: "global",
      authMethod: "application-default-credentials",
    });

    expect(response.status).toBe(201);
    expect(response.body.upstream).toMatchObject({
      name: "adc",
      provider: "vertex-ai",
      enabled: true,
      projectId: PROJECT_ID,
      location: "global",
      authMethod: "application-default-credentials",
      hasCredentials: false,
      credentialSummary: null,
      priority: 0,
      status: "unknown",
      lastCheckedAt: null,
    });
    expect(response.body.upstream).not.toHaveProperty("credentials");
    expect(response.body.upstream).not.toHaveProperty("encryptedCredentials");
    expect(Date.parse(response.body.upstream.createdAt)).not.toBeNaN();
    expect(Date.parse(response.body.upstream.updatedAt)).not.toBeNaN();

    const stored = await upstreamRow(response.body.upstream.id);
    expect(stored.encryptedCredentials).toBeNull();
    expect(stored.credentialSummary).toBeNull();

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.UPSTREAM_CREATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.adminUserId).toBe(session.adminId);
    expect(audits[0]?.entityType).toBe("upstream");
    expect(audits[0]?.entityId).toBe(response.body.upstream.id);
    expect(audits[0]?.before).toBeNull();
    expect(audits[0]?.after).toMatchObject({ name: "adc", hasCredentials: false });
  });

  it("creates a service-account upstream and encrypts the key to that row", async () => {
    const credentials = serviceAccount(CLIENT_EMAIL, PRIVATE_KEY);
    const response = await createUpstream({
      name: "vertex-sa",
      projectId: PROJECT_ID,
      location: "us-central1",
      authMethod: "service-account",
      credentials,
      priority: 4,
    });

    expect(response.status).toBe(201);
    expect(response.body.upstream).toMatchObject({
      name: "vertex-sa",
      authMethod: "service-account",
      hasCredentials: true,
      credentialSummary: CLIENT_EMAIL,
      priority: 4,
      status: "unknown",
    });
    expectNoSecret(response.body, PRIVATE_KEY);

    const stored = await upstreamRow(response.body.upstream.id);
    expect(stored.encryptedCredentials?.startsWith("v1.")).toBe(true);
    expect(stored.encryptedCredentials).not.toContain(PRIVATE_KEY);
    expect(stored.credentialSummary).toBe(CLIENT_EMAIL);

    const cipher = cipherFromEnv();
    const decrypted = cipher.decrypt(
      stored.encryptedCredentials ?? "",
      `upstream:${stored.id}`,
    );
    expect(JSON.parse(decrypted) as unknown).toEqual(credentials);
    expect(() => cipher.decrypt(stored.encryptedCredentials ?? "", `upstream:${MISSING_ID}`)).toThrow(
      CredentialDecryptionError,
    );

    const fetched = await authed(request(httpServer).get(`/admin/upstreams/${stored.id}`));
    expect(fetched.status).toBe(200);
    expect(fetched.body.upstream).toEqual(response.body.upstream);
    expectNoSecret(fetched.body, PRIVATE_KEY);
    await expectNoSecretInAudits(PRIVATE_KEY);
  });

  it("creates an api-key upstream without a credential summary", async () => {
    const response = await createUpstream({
      name: "express",
      projectId: PROJECT_ID,
      location: "eu",
      authMethod: "api-key",
      credentials: API_KEY,
      enabled: false,
    });

    expect(response.status).toBe(201);
    expect(response.body.upstream).toMatchObject({
      authMethod: "api-key",
      enabled: false,
      hasCredentials: true,
      credentialSummary: null,
      location: "eu",
    });
    expectNoSecret(response.body, API_KEY);

    const stored = await upstreamRow(response.body.upstream.id);
    expect(stored.encryptedCredentials?.startsWith("v1.")).toBe(true);
    expect(stored.encryptedCredentials).not.toContain(API_KEY);
    const decrypted = cipherFromEnv().decrypt(
      stored.encryptedCredentials ?? "",
      `upstream:${stored.id}`,
    );
    expect(JSON.parse(decrypted) as unknown).toBe(API_KEY);
    await expectNoSecretInAudits(API_KEY);
  });

  it.each([
    ["empty name", { name: "" }, "name"],
    ["bad project id", { projectId: "NOPE" }, "projectId"],
    ["bad location", { location: "US" }, "location"],
    ["unknown key", { encryptedCredentials: "leak" }, "encryptedCredentials"],
    ["adc with credentials", { credentials: { leak: PRIVATE_KEY } }, "credentials"],
    [
      "service account without a private key",
      {
        authMethod: "service-account",
        credentials: {
          type: "service_account",
          client_email: CLIENT_EMAIL,
          private_key: "not-a-private-key-sentinel",
        },
      },
      "private_key",
    ],
    ["short api key", { authMethod: "api-key", credentials: "short" }, "credentials"],
    ["priority too high", { priority: 1001 }, "priority"],
    ["fractional priority", { priority: 1.5 }, "priority"],
    ["unknown provider", { provider: "openai" }, "provider"],
  ])("rejects %s", async (_label, overrides, messageHint) => {
    const response = await createUpstream({ ...adcBody("invalid"), ...overrides });

    expect(response.status).toBe(400);
    expect(response.body.statusCode).toBe(400);
    expect(response.body.error).toBe("Bad Request");
    expect(Array.isArray(response.body.message)).toBe(true);
    expect(response.body.message.join(" ")).toContain(messageHint);
    expectNoSecret(response.body, PRIVATE_KEY);
    expectNoSecret(response.body, "not-a-private-key-sentinel");
    expect(await dataSource().getRepository(Upstream).count()).toBe(0);
  });

  it("lists upstreams by priority and then name", async () => {
    await createUpstream(adcBody("zeta", 0));
    await createUpstream(adcBody("alpha", 0));
    await createUpstream(adcBody("mid", 5));
    await createUpstream(adcBody("beta", 10));

    const response = await authed(request(httpServer).get("/admin/upstreams"));

    expect(response.status).toBe(200);
    expect(response.body.upstreams.map((upstream: { name: string; priority: number }) => [upstream.priority, upstream.name])).toEqual([
      [0, "alpha"],
      [0, "zeta"],
      [5, "mid"],
      [10, "beta"],
    ]);
  });

  it("returns 404 for an unknown upstream", async () => {
    const missing = await authed(request(httpServer).get(`/admin/upstreams/${MISSING_ID}`));
    const malformed = await authed(request(httpServer).get("/admin/upstreams/not-a-uuid"));
    const patch = await authed(
      request(httpServer).patch(`/admin/upstreams/${MISSING_ID}`).send({ name: "nope" }),
    );
    const probe = await authed(
      request(httpServer)
        .post(`/admin/upstreams/${MISSING_ID}/test`)
        .send({ model: "gemini-2.5-flash" }),
    );

    for (const response of [missing, malformed, patch, probe]) {
      expectNestError(response, 404, "Upstream not found.", "Not Found");
    }
  });

  it("keeps stored credentials when a patch omits them", async () => {
    const created = await createUpstream(serviceAccountBody("keep-me"));
    const id = created.body.upstream.id as string;
    const before = await upstreamRow(id);

    const response = await authed(
      request(httpServer).patch(`/admin/upstreams/${id}`).send({ name: "renamed", priority: 3 }),
    );

    expect(response.status).toBe(200);
    expect(response.body.upstream).toMatchObject({
      name: "renamed",
      priority: 3,
      authMethod: "service-account",
      hasCredentials: true,
      credentialSummary: CLIENT_EMAIL,
    });
    expectNoSecret(response.body, PRIVATE_KEY);

    const after = await upstreamRow(id);
    expect(after.encryptedCredentials).toBe(before.encryptedCredentials);
    const decrypted = cipherFromEnv().decrypt(after.encryptedCredentials ?? "", `upstream:${id}`);
    expect(JSON.parse(decrypted) as unknown).toEqual(serviceAccount(CLIENT_EMAIL, PRIVATE_KEY));

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.UPSTREAM_UPDATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.before).toMatchObject({ name: "keep-me" });
    expect(audits[0]?.after).toMatchObject({ name: "renamed", priority: 3 });
    expect(audits[0]?.after).not.toHaveProperty("credentialsChanged");
    await expectNoSecretInAudits(PRIVATE_KEY);
  });

  it("replaces stored credentials and records that they changed", async () => {
    const created = await createUpstream(serviceAccountBody("replace-me"));
    const id = created.body.upstream.id as string;
    const replacement = serviceAccount(REPLACEMENT_EMAIL, REPLACEMENT_PRIVATE_KEY);

    const response = await authed(
      request(httpServer).patch(`/admin/upstreams/${id}`).send({ credentials: replacement }),
    );

    expect(response.status).toBe(200);
    expect(response.body.upstream).toMatchObject({
      authMethod: "service-account",
      hasCredentials: true,
      credentialSummary: REPLACEMENT_EMAIL,
    });
    expectNoSecret(response.body, PRIVATE_KEY);
    expectNoSecret(response.body, REPLACEMENT_PRIVATE_KEY);

    const stored = await upstreamRow(id);
    expect(stored.encryptedCredentials?.startsWith("v1.")).toBe(true);
    expect(stored.encryptedCredentials).not.toContain(PRIVATE_KEY);
    expect(stored.encryptedCredentials).not.toContain(REPLACEMENT_PRIVATE_KEY);
    const decrypted = cipherFromEnv().decrypt(stored.encryptedCredentials ?? "", `upstream:${id}`);
    expect(JSON.parse(decrypted) as unknown).toEqual(replacement);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.UPSTREAM_UPDATED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toMatchObject({
      credentialSummary: REPLACEMENT_EMAIL,
      credentialsChanged: true,
    });
    await expectNoSecretInAudits(PRIVATE_KEY);
    await expectNoSecretInAudits(REPLACEMENT_PRIVATE_KEY);
  });

  it("switches auth method, requiring credentials unless the new method is application default", async () => {
    const created = await createUpstream(serviceAccountBody("switch-me"));
    const id = created.body.upstream.id as string;
    const original = await upstreamRow(id);

    const missingKey = await authed(
      request(httpServer).patch(`/admin/upstreams/${id}`).send({ authMethod: "api-key" }),
    );
    expect(missingKey.status).toBe(400);
    expect(Array.isArray(missingKey.body.message)).toBe(true);
    const unchanged = await upstreamRow(id);
    expect(unchanged.authMethod).toBe("service-account");
    expect(unchanged.encryptedCredentials).toBe(original.encryptedCredentials);

    const switched = await authed(
      request(httpServer)
        .patch(`/admin/upstreams/${id}`)
        .send({ authMethod: "api-key", credentials: API_KEY }),
    );
    expect(switched.status).toBe(200);
    expect(switched.body.upstream).toMatchObject({
      authMethod: "api-key",
      hasCredentials: true,
      credentialSummary: null,
    });
    expectNoSecret(switched.body, PRIVATE_KEY);
    expectNoSecret(switched.body, API_KEY);
    const apiKeyRow = await upstreamRow(id);
    expect(apiKeyRow.encryptedCredentials).not.toContain(PRIVATE_KEY);
    expect(apiKeyRow.encryptedCredentials).not.toContain(API_KEY);
    expect(
      JSON.parse(
        cipherFromEnv().decrypt(apiKeyRow.encryptedCredentials ?? "", `upstream:${id}`),
      ) as unknown,
    ).toBe(API_KEY);

    const dropped = await authed(
      request(httpServer)
        .patch(`/admin/upstreams/${id}`)
        .send({ authMethod: "application-default-credentials" }),
    );
    expect(dropped.status).toBe(200);
    expect(dropped.body.upstream).toMatchObject({
      authMethod: "application-default-credentials",
      hasCredentials: false,
      credentialSummary: null,
    });
    const adcRow = await upstreamRow(id);
    expect(adcRow.encryptedCredentials).toBeNull();
    expect(adcRow.credentialSummary).toBeNull();

    const backWithoutKey = await authed(
      request(httpServer)
        .patch(`/admin/upstreams/${id}`)
        .send({ authMethod: "service-account" }),
    );
    expect(backWithoutKey.status).toBe(400);
    expect((await upstreamRow(id)).authMethod).toBe("application-default-credentials");

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.UPSTREAM_UPDATED);
    expect(audits.map((audit) => audit.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authMethod: "api-key", credentialsChanged: true }),
        expect.objectContaining({
          authMethod: "application-default-credentials",
          credentialsChanged: true,
          hasCredentials: false,
        }),
      ]),
    );
    await expectNoSecretInAudits(PRIVATE_KEY);
    await expectNoSecretInAudits(API_KEY);
  });

  it("records an authentication failure when the stored service-account key is invalid", async () => {
    const created = await createUpstream(serviceAccountBody("probe"));
    const id = created.body.upstream.id as string;

    const response = await authed(
      request(httpServer)
        .post(`/admin/upstreams/${id}/test`)
        .send({ model: "gemini-2.5-flash" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({
      status: "authentication_failed",
      httpStatus: null,
    });
    expect(typeof response.body.result.message).toBe("string");
    expect(response.body.result.message.length).toBeGreaterThan(0);
    expect(Date.parse(response.body.result.checkedAt)).not.toBeNaN();
    expect(response.body.upstream).toMatchObject({
      id,
      status: "authentication_failed",
      lastCheckedAt: response.body.result.checkedAt,
    });
    expectNoSecret(response.body, PRIVATE_KEY);

    const stored = await upstreamRow(id);
    expect(stored.status).toBe("authentication_failed");
    expect(stored.lastCheckedAt).toBeInstanceOf(Date);
    expect(stored.lastCheckedAt?.toISOString()).toBe(response.body.result.checkedAt);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.UPSTREAM_TESTED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.before).toMatchObject({ status: "unknown", lastCheckedAt: null });
    expect(audits[0]?.after).toMatchObject({ status: "authentication_failed" });
    await expectNoSecretInAudits(PRIVATE_KEY);
  });

  async function login(): Promise<Session> {
    await bootstrapOwner(dataSource(), new PasswordHasher(), {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    });
    const response = await request(httpServer)
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.80")
      .send({ email: "owner@example.com", password: OWNER_PASSWORD });
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    return {
      cookieHeader: cookieHeaderValue(cookie),
      csrfToken: response.body.csrfToken,
      adminId: response.body.admin.id,
    };
  }

  function authed(req: request.Test): request.Test {
    return req.set("Cookie", session.cookieHeader).set("x-csrf-token", session.csrfToken);
  }

  function createUpstream(body: Record<string, unknown>): Promise<Response> {
    return authed(request(httpServer).post("/admin/upstreams").send(body));
  }

  function upstreamRow(id: string): Promise<Upstream> {
    return dataSource().getRepository(Upstream).findOneByOrFail({ id });
  }

  function auditsFor(action: string): Promise<AuditLog[]> {
    return dataSource().getRepository(AuditLog).find({ where: { action } });
  }

  async function expectNoSecretInAudits(secret: string): Promise<void> {
    const audits = await dataSource().getRepository(AuditLog).find();
    expectNoSecret(audits, secret);
  }

  function cipherFromEnv(): CredentialCipher {
    return new CredentialCipher(requiredApp().get(ConfigService).env.CREDENTIALS_ENCRYPTION_KEY);
  }

  function dataSource(): DataSource {
    return requiredApp().get(DataSource);
  }

  function requiredApp(): NestExpressApplication {
    if (app === undefined) {
      throw new Error("e2e app was not started");
    }
    return app;
  }
});

function adcBody(name: string, priority?: number): Record<string, unknown> {
  return {
    name,
    projectId: PROJECT_ID,
    location: "us-central1",
    authMethod: "application-default-credentials",
    ...(priority === undefined ? {} : { priority }),
  };
}

function serviceAccount(email: string, privateKey: string): Record<string, unknown> {
  return {
    type: "service_account",
    project_id: PROJECT_ID,
    private_key_id: "kid-123",
    client_email: email,
    client_id: "1234567890",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${email}`,
    universe_domain: "googleapis.com",
    private_key: privateKey,
  };
}

function serviceAccountBody(name: string): Record<string, unknown> {
  return {
    name,
    projectId: PROJECT_ID,
    location: "us-central1",
    authMethod: "service-account",
    credentials: serviceAccount(CLIENT_EMAIL, PRIVATE_KEY),
  };
}

function expectNestError(response: Response, status: number, message: string, error: string): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ statusCode: status, message, error });
  expect(response.body).not.toHaveProperty("stack");
}

function expectNoSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}
