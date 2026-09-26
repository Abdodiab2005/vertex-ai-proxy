import { vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
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

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };

/** A unary call that takes `delayMs`, and a stream that sends one event and then stays open. */
class SlowProvider implements AIUpstreamProvider {
  delayMs = 0;
  calls = 0;

  async generateContent(_model: string, _request: JsonObject, options?: UpstreamCallOptions): Promise<JsonObject> {
    this.calls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    options?.signal?.throwIfAborted();
    return { candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }], usageMetadata: USAGE };
  }

  async streamGenerateContent(_model: string, _request: JsonObject, options?: UpstreamCallOptions): Promise<ReadableStream<Uint8Array>> {
    this.calls += 1;
    const first = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "1" }] } }], usageMetadata: USAGE })}\n\n`;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        options?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
  }

  async countTokens(): Promise<JsonObject> {
    return { totalTokens: 1 };
  }

  async listModels(): Promise<{ models: ProviderModelInfo[] }> {
    return { models: [] };
  }

  async getModel(model: string): Promise<ProviderModelInfo> {
    return { id: model };
  }

  async embedContent(): Promise<{ response: JsonObject; inputTokens: number | null }> {
    return { response: {}, inputTokens: null };
  }

  async testConnection(): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}

class SlowFactory extends UpstreamProviderFactory {
  readonly provider = new SlowProvider();

  forUpstream(): AIUpstreamProvider {
    return this.provider;
  }
}

describe("Graceful shutdown (e2e)", () => {
  let app: NestExpressApplication;
  let factory: SlowFactory;
  let baseUrl: string;
  let secret: string;
  let keyId: string;
  let checkDb: DataSource;

  // Each test shuts its own app down, so each boots one.
  beforeEach(async () => {
    process.env.SHUTDOWN_GRACE_MS = "1500";
    factory = new SlowFactory({} as CredentialCipher);
    app = await createE2eApp({ overrides: [{ provide: UpstreamProviderFactory, useValue: factory }] });
    await resetE2eState(app);
    const server: Server = await app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The app's own connection closes with it; the assertions afterwards need one of their own.
    checkDb = new DataSource({ ...app.get(DataSource).options, entities: [], migrations: [] });
    await checkDb.initialize();

    const dataSource = app.get(DataSource);
    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), { email: "owner@example.com", password: "correct-horse-1" });
    const http = app.getHttpServer();
    const login = await request(http).post("/admin/auth/login").set("X-Forwarded-For", "203.0.113.40").send({ email: "owner@example.com", password: "correct-horse-1" }).expect(200);
    const parsed = sessionCookie(login);
    const admin = (path: string) => request(http).post(path).set("Cookie", `${parsed.name}=${parsed.value}`).set("x-csrf-token", login.body.csrfToken);
    const upstream = await admin("/admin/upstreams").send({ name: "Vertex", projectId: "test-project", location: "us-central1", authMethod: "application-default-credentials" }).expect(201);
    const model = await admin("/admin/models").send({ publicName: "gemini-drain", upstreamModelName: "gemini-2.5-flash", displayName: "Drain", upstreamId: upstream.body.upstream.id, enabled: true, supportsStreaming: true }).expect(201);
    for (const [billingDimension, price] of [["input_tokens", "1.00"], ["output_tokens", "2.00"]]) {
      await admin(`/admin/models/${model.body.model.id}/pricing`).send({ billingDimension, unitSize: "1000000", price, currency: "USD" }).expect(201);
    }
    const key = await admin("/admin/api-keys").send({ name: "Drain key" }).expect(201);
    await admin(`/admin/api-keys/${key.body.apiKey.id}/credits`).send({ type: "credit_added", amount: "5.00", description: "Drain tests" }).expect(201);
    secret = key.body.rawKey;
    keyId = key.body.apiKey.id;
  });

  afterEach(async () => {
    delete process.env.SHUTDOWN_GRACE_MS;
    await checkDb.destroy();
  });

  function call(action: string): Promise<Response> {
    return fetch(`${baseUrl}/v1beta/models/gemini-drain:${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": secret },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
    });
  }

  it("finishes a request in flight, refuses new ones, and fails readiness while draining", async () => {
    factory.provider.delayMs = 600;
    const inFlight = call("generateContent");
    await vi.waitFor(() => expect(factory.provider.calls).toBe(1));

    const closing = app.close();
    await vi.waitFor(async () => {
      const refused = await call("generateContent");
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: { code: 503, message: "The gateway is restarting. Please retry.", status: "UNAVAILABLE" } });
    });
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);

    const finished = await inFlight;
    expect(finished.status).toBe(200);
    await closing;

    const usage = await checkDb.query("SELECT status FROM usage_records WHERE api_key_id = $1", [keyId]);
    expect(usage).toEqual([{ status: "success" }]);
    expect(factory.provider.calls).toBe(1);
  });

  it("cancels a stream still open after the grace period and bills what it used", async () => {
    const res = await call("streamGenerateContent?alt=sse");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value);

    const startedAt = Date.now();
    const closing = app.close();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    await closing;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
    expect(received).toContain('"message":"The gateway is restarting. Please retry.","status":"UNAVAILABLE"');
    const usage = await checkDb.query("SELECT status, input_tokens::text AS input FROM usage_records WHERE api_key_id = $1", [keyId]);
    expect(usage).toEqual([{ status: "partial", input: "10" }]);
  });
});
