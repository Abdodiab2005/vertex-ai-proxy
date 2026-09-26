import { vi } from "vitest";
import { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { ModelAlias, Upstream } from "@gateway/database";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import { AIUpstreamProvider, JsonObject, ProviderModelInfo, UpstreamCallOptions, UpstreamConnectionTestResult } from "../src/upstreams/providers/upstream-provider.js";
import { UpstreamError } from "../src/upstreams/providers/upstream-errors.js";

import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";



class FakeAIUpstreamProvider implements AIUpstreamProvider {
  public calls: { method: string, model: string, request: JsonObject }[] = [];
  public errorToThrow: Error | null = null;
  public fakeDelayMs = 0;
  public wasAborted = false;
  /** When set, the Nth embedContent call (1-based) throws errorToThrow. Null throws on every embed call. */
  public failEmbedCall: number | null = null;
  public embedResults: { response: JsonObject; inputTokens: number | null }[] | null = null;
  private gate: Promise<void> | null = null;
  private releaseHold: (() => void) | null = null;
  public fakeUsageMetadata: JsonObject = {
    promptTokenCount: 100,
    candidatesTokenCount: 50,
    totalTokenCount: 150,
    cachedContentTokenCount: 0,
    thoughtsTokenCount: 0,
    toolUsePromptTokenCount: 0,
    promptTokensDetails: [],
    candidatesTokensDetails: [],
    cacheTokensDetails: []
  };

  hold(): () => void {
    let release = (): void => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseHold = release;
    return () => {
      release();
      if (this.releaseHold === release) {
        this.releaseHold = null;
        this.gate = null;
      }
    };
  }

  unblock(): void {
    this.releaseHold?.();
    this.releaseHold = null;
    this.gate = null;
  }

  private async waitForHold(): Promise<void> {
    const gate = this.gate;
    if (gate) {
      await gate;
    }
  }

  private async handleDelay(options?: UpstreamCallOptions) {
    if (this.fakeDelayMs > 0) {
      if (options?.signal) {
        return new Promise<void>((resolve, reject) => {
           const timeout = setTimeout(() => resolve(), this.fakeDelayMs);
           options.signal!.addEventListener('abort', () => {
             clearTimeout(timeout);
             this.wasAborted = true;
             reject(new Error("aborted"));
           });
        });
      } else {
        await new Promise(r => setTimeout(r, this.fakeDelayMs));
      }
    }
  }
  
  async generateContent(model: string, request: JsonObject, options?: UpstreamCallOptions): Promise<JsonObject> {
    this.calls.push({ method: "generateContent", model, request });
    await this.handleDelay(options);
    if (this.errorToThrow) throw this.errorToThrow;
    return {
      candidates: [{ content: { parts: [{ text: "Fake generated text" }] } }],
      usageMetadata: this.fakeUsageMetadata,
    };
  }
  
  async streamGenerateContent(_model: string, _request: JsonObject, _options?: UpstreamCallOptions): Promise<ReadableStream<Uint8Array>> {
    throw new Error("Not implemented");
  }
  
  async countTokens(model: string, request: JsonObject, options?: UpstreamCallOptions): Promise<JsonObject> {
    this.calls.push({ method: "countTokens", model, request });
    await this.handleDelay(options);
    if (this.errorToThrow) throw this.errorToThrow;
    return { totalTokens: 100 };
  }
  
  async listModels(_options?: UpstreamCallOptions): Promise<{ models: ProviderModelInfo[] }> {
    return { models: [] };
  }
  
  async getModel(model: string, _options?: UpstreamCallOptions): Promise<ProviderModelInfo> {
    return { id: model };
  }
  
  async embedContent(model: string, request: JsonObject, options?: UpstreamCallOptions): Promise<{ response: JsonObject; inputTokens: number | null }> {
    this.calls.push({ method: "embedContent", model, request });
    await this.waitForHold();
    await this.handleDelay(options);
    const embedCall = this.calls.filter((call) => call.method === "embedContent").length;
    if (this.errorToThrow && (this.failEmbedCall === null || this.failEmbedCall === embedCall)) {
      throw this.errorToThrow;
    }
    const scripted = this.embedResults?.[embedCall - 1];
    if (scripted) {
      return scripted;
    }
    return { response: { embedding: [0.1, 0.2] }, inputTokens: 42 };
  }
  
  async testConnection(_model: string): Promise<UpstreamConnectionTestResult> {
    return { status: "connected", httpStatus: 200, message: "OK" };
  }
}
class FakeUpstreamProviderFactory extends UpstreamProviderFactory {
  public fakeProvider = new FakeAIUpstreamProvider();
  
  forUpstream(_upstream: Upstream): AIUpstreamProvider {
    return this.fakeProvider;
  }
}

describe("PublicGenerationService (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let cookie: string;
  let fakeFactory: FakeUpstreamProviderFactory;
  
  let csrfToken: string;
  
  beforeAll(async () => {
    const cipher = {} as import("@gateway/shared").CredentialCipher;
    fakeFactory = new FakeUpstreamProviderFactory(cipher);
    
    app = await createE2eApp({
      overrides: [
        { provide: UpstreamProviderFactory, useValue: fakeFactory }
      ]
    });
    dataSource = app.get(DataSource);
    await app.init();
  });
  
  afterAll(async () => {
    await app.close();
  });
  
  beforeEach(async () => {
    await resetE2eState(app);
    fakeFactory.fakeProvider.unblock();
    fakeFactory.fakeProvider.calls = [];
    fakeFactory.fakeProvider.errorToThrow = null;
    fakeFactory.fakeProvider.fakeDelayMs = 0;
    fakeFactory.fakeProvider.wasAborted = false;
    fakeFactory.fakeProvider.failEmbedCall = null;
    fakeFactory.fakeProvider.embedResults = null;
    fakeFactory.fakeProvider.fakeUsageMetadata = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 };

    const { bootstrapOwner } = await import("../src/cli/bootstrap-owner.js");
    const { PasswordHasher } = await import("../src/security/password-hasher.js");
    await bootstrapOwner(dataSource, new PasswordHasher(), {
      email: "owner@example.com",
      password: "correct-horse-1",
    });

    const response = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "owner@example.com", password: "correct-horse-1" });
    if (response.status !== 200) {
      throw new Error(`Login failed with status ${response.status}: ${JSON.stringify(response.body)}`);
    }
    const parsedCookie = sessionCookie(response);
    cookie = `${parsedCookie.name}=${parsedCookie.value}`;
    csrfToken = response.body.csrfToken;
  });

  async function createUpstreamAndModel(enabled = true, priced = true) {
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
      })
      .expect(201);
      
    const modelId = modRes.body.model.id;
    
    await request(app.getHttpServer())
      .patch(`/admin/models/${modelId}`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ enabled })
      .expect(200);

    if (priced) {
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
    }
      
    return { upstreamId, modelId, publicName: enabled ? "gemini-1.5-pro" : "disabled-model" };
  }

  async function createKeyAndAddCredit(amount = "10.00", limits = {}) {
    const keyRes = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        name: "Test Key",
        ...limits
      })
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

  it("text generation works (200, body passthrough, x-request-id)", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit();
    
    const reqBody = {
      contents: [{ parts: [{ text: "Hello" }] }],
      systemInstruction: { parts: [{ text: "Be helpful" }] },
      generationConfig: { maxOutputTokens: 100 },
      tools: [{ functionDeclarations: [{ name: "testFn", description: "test" }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } }
    };
    
    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(reqBody)
      .expect(200);
      
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.body.candidates[0].content.parts[0].text).toBe("Fake generated text");
    
    expect(fakeFactory.fakeProvider.calls).toHaveLength(1);
    const upstreamCall = fakeFactory.fakeProvider.calls[0];
    expect(upstreamCall.method).toBe("generateContent");
    expect(upstreamCall.model).toBe("gemini-1.5-pro");
    expect(upstreamCall.request).toEqual(reqBody);

    // Verify usage and cost correctly persisted
    const ledger = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .expect(200);
      
    const costTx = ledger.body.transactions.find((tx: { type: string, amount: string }) => tx.type === "cost_consumed");
    expect(costTx).toBeDefined();
    // input = 100 tokens * 1.25 / 1M = $0.000125
    // output = 50 tokens * 3.75 / 1M = $0.0001875
    // total = 0.0003125 -> "0.000313" (micro rounding handled by server)
    expect(costTx.amount).toBe("-0.000313");

    // The response's x-request-id is the key to this request's usage record.
    const [usageRow] = await dataSource.query(
      "SELECT calculated_cost::text AS cost, input_tokens::text AS input, output_tokens::text AS output FROM usage_records WHERE request_id = $1",
      [res.headers["x-request-id"]],
    );
    expect(usageRow).toEqual({ cost: "0.000313", input: "100", output: "50" });
  });
  
  it("an invalid key fails (401), upstream never called", async () => {
    const { publicName } = await createUpstreamAndModel();
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", "invalid-key")
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(401);
      
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("disabled model fails (404)", async () => {
    const { publicName } = await createUpstreamAndModel(false);
    const { secret } = await createKeyAndAddCredit();
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(404);
      
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("insufficient credit fails BEFORE upstream", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("0");
    
    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(429);
      
    expect(res.body.error.message).toBe("API key credit has been exhausted.");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("unpriced model -> 400 FAILED_PRECONDITION", async () => {
    const { publicName } = await createUpstreamAndModel(true, false);
    const { secret } = await createKeyAndAddCredit();
    
    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(400);
      
    expect(res.body.error.message).toContain("has no pricing configured");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });
  
  it("RPM limit -> 429 on N+1th call", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("10", { requestsPerMinute: 1 });
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(200);
      
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(429);
  });

  it("upstream errors mapped correctly", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();
    
    fakeFactory.fakeProvider.errorToThrow = new UpstreamError("API_KEY_INVALID", { kind: "authentication_failed", httpStatus: 400 });
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(503); // auth failure -> 503
  });

  it("countTokens works and debits nothing", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit();
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:countTokens`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(200);
      
    // Credit remains 10
    const ledger = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .expect(200);
      
    expect(ledger.body.summary.remaining).toBe("10.000000");
  });

  it("embedContent works and debits input cost", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit();
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:embedContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(200);
      
    const ledger = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .expect(200);
      
    const costTx = ledger.body.transactions.find((tx: { type: string, amount: string }) => tx.type === "cost_consumed");
    expect(costTx).toBeDefined();
    // 42 tokens * 1.25 / 1M = 0.0000525 -> "0.000053"
    expect(costTx.amount).toBe("-0.000053");
  });

  it("refuses a second embed whose hold does not fit beside the first", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit("0.01");
    // 12_003 chars / 3 = 4_001 tokens at $1.25/M is 5_002 micros, above half of $0.01.
    const body = { content: { parts: [{ text: "a".repeat(12_003) }] } };
    const store = app.get(CreditReservationStore);

    const release = fakeFactory.fakeProvider.hold();
    // supertest does not send until the Test is used as a promise.
    const first = request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:embedContent`)
      .set("x-goog-api-key", secret)
      .send(body)
      .then((res) => res);
    try {
      await vi.waitFor(() => expect(fakeFactory.fakeProvider.calls).toHaveLength(1), { timeout: 5_000 });
      const held = await store.activeReservedMicros(keyId);
      expect(held > 5_000n && held < 10_000n).toBe(true);

      const second = await request(app.getHttpServer())
        .post(`/v1beta/models/${publicName}:embedContent`)
        .set("x-goog-api-key", secret)
        .send(body);
      expect(second.status).toBe(429);
      expect(second.body.error).toEqual({
        code: 429,
        message: "API key credit has been exhausted.",
        status: "RESOURCE_EXHAUSTED",
      });
      expect(fakeFactory.fakeProvider.calls).toHaveLength(1);
    } finally {
      release();
    }

    expect((await first).status).toBe(200);
    expect(await store.activeReservedMicros(keyId)).toBe(0n);
  });

  it("rejects an embed whose only input price is no longer effective", async () => {
    const { publicName, modelId } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();
    await dataSource.query(
      `UPDATE pricing_rules
       SET effective_from = NOW() - INTERVAL '2 days',
           effective_to = NOW() - INTERVAL '1 day'
       WHERE model_id = $1 AND billing_dimension = 'input_tokens'`,
      [modelId],
    );

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:embedContent`)
      .set("x-goog-api-key", secret)
      .send({ content: { parts: [{ text: "Hello" }] } })
      .expect(400);

    expect(res.body.error.status).toBe("FAILED_PRECONDITION");
    expect(res.body.error.message).toContain("has no pricing configured");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("injects the reserved maxOutputTokens and keeps a client value", async () => {
    const { publicName, modelId } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();
    const base = { contents: [{ parts: [{ text: "Hello" }] }] };

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(base)
      .expect(200);
    expect(fakeFactory.fakeProvider.calls.at(-1)?.request).toEqual({
      ...base,
      generationConfig: { maxOutputTokens: 8192 },
    });

    await request(app.getHttpServer())
      .patch(`/admin/models/${modelId}`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ outputTokenLimit: 4096 })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(base)
      .expect(200);
    expect(fakeFactory.fakeProvider.calls.at(-1)?.request).toEqual({
      ...base,
      generationConfig: { maxOutputTokens: 4096 },
    });

    const capped = { ...base, generationConfig: { maxOutputTokens: 100, temperature: 0.2 } };
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(capped)
      .expect(200);
    expect(fakeFactory.fakeProvider.calls.at(-1)?.request).toEqual(capped);
  });

  it("model restricted for key -> 403", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("10", { allowedModels: ["some-other-model"] });
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(403);
  });

  it("block by alias -> 403 for both the public name and the alias on generateContent", async () => {
    const { modelId, publicName } = await createUpstreamAndModel();
    await dataSource.getRepository(ModelAlias).save({ alias: "alias-pro-blocked", modelId });

    const { secret } = await createKeyAndAddCredit("10", { blockedModels: ["alias-pro-blocked"] });

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/v1beta/models/alias-pro-blocked:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(403);
  });

  it("allow only an alias -> generateContent works via public name and alias", async () => {
    const { modelId, publicName } = await createUpstreamAndModel();
    await dataSource.getRepository(ModelAlias).save({ alias: "alias-pro-allowed", modelId });

    const { secret } = await createKeyAndAddCredit("10", { allowedModels: ["alias-pro-allowed"] });

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1beta/models/alias-pro-allowed:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(200);
  });

  it("allowedEndpoints enforced", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("10", { allowedEndpoints: ["models.list"] });
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }] })
      .expect(403);
  });

  it("cachedContent -> 400", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send({ contents: [{ parts: [{ text: "Hello" }] }], cachedContent: "something" })
      .expect(400);
  });

  it("persists exact cost correctly", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey, keyId } = await createKeyAndAddCredit();

    fakeFactory.fakeProvider.fakeUsageMetadata = {
      promptTokenCount: 1234567,
      candidatesTokenCount: 89000,
      totalTokenCount: 1323567
    };
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "exact cost" }] }] })
      .expect(200);
      
    const usageRecords = await dataSource.query(`SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 1`);
    expect(usageRecords[0].input_tokens).toBe("1234567");
    expect(usageRecords[0].output_tokens).toBe("89000");
    expect(usageRecords[0].calculated_cost).toBe("1.876959");
    
    const ledgers = await dataSource.query(`SELECT * FROM credit_transactions WHERE type='cost_consumed' ORDER BY created_at DESC LIMIT 1`);
    expect(ledgers[0].amount).toBe("-1.876959");
    
    const remaining = await dataSource.query(`SELECT COALESCE(SUM(amount), 0)::text as balance FROM credit_transactions WHERE api_key_id = $1`, [keyId]);
    expect(remaining[0].balance).toBe("8.123041");
  });

  it("does not create usage_record for pre-upstream rejections", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey, keyId } = await createKeyAndAddCredit();

    const logsBefore = await dataSource.query(`SELECT count(*) as c FROM request_logs`);
    
    await dataSource.query(`INSERT INTO credit_transactions (api_key_id, amount, type, currency) VALUES ($1, '-10.00', 'manual_adjustment', 'USD')`, [keyId]);
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .expect(429);
      
    const logsAfter = await dataSource.query(`SELECT count(*) as c FROM request_logs`);
    expect(logsAfter[0].c).toBe((parseInt(logsBefore[0].c) + 1).toString());
    
    const latestLog = await dataSource.query(`SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 1`);
    expect(latestLog[0].status).toBe("error");
    expect(latestLog[0].error_code).toBe("RESOURCE_EXHAUSTED");
    expect(latestLog[0].calculated_cost).toBeNull();
    expect(latestLog[0].input_tokens).toBeNull();
    
    expect(fakeFactory.fakeProvider.calls.length).toBe(0);
  });

  it("aborts upstream call when client disconnects and releases slot/credit", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey, keyId } = await createKeyAndAddCredit();

    fakeFactory.fakeProvider.fakeDelayMs = 5000;
            try {
      await request(app.getHttpServer())
        .post(`/v1beta/models/${publicName}:generateContent`)
        .set("x-goog-api-key", gatewayKey)
        .send({ contents: [{ parts: [{ text: "hi" }] }] })
        .timeout(100);
    } catch { /* expected */ }
    
    // Wait for the server to process the client disconnect
    for (let i = 0; i < 20; i++) {
       if (fakeFactory.fakeProvider.wasAborted) break;
       await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 100)); // wait for finally block to settle

    expect(fakeFactory.fakeProvider.wasAborted).toBe(true);
    
    fakeFactory.fakeProvider.fakeDelayMs = 0;
    fakeFactory.fakeProvider.wasAborted = false;
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .expect(200);
      
    const creditReservationStore = app.get(CreditReservationStore);
    const active = await creditReservationStore.activeReservedMicros(keyId);
    expect(active).toBe(0n);
  });

  it("does not abort a normal slow upstream if client stays connected", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey } = await createKeyAndAddCredit();

    fakeFactory.fakeProvider.fakeDelayMs = 300;
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .expect(200);
      
    expect(fakeFactory.fakeProvider.wasAborted).toBe(false);
  });

  it("records tokens for all dimensions", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey, keyId } = await createKeyAndAddCredit();

    fakeFactory.fakeProvider.fakeUsageMetadata = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
      cachedContentTokenCount: 20,
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 10 }]
    };
    
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .expect(200);
      
    const logs = await dataSource.query(`SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 1`);
    expect(logs[0].input_tokens).toBe("70");
    expect(logs[0].output_tokens).toBe("50");
    const other = logs[0].other_usage_dimensions;
    expect(other).toBeDefined();
    expect(other.cached_input_tokens).toBeGreaterThanOrEqual(0);
    expect(other.audio_input_tokens).toBeGreaterThanOrEqual(0);
    
    const { RequestLimiter } = await import("../src/rate-limits/request-limiter.js");
    const requestLimiter = app.get(RequestLimiter);
    const usage = await requestLimiter.usage(keyId);
    expect(usage.tokensThisMinute).toBeGreaterThanOrEqual(150);
  });
  
  it("includes x-request-id on error responses", async () => {
    const { publicName } = await createUpstreamAndModel();
    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", "invalid-key")
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .expect(401);
      
    expect(res.headers["x-request-id"]).toBeDefined();
  });
  
  it("enforces concurrency limit correctly", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret: gatewayKey, keyId } = await createKeyAndAddCredit();

    await dataSource.query(`UPDATE api_keys SET max_concurrent_requests = 1 WHERE id = $1`, [keyId]);
    
    fakeFactory.fakeProvider.fakeDelayMs = 500;
    
    // Supertest only sends on then(), so start the first request explicitly and wait until it holds
    // the slot (it has reached the upstream) before sending the second.
    const req1 = request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] })
      .then((res) => res);
    await vi.waitFor(() => expect(fakeFactory.fakeProvider.calls).toHaveLength(1));

    const res2 = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", gatewayKey)
      .send({ contents: [{ parts: [{ text: "hi" }] }] });
    const res1 = await req1;
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(429);
  });

  it("batchEmbedContents returns embeddings in order and bills the summed input tokens", async () => {
    const { publicName, modelId } = await createUpstreamAndModel();
    await request(app.getHttpServer())
      .post(`/admin/models/${modelId}/aliases`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ alias: "embed-alias" })
      .expect(201);
    const { secret, keyId } = await createKeyAndAddCredit();

    fakeFactory.fakeProvider.embedResults = [
      { response: { embedding: { values: [0.1] } }, inputTokens: 100 },
      { response: { embedding: { values: [0.2, 0.3] } }, inputTokens: 50 },
      { response: { embedding: { values: [0.4] } }, inputTokens: 7 },
    ];

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({
        requests: [
          { model: `models/${publicName}`, content: { parts: [{ text: "one" }] } },
          {
            model: "models/embed-alias",
            content: { parts: [{ text: "two" }] },
            taskType: "RETRIEVAL_QUERY",
            outputDimensionality: 128,
          },
          {
            model: publicName,
            content: { parts: [{ text: "three" }] },
            title: "note",
            taskType: "SEMANTIC_SIMILARITY",
          },
        ],
      })
      .expect(200);

    expect(res.body).toEqual({
      embeddings: [{ values: [0.1] }, { values: [0.2, 0.3] }, { values: [0.4] }],
    });
    expect(fakeFactory.fakeProvider.calls.map((call) => call.method)).toEqual([
      "embedContent",
      "embedContent",
      "embedContent",
    ]);
    expect(fakeFactory.fakeProvider.calls.map((call) => call.model)).toEqual([
      "gemini-1.5-pro",
      "gemini-1.5-pro",
      "gemini-1.5-pro",
    ]);
    expect(fakeFactory.fakeProvider.calls.map((call) => call.request)).toEqual([
      { content: { parts: [{ text: "one" }] } },
      {
        content: { parts: [{ text: "two" }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 128,
      },
      {
        content: { parts: [{ text: "three" }] },
        title: "note",
        taskType: "SEMANTIC_SIMILARITY",
      },
    ]);

    // 157 tokens * $1.25 / 1_000_000 = 0.00019625, half-up to 0.000196.
    const [usageRow] = await dataSource.query(
      "SELECT endpoint, input_tokens::text AS input, calculated_cost::text AS cost FROM usage_records WHERE request_id = $1",
      [res.headers["x-request-id"]],
    );
    expect(usageRow).toEqual({ endpoint: "batchEmbedContents", input: "157", cost: "0.000196" });

    const usageCount = await dataSource.query(
      "SELECT count(*)::text AS c FROM usage_records WHERE api_key_id = $1",
      [keyId],
    );
    expect(usageCount[0].c).toBe("1");

    const ledger = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .expect(200);
    const costTx = ledger.body.transactions.find((tx: { type: string }) => tx.type === "cost_consumed");
    expect(costTx.amount).toBe("-0.000196");
  });

  it("admits batchEmbedContents once for the whole batch", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("10", { requestsPerMinute: 1 });
    const body = {
      requests: [
        { content: { parts: [{ text: "one" }] } },
        { content: { parts: [{ text: "two" }] } },
        { content: { parts: [{ text: "three" }] } },
      ],
    };

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send(body)
      .expect(200);
    expect(fakeFactory.fakeProvider.calls).toHaveLength(3);

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send(body)
      .expect(429);
    expect(fakeFactory.fakeProvider.calls).toHaveLength(3);
  });

  it("rejects an empty batch and a batch over 100 items", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();

    const empty = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({ requests: [] })
      .expect(400);
    expect(empty.body.error.status).toBe("INVALID_ARGUMENT");

    const tooMany = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({
        requests: Array.from({ length: 101 }, () => ({ content: { parts: [{ text: "x" }] } })),
      })
      .expect(400);
    expect(tooMany.body.error.status).toBe("INVALID_ARGUMENT");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("rejects a batch item whose model does not match the URL before calling upstream", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit();

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({
        requests: [{ model: "models/other-model", content: { parts: [{ text: "hi" }] } }],
      })
      .expect(400);

    expect(res.body.error.status).toBe("INVALID_ARGUMENT");
    expect(res.body.error.message).toBe("Each request's model must match the model in the URL.");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("rejects batchEmbedContents when the model does not support embeddings", async () => {
    const { publicName, modelId } = await createUpstreamAndModel();
    await request(app.getHttpServer())
      .patch(`/admin/models/${modelId}`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ supportsEmbeddings: false })
      .expect(200);
    const { secret } = await createKeyAndAddCredit();

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({ requests: [{ content: { parts: [{ text: "hi" }] } }] })
      .expect(400);

    expect(res.body.error.status).toBe("INVALID_ARGUMENT");
    expect(res.body.error.message).toContain("does not support batchEmbedContents");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("rejects batchEmbedContents before upstream when credit is exhausted", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("0");

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({ requests: [{ content: { parts: [{ text: "hi" }] } }] })
      .expect(429);

    expect(res.body.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(res.body.error.message).toBe("API key credit has been exhausted.");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(0);
  });

  it("fails the batch when an item fails, charges the items that ran, and releases the reservation", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit();
    fakeFactory.fakeProvider.failEmbedCall = 2;
    fakeFactory.fakeProvider.errorToThrow = new UpstreamError("embedding rejected", {
      kind: "upstream_error",
      httpStatus: 400,
    });

    const res = await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({
        requests: [
          { content: { parts: [{ text: "one" }] } },
          { content: { parts: [{ text: "two" }] } },
        ],
      })
      .expect(400);

    expect(res.body.error.status).toBe("INVALID_ARGUMENT");
    expect(res.body.error.message).toBe("embedding rejected");
    expect(fakeFactory.fakeProvider.calls).toHaveLength(2);

    // Item one ran (Vertex billed it), so it is charged even though the batch answered an error.
    const usage = await dataSource.query(
      "SELECT status, input_tokens::text AS input FROM usage_records WHERE api_key_id = $1",
      [keyId],
    );
    expect(usage).toEqual([{ status: "partial", input: "42" }]);

    const creditReservationStore = app.get(CreditReservationStore);
    expect(await creditReservationStore.activeReservedMicros(keyId)).toBe(0n);
  });

  it("writes no usage when the first batch item fails", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret, keyId } = await createKeyAndAddCredit();
    fakeFactory.fakeProvider.failEmbedCall = 1;
    fakeFactory.fakeProvider.errorToThrow = new UpstreamError("embedding rejected", {
      kind: "upstream_error",
      httpStatus: 400,
    });

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({ requests: [{ content: { parts: [{ text: "one" }] } }, { content: { parts: [{ text: "two" }] } }] })
      .expect(400);

    const usage = await dataSource.query("SELECT 1 FROM usage_records WHERE api_key_id = $1", [keyId]);
    expect(usage).toHaveLength(0);
    expect(await app.get(CreditReservationStore).activeReservedMicros(keyId)).toBe(0n);
  });

  it("allows batchEmbedContents when the key is only granted embedContent", async () => {
    const { publicName } = await createUpstreamAndModel();
    const { secret } = await createKeyAndAddCredit("10", { allowedEndpoints: ["embedContent"] });

    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", secret)
      .send({ requests: [{ content: { parts: [{ text: "hi" }] } }] })
      .expect(200);

    const denied = await createKeyAndAddCredit("10", { allowedEndpoints: ["generateContent"] });
    await request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:batchEmbedContents`)
      .set("x-goog-api-key", denied.secret)
      .send({ requests: [{ content: { parts: [{ text: "hi" }] } }] })
      .expect(403);
  });

});
