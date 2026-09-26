import { vi } from "vitest";
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
  UpstreamConnectionTestResult,
} from "../src/upstreams/providers/upstream-provider.js";
import { UPSTREAM_ABORTED_IN_FLIGHT, UpstreamError } from "../src/upstreams/providers/upstream-errors.js";
import { setQuotaRetryDelaysForTests } from "../src/routing/index.js";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };

/** Answers 429 "Resource exhausted" for the first `failures` calls, like Vertex's shared capacity. */
class BusyProvider implements AIUpstreamProvider {
  calls = 0;
  failures = 0;
  failWith: () => Error = () => new UpstreamError("Resource exhausted.", { kind: "quota_exhausted", httpStatus: 429 });

  private async enter(): Promise<void> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      throw this.failWith();
    }
  }

  async generateContent(): Promise<JsonObject> {
    await this.enter();
    return { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], usageMetadata: USAGE };
  }

  async streamGenerateContent(): Promise<ReadableStream<Uint8Array>> {
    await this.enter();
    const event = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: USAGE })}\n\n`;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event));
        controller.close();
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

class BusyFactory extends UpstreamProviderFactory {
  provider = new BusyProvider();

  forUpstream(): AIUpstreamProvider {
    return this.provider;
  }
}

describe("Retries after Vertex capacity 429s (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let factory: BusyFactory;
  let secret: string;
  let keyId: string;

  beforeAll(async () => {
    setQuotaRetryDelaysForTests([5, 10, 20]);
    factory = new BusyFactory({} as CredentialCipher);
    app = await createE2eApp({ overrides: [{ provide: UpstreamProviderFactory, useValue: factory }] });
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    setQuotaRetryDelaysForTests(null);
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    factory.provider = new BusyProvider();
    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), { email: "owner@example.com", password: "correct-horse-1" });
    const http = app.getHttpServer();
    const login = await request(http).post("/admin/auth/login").set("X-Forwarded-For", "203.0.113.60").send({ email: "owner@example.com", password: "correct-horse-1" }).expect(200);
    const parsed = sessionCookie(login);
    const admin = (path: string) => request(http).post(path).set("Cookie", `${parsed.name}=${parsed.value}`).set("x-csrf-token", login.body.csrfToken);
    const upstream = await admin("/admin/upstreams").send({ name: "Vertex", projectId: "test-project", location: "us-central1", authMethod: "application-default-credentials" }).expect(201);
    const model = await admin("/admin/models").send({ publicName: "gemini-busy", upstreamModelName: "gemini-3.7-flash", displayName: "Busy", upstreamId: upstream.body.upstream.id, enabled: true, supportsStreaming: true }).expect(201);
    for (const [billingDimension, price] of [["input_tokens", "1.00"], ["output_tokens", "2.00"]]) {
      await admin(`/admin/models/${model.body.model.id}/pricing`).send({ billingDimension, unitSize: "1000000", price, currency: "USD" }).expect(201);
    }
    const key = await admin("/admin/api-keys").send({ name: "Busy key" }).expect(201);
    await admin(`/admin/api-keys/${key.body.apiKey.id}/credits`).send({ type: "credit_added", amount: "5.00", description: "Busy tests" }).expect(201);
    secret = key.body.rawKey;
    keyId = key.body.apiKey.id;
  });

  function generate(action = "generateContent") {
    return request(app.getHttpServer())
      .post(`/v1beta/models/gemini-busy:${action}`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "hi" }] }] });
  }

  async function usageStatuses(): Promise<string[]> {
    const rows: { status: string }[] = await dataSource.query("SELECT status FROM usage_records WHERE api_key_id = $1", [keyId]);
    return rows.map((row) => row.status);
  }

  it("retries the same upstream until Vertex has capacity again, and bills once", async () => {
    factory.provider.failures = 2;

    const res = await generate().expect(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe("ok");
    expect(factory.provider.calls).toBe(3);
    expect(await usageStatuses()).toEqual(["success"]);
  });

  it("gives up after the last retry with the Gemini 429, charging nothing", async () => {
    factory.provider.failures = 99;

    const res = await generate().expect(429);
    expect(res.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(factory.provider.calls).toBe(4);
    expect(await usageStatuses()).toEqual([]);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
  });

  it("retries a stream while connecting, before any byte is sent", async () => {
    factory.provider.failures = 1;

    const res = await generate("streamGenerateContent?alt=sse").expect(200);
    expect(res.text).toContain('"text":"ok"');
    expect(factory.provider.calls).toBe(2);
    await vi.waitFor(async () => expect(await usageStatuses()).toEqual(["success"]));
  });

  it("retries a connection that was never established", async () => {
    factory.provider.failures = 1;
    factory.provider.failWith = () =>
      new UpstreamError("Unable to reach the upstream.", { kind: "network_error", httpStatus: null, causeCode: "ETIMEDOUT" });

    await generate().expect(200);
    expect(factory.provider.calls).toBe(2);
    expect(await usageStatuses()).toEqual(["success"]);
  });

  it("never repeats a request that may already have reached Vertex", async () => {
    factory.provider.failures = 1;
    factory.provider.failWith = () =>
      new UpstreamError("Unable to reach the upstream.", { kind: "network_error", httpStatus: null, reason: UPSTREAM_ABORTED_IN_FLIGHT });

    await generate().expect(503);
    expect(factory.provider.calls).toBe(1);
  });

  it("does not retry errors other than a capacity 429", async () => {
    factory.provider.failures = 1;
    factory.provider.failWith = () => new UpstreamError("Bad request.", { kind: "upstream_error", httpStatus: 400 });

    await generate().expect(400);
    expect(factory.provider.calls).toBe(1);
  });
});
