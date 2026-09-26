import { vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { Upstream } from "@gateway/database";
import type { CredentialCipher } from "@gateway/shared";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import type {
  AIUpstreamProvider,
  JsonObject,
  ProviderModelInfo,
  UpstreamCallOptions,
  UpstreamConnectionTestResult,
} from "../src/upstreams/providers/upstream-provider.js";
import {
  UPSTREAM_ABORTED_IN_FLIGHT,
  UpstreamError,
} from "../src/upstreams/providers/upstream-errors.js";
import { MetricsRegistry } from "../src/metrics/metrics.registry.js";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };

/** One fake per upstream id, so a test can make a single route fail. */
class RoutedFakeProvider implements AIUpstreamProvider {
  calls = 0;
  failWith: Error | null = null;

  constructor(private readonly upstreamName: string) {}

  private async enter(): Promise<void> {
    this.calls += 1;
    if (this.failWith) {
      throw this.failWith;
    }
  }

  async generateContent(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<JsonObject> {
    await this.enter();
    return {
      candidates: [{ content: { role: "model", parts: [{ text: `from ${this.upstreamName}` }] } }],
      usageMetadata: USAGE,
    };
  }

  async streamGenerateContent(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<ReadableStream<Uint8Array>> {
    await this.enter();
    const body = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `from ${this.upstreamName}` }] } }], usageMetadata: USAGE })}\n\n`;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
  }

  async countTokens(): Promise<JsonObject> {
    await this.enter();
    return { totalTokens: 3 };
  }

  async listModels(): Promise<{ models: ProviderModelInfo[] }> {
    return { models: [] };
  }

  async getModel(model: string): Promise<ProviderModelInfo> {
    return { id: model };
  }

  async embedContent(): Promise<{ response: JsonObject; inputTokens: number | null }> {
    await this.enter();
    return { response: { embedding: { values: [0.1] } }, inputTokens: 3 };
  }

  async testConnection(): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}

class RoutedFakeFactory extends UpstreamProviderFactory {
  readonly providers = new Map<string, RoutedFakeProvider>();

  forUpstream(upstream: Upstream): AIUpstreamProvider {
    let provider = this.providers.get(upstream.id);
    if (!provider) {
      provider = new RoutedFakeProvider(upstream.name);
      this.providers.set(upstream.id, provider);
    }
    return provider;
  }

  provider(upstreamId: string): RoutedFakeProvider {
    const provider = this.providers.get(upstreamId) ?? new RoutedFakeProvider(upstreamId);
    this.providers.set(upstreamId, provider);
    return provider;
  }
}

function networkError(): UpstreamError {
  return new UpstreamError("Unable to reach the upstream.", { kind: "network_error", httpStatus: null });
}

describe("Routing (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let factory: RoutedFakeFactory;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    factory = new RoutedFakeFactory({} as CredentialCipher);
    app = await createE2eApp({ overrides: [{ provide: UpstreamProviderFactory, useValue: factory }] });
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    factory.providers.clear();
    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), { email: "owner@example.com", password: "correct-horse-1" });
    const login = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.20")
      .send({ email: "owner@example.com", password: "correct-horse-1" })
      .expect(200);
    const parsed = sessionCookie(login);
    cookie = `${parsed.name}=${parsed.value}`;
    csrf = login.body.csrfToken;
  });

  function admin(method: "get" | "post" | "put" | "patch", path: string) {
    const req = request(app.getHttpServer())[method](path).set("Cookie", cookie);
    return method === "get" ? req : req.set("x-csrf-token", csrf);
  }

  async function createUpstream(name: string): Promise<string> {
    const res = await admin("post", "/admin/upstreams")
      .send({ name, projectId: "test-project", location: "us-central1", authMethod: "application-default-credentials" })
      .expect(201);
    return res.body.upstream.id;
  }

  /** A priced, streaming-capable model on upstream A, plus a second upstream B. */
  async function setup() {
    const a = await createUpstream("Vertex A");
    const b = await createUpstream("Vertex B");
    const model = await admin("post", "/admin/models")
      .send({ publicName: "gemini-routed", upstreamModelName: "gemini-2.5-flash", displayName: "Routed", upstreamId: a, enabled: true, supportsStreaming: true, supportsEmbeddings: true })
      .expect(201);
    const modelId: string = model.body.model.id;
    for (const [billingDimension, price] of [["input_tokens", "1.00"], ["output_tokens", "2.00"]]) {
      await admin("post", `/admin/models/${modelId}/pricing`).send({ billingDimension, unitSize: "1000000", price, currency: "USD" }).expect(201);
    }
    const key = await admin("post", "/admin/api-keys").send({ name: "Routing key" }).expect(201);
    await admin("post", `/admin/api-keys/${key.body.apiKey.id}/credits`)
      .send({ type: "credit_added", amount: "5.00", description: "Routing tests" })
      .expect(201);
    return { a, b, modelId, secret: key.body.rawKey as string, keyId: key.body.apiKey.id as string };
  }

  function routes(modelId: string, strategy: string, rows: { upstreamId: string; priority: number; enabled?: boolean }[]) {
    return admin("put", `/admin/models/${modelId}/routes`).send({
      strategy,
      routes: rows.map((row) => ({ enabled: true, ...row })),
    });
  }

  function generate(secret: string) {
    return request(app.getHttpServer())
      .post("/v1beta/models/gemini-routed:generateContent")
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "hi" }] }] });
  }

  function replyText(body: { candidates?: { content?: { parts?: { text?: string }[] } }[] }): string | undefined {
    return body.candidates?.[0]?.content?.parts?.[0]?.text;
  }

  async function usageUpstreams(keyId: string): Promise<string[]> {
    const rows: { upstream_id: string }[] = await dataSource.query("SELECT upstream_id FROM usage_records WHERE api_key_id = $1", [keyId]);
    return rows.map((row) => row.upstream_id);
  }

  function upstreamFailures(kind: string): number {
    const text = app.get(MetricsRegistry).renderPrometheus();
    const match = new RegExp(`^gateway_upstream_failures_total\\{kind="${kind}"\\} (\\d+)$`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  }

  describe("admin routes API", () => {
    it("shows the model's own upstream as the default route", async () => {
      const { a, modelId } = await setup();
      const res = await admin("get", `/admin/models/${modelId}/routes`).expect(200);
      expect(res.body).toEqual({
        strategy: "priority",
        routes: [expect.objectContaining({ upstreamId: a, upstreamName: "Vertex A", priority: 0, isDefault: true, enabled: true })],
      });
    });

    it("replaces the route set, reports it on the model and audits the change", async () => {
      const { a, b, modelId } = await setup();
      const res = await routes(modelId, "fallback", [{ upstreamId: b, priority: 5 }]).expect(200);
      expect(res.body.strategy).toBe("fallback");
      expect(res.body.routes.map((r: { upstreamId: string; isDefault: boolean }) => [r.upstreamId, r.isDefault])).toEqual([
        [a, true],
        [b, false],
      ]);

      const model = await admin("get", `/admin/models/${modelId}`).expect(200);
      expect(model.body.model ?? model.body).toEqual(expect.objectContaining({ routeCount: 2, strategy: "fallback" }));

      const audit = await dataSource.query("SELECT action, after FROM audit_logs WHERE action = 'admin.model.routes_updated'");
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toEqual({ strategy: "fallback", routes: [{ upstreamId: b, priority: 5, enabled: true }] });
    });

    it.each([
      ["an unknown strategy", (b: string) => ({ strategy: "random", routes: [{ upstreamId: b, priority: 1, enabled: true }] })],
      ["a duplicate upstream", (b: string) => ({ strategy: "priority", routes: [{ upstreamId: b, priority: 1, enabled: true }, { upstreamId: b, priority: 2, enabled: true }] })],
      ["an out-of-range priority", (b: string) => ({ strategy: "priority", routes: [{ upstreamId: b, priority: 1001, enabled: true }] })],
      ["an unknown upstream", () => ({ strategy: "priority", routes: [{ upstreamId: "00000000-0000-4000-8000-000000000000", priority: 1, enabled: true }] })],
    ])("rejects %s", async (_name, body) => {
      const { b, modelId } = await setup();
      await admin("put", `/admin/models/${modelId}/routes`).send(body(b)).expect(400);
    });

    it("requires a session and the CSRF token", async () => {
      const { b, modelId } = await setup();
      const body = { strategy: "priority", routes: [{ upstreamId: b, priority: 1, enabled: true }] };
      await request(app.getHttpServer()).put(`/admin/models/${modelId}/routes`).send(body).expect(401);
      await request(app.getHttpServer()).put(`/admin/models/${modelId}/routes`).set("Cookie", cookie).send(body).expect(403);
    });
  });

  describe("request routing", () => {
    it("priority sends every request to the lowest priority number", async () => {
      const { a, b, secret, modelId, keyId } = await setup();
      await routes(modelId, "priority", [{ upstreamId: a, priority: 10 }, { upstreamId: b, priority: 1 }]).expect(200);

      for (let i = 0; i < 2; i += 1) {
        const res = await generate(secret).expect(200);
        expect(replyText(res.body)).toBe("from Vertex B");
      }
      expect(factory.provider(a).calls).toBe(0);
      expect(await usageUpstreams(keyId)).toEqual([b, b]);
    });

    it("round_robin alternates between the routes", async () => {
      const { b, secret, modelId } = await setup();
      await routes(modelId, "round_robin", [{ upstreamId: b, priority: 0 }]).expect(200);

      const served: (string | undefined)[] = [];
      for (let i = 0; i < 4; i += 1) {
        served.push(replyText((await generate(secret).expect(200)).body));
      }
      expect(new Set(served)).toEqual(new Set(["from Vertex A", "from Vertex B"]));
      expect(served[0]).not.toBe(served[1]);
      expect(served[0]).toBe(served[2]);
      expect(served[1]).toBe(served[3]);
    });

    it("manual never falls back", async () => {
      const { a, b, secret, modelId } = await setup();
      await routes(modelId, "manual", [{ upstreamId: b, priority: 5 }]).expect(200);
      factory.provider(a).failWith = networkError();

      const res = await generate(secret).expect(503);
      expect(res.body.error.status).toBe("UNAVAILABLE");
      expect(factory.provider(b).calls).toBe(0);
    });

    it("fallback moves to the next upstream after a retryable failure and bills only the one that served", async () => {
      const { a, b, secret, modelId, keyId } = await setup();
      await routes(modelId, "fallback", [{ upstreamId: b, priority: 5 }]).expect(200);
      factory.provider(a).failWith = networkError();
      const failuresBefore = upstreamFailures("network_error");

      const res = await generate(secret).expect(200);
      expect(replyText(res.body)).toBe("from Vertex B");
      expect(factory.provider(a).calls).toBe(1);
      expect(await usageUpstreams(keyId)).toEqual([b]);
      const logs = await dataSource.query("SELECT upstream, status FROM request_logs WHERE api_key_id = $1", [keyId]);
      expect(logs).toEqual([{ upstream: "Vertex B", status: "success" }]);
      const debits = await dataSource.query("SELECT amount FROM credit_transactions WHERE api_key_id = $1 AND type = 'cost_consumed'", [keyId]);
      expect(debits).toHaveLength(1);
      expect(upstreamFailures("network_error")).toBe(failuresBefore + 1);
      expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    });

    it.each([
      ["an authentication failure", () => new UpstreamError("Authentication failed.", { kind: "authentication_failed", httpStatus: 401 }), 503],
      ["an upstream 400", () => new UpstreamError("Bad request.", { kind: "upstream_error", httpStatus: 400 }), 400],
      [
        "a request cancelled in flight",
        () => new UpstreamError("Cancelled.", { kind: "network_error", httpStatus: null, reason: UPSTREAM_ABORTED_IN_FLIGHT }),
        503,
      ],
    ])("fallback does not retry %s", async (_name, error, status) => {
      const { a, b, secret, modelId } = await setup();
      await routes(modelId, "fallback", [{ upstreamId: b, priority: 5 }]).expect(200);
      factory.provider(a).failWith = error();

      await generate(secret).expect(status);
      expect(factory.provider(b).calls).toBe(0);
    });

    it("a failed upstream call leaves no usage record, only the request log", async () => {
      const { a, secret, keyId } = await setup();
      factory.provider(a).failWith = new UpstreamError("Unavailable.", { kind: "upstream_error", httpStatus: 503 });

      await generate(secret).expect(502);
      expect(await usageUpstreams(keyId)).toEqual([]);
      const logs = await dataSource.query("SELECT upstream, status FROM request_logs WHERE api_key_id = $1", [keyId]);
      expect(logs).toEqual([{ upstream: "Vertex A", status: "error" }]);
      expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    });

    it("a request cancelled in flight keeps a cost-undetermined usage record", async () => {
      const { a, secret, keyId } = await setup();
      factory.provider(a).failWith = new UpstreamError("Cancelled.", { kind: "network_error", httpStatus: null, reason: UPSTREAM_ABORTED_IN_FLIGHT });

      await generate(secret).expect(503);
      const rows = await dataSource.query("SELECT upstream_id, status, cost_undetermined FROM usage_records WHERE api_key_id = $1", [keyId]);
      expect(rows).toEqual([{ upstream_id: a, status: "error", cost_undetermined: true }]);
    });

    it("serves through a route when the model's own upstream is disabled", async () => {
      const { a, b, secret, modelId } = await setup();
      await routes(modelId, "priority", [{ upstreamId: b, priority: 5 }]).expect(200);
      await admin("patch", `/admin/upstreams/${a}`).send({ enabled: false }).expect(200);

      const res = await generate(secret).expect(200);
      expect(replyText(res.body)).toBe("from Vertex B");
    });

    it("answers 404 when no route is usable", async () => {
      const { a, secret } = await setup();
      await admin("patch", `/admin/upstreams/${a}`).send({ enabled: false }).expect(200);

      const res = await generate(secret).expect(404);
      expect(res.body.error.status).toBe("NOT_FOUND");
    });

    it("streaming falls back while connecting, before any byte is sent", async () => {
      const { a, b, secret, modelId, keyId } = await setup();
      await routes(modelId, "fallback", [{ upstreamId: b, priority: 5 }]).expect(200);
      factory.provider(a).failWith = networkError();

      const res = await request(app.getHttpServer())
        .post("/v1beta/models/gemini-routed:streamGenerateContent?alt=sse")
        .set("x-goog-api-key", secret)
        .send({ contents: [{ parts: [{ text: "hi" }] }] })
        .expect(200);
      expect(res.text).toContain("from Vertex B");
      await vi.waitFor(async () => expect(await usageUpstreams(keyId)).toEqual([b]));
    });

    it("countTokens and embedContent route the same way", async () => {
      const { a, b, secret, modelId } = await setup();
      await routes(modelId, "fallback", [{ upstreamId: b, priority: 5 }]).expect(200);
      factory.provider(a).failWith = networkError();

      await request(app.getHttpServer())
        .post("/v1beta/models/gemini-routed:countTokens")
        .set("x-goog-api-key", secret)
        .send({ contents: [{ parts: [{ text: "hi" }] }] })
        .expect(200);
      await request(app.getHttpServer())
        .post("/v1beta/models/gemini-routed:embedContent")
        .set("x-goog-api-key", secret)
        .send({ content: { parts: [{ text: "hi" }] } })
        .expect(200);
      expect(factory.provider(b).calls).toBe(2);
    });
  });
});
