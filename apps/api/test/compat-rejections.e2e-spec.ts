import { vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { ApiKey, type Upstream } from "@gateway/database";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import type {
  AIUpstreamProvider,
  JsonObject,
  ProviderModelInfo,
  UpstreamCallOptions,
  UpstreamConnectionTestResult,
} from "../src/upstreams/providers/upstream-provider.js";
import { UpstreamError, UPSTREAM_ABORTED_IN_FLIGHT } from "../src/upstreams/providers/upstream-errors.js";

const HELLO = { contents: [{ parts: [{ text: "Hello" }] }] };

interface RecordedCall {
  method: string;
  model: string;
  request: JsonObject;
}

class FakeAIUpstreamProvider implements AIUpstreamProvider {
  calls: RecordedCall[] = [];
  errorToThrow: Error | null = null;
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  // The in-flight request must not finish on a timer: the second request has to
  // observe the held slot, and a short delay races a slow machine.
  hold(): () => void {
    let release = (): void => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseGate = release;
    return () => {
      this.releaseGate?.();
      this.releaseGate = null;
      this.gate = null;
    };
  }

  reset(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
    this.calls = [];
    this.errorToThrow = null;
  }

  async generateContent(
    model: string,
    body: JsonObject,
    _options?: UpstreamCallOptions,
  ): Promise<JsonObject> {
    this.calls.push({ method: "generateContent", model, request: body });
    const gate = this.gate;
    if (gate) {
      await gate;
    }
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };
  }

  async streamGenerateContent(
    model: string,
    body: JsonObject,
    _options?: UpstreamCallOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    this.calls.push({ method: "streamGenerateContent", model, request: body });
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return new ReadableStream({
      start(controller) {
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
    return { response: { embedding: [0.1] }, inputTokens: 1 };
  }

  async testConnection(): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}

class FakeUpstreamProviderFactory extends UpstreamProviderFactory {
  readonly fake = new FakeAIUpstreamProvider();

  forUpstream(_upstream: Upstream): AIUpstreamProvider {
    return this.fake;
  }
}

function expectGemini(res: Response, status: number, googleStatus: string, message: string): void {
  expect(res.status).toBe(status);
  expect(res.headers["content-type"]).toContain("application/json");
  expect(res.text.startsWith("data:")).toBe(false);
  expect(res.body).toEqual({
    error: { code: status, message, status: googleStatus },
  });
}

describe("compat rejections (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let cookie: string;
  let csrfToken: string;
  let fakeFactory: FakeUpstreamProviderFactory;

  beforeAll(async () => {
    fakeFactory = new FakeUpstreamProviderFactory({} as import("@gateway/shared").CredentialCipher);
    app = await createE2eApp({
      overrides: [{ provide: UpstreamProviderFactory, useValue: fakeFactory }],
    });
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    fakeFactory.fake.reset();

    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), {
      email: "owner@example.com",
      password: "correct-horse-1",
    });

    const login = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "owner@example.com", password: "correct-horse-1" });
    if (login.status !== 200) {
      throw new Error(`Login failed with status ${login.status}: ${JSON.stringify(login.body)}`);
    }
    const parsed = sessionCookie(login);
    cookie = `${parsed.name}=${parsed.value}`;
    csrfToken = login.body.csrfToken as string;
  });

  async function createModel(options?: { enabled?: boolean; priced?: boolean }): Promise<string> {
    const enabled = options?.enabled ?? true;
    const priced = options?.priced ?? true;
    const upstream = await request(app.getHttpServer())
      .post("/admin/upstreams")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        provider: "vertex-ai",
        projectId: "test-project",
        location: "us-central1",
        authMethod: "application-default-credentials",
        name: "Test Upstream",
      })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post("/admin/models")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        upstreamId: upstream.body.upstream.id as string,
        upstreamModelName: "gemini-1.5-pro",
        publicName: "gemini-1.5-pro",
        displayName: "Gemini Pro",
        supportsText: true,
        supportsStreaming: true,
        enabled,
      })
      .expect(201);
    const modelId = created.body.model.id as string;

    if (priced) {
      for (const rule of [
        { billingDimension: "input_tokens", price: "1.25" },
        { billingDimension: "output_tokens", price: "3.75" },
      ]) {
        await request(app.getHttpServer())
          .post(`/admin/models/${modelId}/pricing`)
          .set("Cookie", cookie)
          .set("x-csrf-token", csrfToken)
          .send({
            ...rule,
            unitSize: "1000000",
            currency: "USD",
            effectiveFrom: new Date().toISOString(),
          })
          .expect(201);
      }
    }

    return "gemini-1.5-pro";
  }

  async function createKey(input: {
    amount?: string;
    limits?: Record<string, unknown>;
  } = {}): Promise<{ keyId: string; secret: string }> {
    const amount = input.amount ?? "10.00";
    const created = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ name: "Test Key", ...input.limits })
      .expect(201);
    const keyId = created.body.apiKey.id as string;
    const secret = created.body.rawKey as string;
    if (amount !== "0") {
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${keyId}/credits`)
        .set("Cookie", cookie)
        .set("x-csrf-token", csrfToken)
        .send({ type: "credit_added", amount, description: "Initial test credit" })
        .expect(201);
    }
    return { keyId, secret };
  }

  function generate(publicName: string, secret: string): request.Test {
    return request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(HELLO);
  }

  function stream(publicName: string, secret: string): request.Test {
    return request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent?alt=sse`)
      .set("x-goog-api-key", secret)
      .send(HELLO);
  }

  async function expectBoth(
    publicName: string,
    secret: string,
    status: number,
    googleStatus: string,
    message: string,
  ): Promise<void> {
    const generated = await generate(publicName, secret);
    expectGemini(generated, status, googleStatus, message);
    const streamed = await stream(publicName, secret);
    expectGemini(streamed, status, googleStatus, message);
    expect(fakeFactory.fake.calls).toHaveLength(0);
  }

  it("rejects an invalid key before calling the upstream", async () => {
    const publicName = await createModel();
    const unknownKey = `lvg_${"a".repeat(32)}`;
    await expectBoth(
      publicName,
      unknownKey,
      401,
      "UNAUTHENTICATED",
      "API key not valid. Please pass a valid API key.",
    );
  });

  it("rejects a revoked key before calling the upstream", async () => {
    const publicName = await createModel();
    const { keyId, secret } = await createKey();
    await request(app.getHttpServer())
      .post(`/admin/api-keys/${keyId}/revoke`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(201);

    const res = await generate(publicName, secret);
    expectGemini(res, 403, "PERMISSION_DENIED", "API key has been revoked.");
    expect(fakeFactory.fake.calls).toHaveLength(0);
  });

  it("rejects an expired key before calling the upstream", async () => {
    const publicName = await createModel();
    const { keyId, secret } = await createKey();
    // Create only accepts a future expiresAt, so the row has to be backdated.
    await dataSource.getRepository(ApiKey).update(keyId, {
      expiresAt: new Date(Date.now() - 10_000),
    });

    const res = await generate(publicName, secret);
    expectGemini(res, 403, "PERMISSION_DENIED", "API key has expired.");
    expect(fakeFactory.fake.calls).toHaveLength(0);
  });

  it("rejects a suspended key before calling the upstream", async () => {
    const publicName = await createModel();
    const { keyId, secret } = await createKey();
    await request(app.getHttpServer())
      .post(`/admin/api-keys/${keyId}/suspend`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(201);

    const res = await generate(publicName, secret);
    expectGemini(res, 403, "PERMISSION_DENIED", "API key is suspended.");
    expect(fakeFactory.fake.calls).toHaveLength(0);
  });

  it("rejects exhausted credit before calling the upstream", async () => {
    const publicName = await createModel();
    const { secret } = await createKey({ amount: "0" });
    await expectBoth(
      publicName,
      secret,
      429,
      "RESOURCE_EXHAUSTED",
      "API key credit has been exhausted.",
    );
  });

  it("rejects the second request when the per-minute limit is 1", async () => {
    const publicName = await createModel();
    const { secret } = await createKey({ limits: { requestsPerMinute: 1 } });

    const first = await generate(publicName, secret);
    expect(first.status).toBe(200);
    expect(fakeFactory.fake.calls).toHaveLength(1);

    const second = await generate(publicName, secret);
    expectGemini(second, 429, "RESOURCE_EXHAUSTED", "Rate limit exceeded: requests per minute.");
    expect(fakeFactory.fake.calls).toHaveLength(1);
    // The limiter computes a retry window and attaches it to the exception for the filter.
    expect(second.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
  });

  it("rejects a second request while the only concurrency slot is held", async () => {
    const publicName = await createModel();
    const { secret } = await createKey({ limits: { maxConcurrentRequests: 1 } });
    const release = fakeFactory.fake.hold();

    // supertest sends only once then() runs, so the first call has to be started
    // before the second is built or they never overlap.
    const first = generate(publicName, secret).then((res) => res);
    await vi.waitFor(() => expect(fakeFactory.fake.calls).toHaveLength(1), { timeout: 5_000 });

    let secondSettled = false;
    const secondPromise = generate(publicName, secret).then((res) => {
      secondSettled = true;
      return res;
    });
    try {
      await vi.waitFor(() => {
        expect(secondSettled || fakeFactory.fake.calls.length > 1).toBe(true);
      }, { timeout: 5_000 });
      expect(fakeFactory.fake.calls).toHaveLength(1);
      expectGemini(
        await secondPromise,
        429,
        "RESOURCE_EXHAUSTED",
        "Too many concurrent requests for this API key.",
      );
    } finally {
      release();
      const [completed] = await Promise.all([first, secondPromise]);
      expect(completed.status).toBe(200);
    }
  });

  it("rejects a disabled model before calling the upstream", async () => {
    const publicName = await createModel({ enabled: false });
    const { secret } = await createKey();

    const res = await generate(publicName, secret);
    expectGemini(res, 404, "NOT_FOUND", `Model ${publicName} is not found.`);
    expect(fakeFactory.fake.calls).toHaveLength(0);
  });

  it("rejects a model excluded by the key allow-list before calling the upstream", async () => {
    const publicName = await createModel();
    const { secret } = await createKey({ limits: { allowedModels: ["other-model"] } });

    const res = await generate(publicName, secret);
    expectGemini(
      res,
      403,
      "PERMISSION_DENIED",
      `This API key is not allowed to use model ${publicName}.`,
    );
    expect(fakeFactory.fake.calls).toHaveLength(0);
  });

  it("rejects public generation when the kill switch is on", async () => {
    const publicName = await createModel();
    const { secret } = await createKey();
    await request(app.getHttpServer())
      .put("/admin/settings")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ "gateway.killSwitch": true })
      .expect(200);

    await expectBoth(
      publicName,
      secret,
      503,
      "UNAVAILABLE",
      "The gateway is temporarily disabled.",
    );
  });

  it("maps upstream network and authentication failures", async () => {
    const publicName = await createModel();
    const { secret } = await createKey();

    // A reset after sending, as the provider reports it: possibly delivered, so never repeated.
    fakeFactory.fake.errorToThrow = new UpstreamError("ECONNRESET", {
      kind: "network_error",
      httpStatus: null,
      reason: UPSTREAM_ABORTED_IN_FLIGHT,
    });
    const network = await generate(publicName, secret);
    expectGemini(network, 503, "UNAVAILABLE", "The model is temporarily unavailable.");
    expect(network.body.error.message).not.toContain("ECONNRESET");
    expect(fakeFactory.fake.calls).toHaveLength(1);

    fakeFactory.fake.calls = [];
    fakeFactory.fake.errorToThrow = new UpstreamError("provider rejected the credential", {
      kind: "authentication_failed",
      httpStatus: 401,
    });
    const authentication = await generate(publicName, secret);
    expectGemini(authentication, 503, "UNAVAILABLE", "The model is temporarily unavailable.");
    expect(authentication.body.error.message).not.toContain("credential");
    expect(fakeFactory.fake.calls).toHaveLength(1);
  });
});
