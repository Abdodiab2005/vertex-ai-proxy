import { vi } from "vitest";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DataSource } from "typeorm";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import { AIUpstreamProvider, JsonObject, ProviderModelInfo, UpstreamCallOptions, UpstreamConnectionTestResult } from "../src/upstreams/providers/upstream-provider.js";
import { UpstreamError } from "../src/upstreams/providers/upstream-errors.js";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";
import { setLeaseMsForTests } from "../src/public-api/public-generation.service.js";
import request from "supertest";
import { SettingsService } from "../src/settings/settings.service.js";
import { MetricsRegistry } from "../src/metrics/metrics.registry.js";
import { RequestLimiter } from "../src/rate-limits/index.js";

class FakeAIUpstreamProvider implements AIUpstreamProvider {
  public calls: { method: string, model: string, request: JsonObject }[] = [];
  public errorToThrow: Error | null = null;
  public wasAborted = false;
  
  public streamDelayMs = 0;
  public streamChunks: JsonObject[] = [];
  public failMidStream = false;
  public streamGate: Promise<void> | null = null;

  async generateContent(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<JsonObject> {
    throw new Error("Not implemented");
  }

  async streamGenerateContent(model: string, request: JsonObject, options?: UpstreamCallOptions): Promise<ReadableStream<Uint8Array>> {
    this.calls.push({ method: "streamGenerateContent", model, request });
    if (this.errorToThrow) throw this.errorToThrow;
    
    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        this.wasAborted = true;
      });
    }

    const { streamChunks, streamDelayMs, failMidStream, streamGate } = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (streamGate) {
            await streamGate;
          }
          for (const chunk of streamChunks) {
            if (options?.signal?.aborted) {
               break;
            }
            if (streamDelayMs > 0) {
              await new Promise(r => setTimeout(r, streamDelayMs));
            }
            if (options?.signal?.aborted) {
               break;
            }
            const str = `data: ${JSON.stringify(chunk)}\n\n`;
            controller.enqueue(new TextEncoder().encode(str));
          }
          if (failMidStream && !options?.signal?.aborted) {
            controller.error(new UpstreamError("Mid-stream error", { kind: "upstream_error", httpStatus: null }));
          } else if (!options?.signal?.aborted) {
            controller.close();
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        // aborted
      }
    });
    return stream;
  }
  
  async countTokens(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<JsonObject> {
    return { totalTokens: 100 };
  }
  
  async listModels(_options?: UpstreamCallOptions): Promise<{ models: ProviderModelInfo[] }> {
    return { models: [] };
  }
  
  async getModel(model: string, _options?: UpstreamCallOptions): Promise<ProviderModelInfo> {
    return { id: model };
  }
  
  async embedContent(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<{ response: JsonObject; inputTokens: number | null }> {
    return { response: { embedding: [0.1, 0.2] }, inputTokens: 42 };
  }
  
  async testConnection(_model: string): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}

class FakeUpstreamProviderFactory extends UpstreamProviderFactory {
  public fakeProvider = new FakeAIUpstreamProvider();
  
  forUpstream(): AIUpstreamProvider {
    return this.fakeProvider;
  }
}

describe("Streaming (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let cookie: string;
  let fakeFactory: FakeUpstreamProviderFactory;
  let csrfToken: string;
  let server: import("http").Server;
  let serverUrl: string;
  let settingsService: SettingsService;
  
  beforeAll(async () => {
    fakeFactory = new FakeUpstreamProviderFactory({} as import("@gateway/shared").CredentialCipher);
    app = await createE2eApp({
      overrides: [
        { provide: UpstreamProviderFactory, useValue: fakeFactory }
      ]
    });
    dataSource = app.get(DataSource);
    settingsService = app.get(SettingsService);
    await app.init();
    
    server = await app.listen(0);
    const port = (server.address() as import("net").AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;
  });
  
  afterAll(async () => {
    await app.close();
    if (server) {
       await new Promise(r => server.close(r));
    }
  });
  
  beforeEach(async () => {
    await resetE2eState(app);
    fakeFactory.fakeProvider.calls = [];
    fakeFactory.fakeProvider.errorToThrow = null;
    fakeFactory.fakeProvider.streamDelayMs = 0;
    fakeFactory.fakeProvider.streamChunks = [];
    fakeFactory.fakeProvider.failMidStream = false;
    fakeFactory.fakeProvider.wasAborted = false;
    fakeFactory.fakeProvider.streamGate = null;
    setLeaseMsForTests(null);

    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), {
      email: "owner@example.com",
      password: "correct-horse-1",
    });

    const loginRes = await request(app.getHttpServer())
      .post("/admin/auth/login").set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "owner@example.com", password: "correct-horse-1" });
    if (loginRes.status !== 200) { throw new Error("Login failed " + loginRes.status + " " + JSON.stringify(loginRes.body)); }
    const parsedCookie = sessionCookie(loginRes);
    cookie = `${parsedCookie.name}=${parsedCookie.value}`;
    csrfToken = loginRes.body.csrfToken;
    await settingsService.update({ "timeouts.streamIdleMs": 60000 }, { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null });
  });

  async function createUpstreamAndModel(supportsStreaming = true, enabled = true) {
    const upRes = await request(app.getHttpServer())
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
    
    const upstreamId = upRes.body.upstream.id;
    
    const modRes = await request(app.getHttpServer())
      .post(`/admin/models`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        upstreamId,
        upstreamModelName: "gemini-1.5-pro",
        publicName: enabled ? "gemini-1.5-pro" : "disabled-model",
        displayName: "Gemini Pro",
        supportsText: true,
        supportsEmbeddings: true,
        supportsStreaming,
      })
      .expect(201);
      
    const modelId = modRes.body.model.id;
    
    await request(app.getHttpServer())
      .patch(`/admin/models/${modelId}`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ enabled })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/models/${modelId}/pricing`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        billingDimension: "input_tokens",
        unitSize: "1000000",
        price: "1.25",
        currency: "USD",
        effectiveFrom: new Date().toISOString()
      })
      .expect(201);
      
    await request(app.getHttpServer())
      .post(`/admin/models/${modelId}/pricing`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        billingDimension: "output_tokens",
        unitSize: "1000000",
        price: "3.75",
        currency: "USD",
        effectiveFrom: new Date().toISOString()
      })
      .expect(201);
      
    return { upstreamId, modelId, publicName: enabled ? "gemini-1.5-pro" : "disabled-model" };
  }

  async function createKeyAndAddCredit(amount = "10.00", settings: Record<string, unknown> = {}) {
    const keyRes = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ name: "Test Key", ...settings })
      .expect(201);
      
    const keyId = keyRes.body.apiKey.id;
    const secret = keyRes.body.rawKey;
    
    if (amount !== "0.00" && amount !== "0") {
      await request(app.getHttpServer())
        .post(`/admin/api-keys/${keyId}/credits`)
        .set("Cookie", cookie)
        .set("x-csrf-token", csrfToken)
        .send({ type: "credit_added", amount, description: "Initial test credit" })
        .expect(201);
    }
      
    return { keyId, secret };
  }

  function streamRequest(publicName: string, secret: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${serverUrl}/v1beta/models/${publicName}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": secret },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] }),
      signal,
    });
  }

  function sseBytes(events: JsonObject[]): string {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  }

  function activeStreams(): number {
    const match = /^gateway_active_streams (\d+)$/m.exec(app.get(MetricsRegistry).renderPrometheus());
    return Number(match?.[1]);
  }

  async function usageRecords(keyId: string): Promise<{ status: string; input: string | null; output: string | null; cost: string | null }[]> {
    return dataSource.query(
      "SELECT status, input_tokens::text AS input, output_tokens::text AS output, calculated_cost::text AS cost FROM usage_records WHERE api_key_id = $1",
      [keyId],
    );
  }

  const USAGE = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 };

  it("delivers chunks progressively and unchanged, then settles from the last usageMetadata", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();

    const events: JsonObject[] = [
      { candidates: [{ content: { parts: [{ text: "1" }] } }], usageMetadata: { promptTokenCount: 100 } },
      { candidates: [{ content: { parts: [{ text: "2" }] } }] },
      { candidates: [{ content: { parts: [{ text: "3" }] } }] },
      { candidates: [{ content: { parts: [{ text: "4" }] } }] },
      { candidates: [{ content: { parts: [{ text: "5" }] } }], usageMetadata: USAGE },
    ];
    fakeFactory.fakeProvider.streamDelayMs = 200;
    fakeFactory.fakeProvider.streamChunks = events;

    const startedAt = Date.now();
    const res = await streamRequest(publicName, secret);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("content-encoding")).toBeNull();

    const arrivals: number[] = [];
    const decoder = new TextDecoder();
    let received = "";
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - startedAt);
      received += decoder.decode(value, { stream: true });
    }

    // The fake emits at ~200, 400, ..., 1000 ms: a buffering relay would deliver everything at ~1000.
    expect(arrivals[0]).toBeLessThan(400);
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThanOrEqual(600);
    expect(received).toBe(sseBytes(events));

    // 100 in at 1.25/M + 50 out at 3.75/M = 0.0003125, rounded to the micro.
    expect(await usageRecords(keyId)).toEqual([{ status: "success", input: "100", output: "50", cost: "0.000313" }]);
    const ledger = await request(app.getHttpServer()).get(`/admin/api-keys/${keyId}/credits`).set("Cookie", cookie).expect(200);
    const debit = ledger.body.transactions.find((tx: { type: string }) => tx.type === "cost_consumed");
    expect(debit.amount).toBe("-0.000313");
    expect((await app.get(RequestLimiter).usage(keyId)).tokensToday).toBe(150);
    const logs = await dataSource.query("SELECT status, input_tokens::text AS input FROM request_logs WHERE api_key_id = $1", [keyId]);
    expect(logs).toEqual([{ status: "success", input: "100" }]);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    expect(activeStreams()).toBe(0);
  });

  it("aborts the upstream on client disconnect, settles partial usage, and frees the slot", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    // One slot, so the follow-up request only succeeds if the disconnected stream released it.
    const { secret, keyId } = await createKeyAndAddCredit("10.00", { maxConcurrentRequests: 1 });

    fakeFactory.fakeProvider.streamDelayMs = 100;
    fakeFactory.fakeProvider.streamChunks = [
      { candidates: [{ content: { parts: [{ text: "1" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
      ...Array.from({ length: 50 }, () => ({ candidates: [{ content: { parts: [{ text: "x" }] } }] })),
    ];

    const client = new AbortController();
    const res = await streamRequest(publicName, secret, client.signal);
    const reader = res.body!.getReader();
    await reader.read();
    client.abort();

    await vi.waitFor(async () => {
      expect(await usageRecords(keyId)).toEqual([{ status: "partial", input: "10", output: "5", cost: expect.any(String) }]);
    }, { timeout: 3000 });
    expect(fakeFactory.fakeProvider.wasAborted).toBe(true);
    await vi.waitFor(async () => {
      expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
      expect(activeStreams()).toBe(0);
    });

    fakeFactory.fakeProvider.streamDelayMs = 0;
    fakeFactory.fakeProvider.streamChunks = [{ usageMetadata: USAGE }];
    const next = await streamRequest(publicName, secret);
    expect(next.status).toBe(200);
    await next.text();
  });

  it("bills a stream cut before its final usage event from the text it delivered", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();

    // Like Vertex: every event but the last carries usageMetadata with no counts.
    const text = "x".repeat(300);
    fakeFactory.fakeProvider.streamDelayMs = 150;
    fakeFactory.fakeProvider.streamChunks = [
      ...Array.from({ length: 6 }, () => ({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { trafficType: "ON_DEMAND" },
      })),
      { usageMetadata: USAGE },
    ];

    const client = new AbortController();
    const res = await streamRequest(publicName, secret, client.signal);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    client.abort();

    let row: { status: string; input: string | null; output: string | null; cost: string | null; undetermined: boolean; estimated: boolean } | undefined;
    await vi.waitFor(async () => {
      [row] = await dataSource.query(
        `SELECT status, input_tokens::text AS input, output_tokens::text AS output, calculated_cost::text AS cost,
                cost_undetermined AS undetermined, (pricing_snapshot ? 'estimate') AS estimated
           FROM usage_records WHERE api_key_id = $1`,
        [keyId],
      );
      expect(row).toBeDefined();
    }, { timeout: 3000 });

    // No token counts are invented; the charge is an estimate, flagged as such, and never zero.
    expect(row).toMatchObject({ status: "partial", input: null, output: null, undetermined: true, estimated: true });
    expect(Number(row!.cost)).toBeGreaterThan(0);
    const debits = await dataSource.query("SELECT amount::text AS amount FROM credit_transactions WHERE api_key_id = $1 AND type = 'cost_consumed'", [keyId]);
    expect(debits).toEqual([{ amount: `-${row!.cost}` }]);
    await vi.waitFor(async () => expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n));
  });

  it("ends with an error event and settles partial usage when the upstream fails mid-stream", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();

    const events: JsonObject[] = [
      { candidates: [{ content: { parts: [{ text: "1" }] } }] },
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
    ];
    fakeFactory.fakeProvider.streamDelayMs = 50;
    fakeFactory.fakeProvider.streamChunks = events;
    fakeFactory.fakeProvider.failMidStream = true;

    const res = await streamRequest(publicName, secret);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      sseBytes(events) + 'data: {"error":{"code":500,"message":"Upstream stream failed.","status":"INTERNAL"}}\n\n',
    );

    expect(await usageRecords(keyId)).toEqual([{ status: "partial", input: "10", output: "5", cost: expect.any(String) }]);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    expect(activeStreams()).toBe(0);
  });

  it("times out an idle upstream with an error event", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();

    await settingsService.update({ "timeouts.streamIdleMs": 1000 }, { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null });
    fakeFactory.fakeProvider.streamDelayMs = 3000;
    fakeFactory.fakeProvider.streamChunks = [{ candidates: [{ content: { parts: [{ text: "1" }] } }] }];

    const res = await streamRequest(publicName, secret);
    expect(await res.text()).toBe('data: {"error":{"code":500,"message":"Upstream stream timed out.","status":"INTERNAL"}}\n\n');
    expect(fakeFactory.fakeProvider.wasAborted).toBe(true);

    const logs = await dataSource.query("SELECT status, error_code FROM request_logs WHERE api_key_id = $1", [keyId]);
    expect(logs).toEqual([{ status: "partial", error_code: "DEADLINE_EXCEEDED" }]);
    expect(activeStreams()).toBe(0);
  });

  it("answers an invalid key with a 401 JSON error", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent?alt=sse`)
      .set("x-goog-api-key", "invalid")
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(401);
    expect(res.body.error.status).toBe("UNAUTHENTICATED");
  });

  it("requires alt=sse", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret } = await createKeyAndAddCredit();

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(400);
    expect(res.body.error).toEqual({ code: 400, message: "Only alt=sse streaming is supported.", status: "INVALID_ARGUMENT" });
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("rejects a model without streaming support", async () => {
    const { publicName } = await createUpstreamAndModel(false, true);
    const { secret } = await createKeyAndAddCredit();

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent?alt=sse`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(400);
    expect(res.body.error.message).toContain("does not support streaming");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("answers exhausted credit with a 429 JSON error before calling the upstream", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret } = await createKeyAndAddCredit("0");

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent?alt=sse`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(429);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
    expect(activeStreams()).toBe(0);
  });

  it("maps an upstream connect error to a JSON error", async () => {
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();
    fakeFactory.fakeProvider.errorToThrow = new UpstreamError("quota", { kind: "quota_exhausted", httpStatus: 429 });

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:streamGenerateContent?alt=sse`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(429);
    expect(res.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
    expect(activeStreams()).toBe(0);
  });

  it("keeps the credit hold alive past its original lease while a stream is running", async () => {
    const leaseMs = 2_000;
    setLeaseMsForTests(leaseMs);
    const { publicName } = await createUpstreamAndModel(true, true);
    const { secret, keyId } = await createKeyAndAddCredit();
    const store = app.get(CreditReservationStore);
    let releaseStream = (): void => {};
    fakeFactory.fakeProvider.streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    fakeFactory.fakeProvider.streamChunks = [
      { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } },
    ];

    const pending = streamRequest(publicName, secret);
    try {
      await vi.waitFor(() => expect(fakeFactory.fakeProvider.calls).toHaveLength(1), { timeout: 5_000 });
      const held = await store.activeReservedMicros(keyId);
      expect(held > 0n).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, leaseMs + 500));
      expect(await store.activeReservedMicros(keyId)).toBe(held);
    } finally {
      releaseStream();
      setLeaseMsForTests(null);
    }

    const res = await pending;
    expect(res.status).toBe(200);
    await res.text();
    expect(await store.activeReservedMicros(keyId)).toBe(0n);
  });
});
