import { vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import type { Upstream } from "@gateway/database";
import { createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";
import { UpstreamProviderFactory } from "../src/upstreams/upstream-provider.factory.js";
import type {
  AIUpstreamProvider,
  JsonObject,
  ProviderModelInfo,
  UpstreamCallOptions,
  UpstreamConnectionTestResult,
} from "../src/upstreams/providers/upstream-provider.js";
import { CreditLedgerService } from "../src/credits/credit-ledger.service.js";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";
import { formatMicros, toMicros } from "../src/credits/money.js";
import {
  estimateReservationMicros,
  type ReservationPolicy,
} from "../src/credits/reservation-estimate.js";
import type { PricingRuleInput } from "../src/pricing/pricing-engine.js";

// PublicGenerationService keeps this policy private. Recomputing with the same
// numbers is the only way to know what the in-flight reservation must be.
const RESERVATION_POLICY: ReservationPolicy = {
  charsPerToken: 3,
  tokensPerMediaPart: 1000,
  defaultMaxOutputTokens: 8192,
  fileUriHoldTokens: 50_000,
};

const INPUT_PER_MILLION = "1.00";
const OUTPUT_PER_MILLION = "1.00";

interface RecordedCall {
  method: string;
  model: string;
  request: JsonObject;
}

interface UsageRow {
  requestId: string;
  input: string | null;
  output: string | null;
  cost: string | null;
  undetermined: boolean;
  snapshot: unknown;
}

interface LedgerRow {
  id: string;
  type: string;
  amount: string;
}

class FakeAIUpstreamProvider implements AIUpstreamProvider {
  calls: RecordedCall[] = [];
  usageMetadata: unknown = { promptTokenCount: 100_000, candidatesTokenCount: 0 };
  omitUsageMetadata = false;
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

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
    this.omitUsageMetadata = false;
    this.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };
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
    const response: JsonObject = {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    };
    if (!this.omitUsageMetadata) {
      response.usageMetadata = this.usageMetadata;
    }
    return response;
  }

  async streamGenerateContent(): Promise<ReadableStream<Uint8Array>> {
    throw new Error("streamGenerateContent is not used by the accounting suite");
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

function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected a query row array");
  }
  return value.map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new Error("Expected a query row object");
    }
    return row as Record<string, unknown>;
  });
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string or null`);
  }
  return value;
}

function requestIdOf(res: Response): string {
  const value = res.headers["x-request-id"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Response is missing x-request-id");
  }
  return value;
}

function moneyMinus(left: string, right: string): string {
  return formatMicros(toMicros(left) - toMicros(right));
}

function pricingRule(dimension: string, price: string): PricingRuleInput {
  return {
    id: dimension,
    billingDimension: dimension,
    unitSize: "1000000",
    price,
    currency: "USD",
    effectiveFrom: new Date(0),
    effectiveTo: null,
  };
}

describe("credit accounting (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let cookie: string;
  let csrfToken: string;
  let fakeFactory: FakeUpstreamProviderFactory;
  let reservations: CreditReservationStore;

  beforeAll(async () => {
    fakeFactory = new FakeUpstreamProviderFactory({} as import("@gateway/shared").CredentialCipher);
    app = await createE2eApp({
      overrides: [{ provide: UpstreamProviderFactory, useValue: fakeFactory }],
    });
    dataSource = app.get(DataSource);
    reservations = app.get(CreditReservationStore);
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

  async function createPricedModel(prices?: {
    input?: string;
    output?: string;
  }): Promise<{ modelId: string; publicName: string }> {
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
        enabled: true,
      })
      .expect(201);
    const modelId = created.body.model.id as string;
    await addPrice(modelId, "input_tokens", prices?.input ?? INPUT_PER_MILLION);
    await addPrice(modelId, "output_tokens", prices?.output ?? OUTPUT_PER_MILLION);
    return { modelId, publicName: "gemini-1.5-pro" };
  }

  async function addPrice(modelId: string, dimension: string, price: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/admin/models/${modelId}/pricing`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({
        billingDimension: dimension,
        unitSize: "1000000",
        price,
        currency: "USD",
        effectiveFrom: new Date().toISOString(),
      })
      .expect(201);
  }

  async function createKey(input: {
    amount?: string;
    limits?: Record<string, unknown>;
  } = {}): Promise<{ keyId: string; secret: string }> {
    const amount = input.amount ?? "5.00";
    const created = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ name: "Test Key", ...input.limits })
      .expect(201);
    const keyId = created.body.apiKey.id as string;
    const secret = created.body.rawKey as string;
    if (amount !== "0") {
      await addCredit(keyId, amount);
    }
    return { keyId, secret };
  }

  async function addCredit(keyId: string, amount: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .send({ type: "credit_added", amount, description: "Test credit" })
      .expect(201);
  }

  async function remaining(keyId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", cookie)
      .expect(200);
    if (typeof res.body !== "object" || res.body === null || !("summary" in res.body)) {
      throw new Error("credits response is missing summary");
    }
    const summary = (res.body as { summary: unknown }).summary;
    if (typeof summary !== "object" || summary === null || !("remaining" in summary)) {
      throw new Error("credits response is missing remaining");
    }
    const value = (summary as { remaining: unknown }).remaining;
    if (typeof value !== "string") {
      throw new Error("remaining credit was not a string");
    }
    return value;
  }

  function generate(publicName: string, secret: string, body: JsonObject): request.Test {
    return request(app.getHttpServer())
      .post(`/v1beta/models/${publicName}:generateContent`)
      .set("x-goog-api-key", secret)
      .send(body);
  }

  async function usageRows(keyId: string): Promise<UsageRow[]> {
    const raw: unknown = await dataSource.query(
      `SELECT request_id AS "requestId",
              input_tokens::text AS input,
              output_tokens::text AS output,
              calculated_cost::text AS cost,
              cost_undetermined AS undetermined,
              pricing_snapshot AS snapshot
       FROM usage_records
       WHERE api_key_id = $1
       ORDER BY created_at ASC`,
      [keyId],
    );
    return rowsOf(raw).map((row) => {
      const undetermined = row.undetermined;
      if (typeof undetermined !== "boolean") {
        throw new Error("cost_undetermined was not a boolean");
      }
      return {
        requestId: textField(row, "requestId"),
        input: nullableText(row, "input"),
        output: nullableText(row, "output"),
        cost: nullableText(row, "cost"),
        undetermined,
        snapshot: row.snapshot ?? null,
      };
    });
  }

  async function ledgerRows(keyId: string): Promise<LedgerRow[]> {
    const raw: unknown = await dataSource.query(
      `SELECT id::text AS id, type::text AS type, amount::text AS amount
       FROM credit_transactions
       WHERE api_key_id = $1
       ORDER BY created_at ASC, id ASC`,
      [keyId],
    );
    return rowsOf(raw).map((row) => ({
      id: textField(row, "id"),
      type: textField(row, "type"),
      amount: textField(row, "amount"),
    }));
  }

  async function usageCostSum(keyId: string): Promise<string> {
    const raw: unknown = await dataSource.query(
      `SELECT COALESCE(SUM(calculated_cost), 0)::text AS total
       FROM usage_records
       WHERE api_key_id = $1`,
      [keyId],
    );
    return textField(rowsOf(raw)[0] ?? {}, "total");
  }

  async function ledgerBalance(keyId: string): Promise<string> {
    const raw: unknown = await dataSource.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM credit_transactions
       WHERE api_key_id = $1`,
      [keyId],
    );
    return textField(rowsOf(raw)[0] ?? {}, "total");
  }

  async function expectReleased(keyId: string): Promise<void> {
    expect(await reservations.activeReservedMicros(keyId)).toBe(0n);
  }

  const hello = { contents: [{ parts: [{ text: "Hello" }] }] };

  it("debits a request whose price lands on an exact decimal", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    // 100_000 tokens at $1 per million is $0.10 before any rounding residue.
    fakeFactory.fake.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };

    const res = await generate(publicName, secret, hello).expect(200);
    expect(await remaining(keyId)).toBe("4.900000");

    const [row] = await usageRows(keyId);
    expect(row).toMatchObject({
      requestId: requestIdOf(res),
      input: "100000",
      output: null,
      cost: "0.100000",
      undetermined: false,
    });
    const debits = (await ledgerRows(keyId)).filter((row) => row.type === "cost_consumed");
    expect(debits.map((row) => row.amount)).toEqual(["-0.100000"]);
    await expectReleased(keyId);
  });

  it("bills every request when a client reuses its x-request-id", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    fakeFactory.fake.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };

    const first = await generate(publicName, secret, hello).set("x-request-id", "client-chosen-id-1").expect(200);
    const second = await generate(publicName, secret, hello).set("x-request-id", "client-chosen-id-1").expect(200);

    // The gateway's id keys the usage record; the caller's id is only logged.
    expect(requestIdOf(first)).not.toBe("client-chosen-id-1");
    expect(requestIdOf(second)).not.toBe(requestIdOf(first));
    expect(await usageRows(keyId)).toHaveLength(2);
    expect(await remaining(keyId)).toBe("4.800000");
    await expectReleased(keyId);
  });

  it.each([
    {
      name: "reasoning tokens at the output price",
      usageMetadata: { promptTokenCount: 100_000, candidatesTokenCount: 100_000, thoughtsTokenCount: 200_000 },
      // 0.1 input + 0.1 output + 0.2 reasoning (priced as output)
      remaining: "4.600000",
    },
    {
      name: "audio input tokens at the input price",
      usageMetadata: {
        promptTokenCount: 100_000,
        candidatesTokenCount: 0,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 50_000 },
          { modality: "AUDIO", tokenCount: 50_000 },
        ],
      },
      // 0.05 text input + 0.05 audio input (priced as input)
      remaining: "4.900000",
    },
  ])("bills $name when the model has no price for them", async ({ usageMetadata, remaining: expected }) => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    fakeFactory.fake.usageMetadata = usageMetadata;

    await generate(publicName, secret, hello).expect(200);

    expect(await remaining(keyId)).toBe(expected);
    const [row] = await usageRows(keyId);
    expect(row).toMatchObject({ undetermined: false });
    await expectReleased(keyId);
  });

  it("bills generated images at the model's image output rate", async () => {
    const { modelId, publicName } = await createPricedModel();
    await addPrice(modelId, "image_output_tokens", "30.00");
    const { keyId, secret } = await createKey({ amount: "5.00" });
    // Shaped like Vertex's report for an image model: the image is inside candidatesTokenCount.
    fakeFactory.fake.usageMetadata = {
      promptTokenCount: 100_000,
      candidatesTokenCount: 110_000,
      candidatesTokensDetails: [
        { modality: "TEXT", tokenCount: 10_000 },
        { modality: "IMAGE", tokenCount: 100_000 },
      ],
    };

    await generate(publicName, secret, {
      ...hello,
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }).expect(200);

    // 0.10 input + 0.01 text output + 3.00 image output (100k at $30 per million).
    expect(await remaining(keyId)).toBe("1.890000");
    const [row] = await usageRows(keyId);
    expect(row).toMatchObject({ output: "10000", undetermined: false });
    await expectReleased(keyId);
  });

  it("refuses an image request for a model with no image output price", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });

    const res = await generate(publicName, secret, {
      ...hello,
      generationConfig: { responseModalities: ["IMAGE"] },
    }).expect(400);

    expect(res.body.error.status).toBe("FAILED_PRECONDITION");
    expect(res.body.error.message).toContain("no image output pricing");
    expect(fakeFactory.fake.calls).toHaveLength(0);
    await expectReleased(keyId);
  });

  it("keeps the balance equal to the initial credit minus recorded usage", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    const initial = await remaining(keyId);
    expect(initial).toBe("5.000000");

    // 100k + 200k + 50k tokens at $1/M = 0.10 + 0.20 + 0.05.
    for (const promptTokens of [100_000, 200_000, 50_000]) {
      fakeFactory.fake.usageMetadata = { promptTokenCount: promptTokens, candidatesTokenCount: 0 };
      await generate(publicName, secret, hello).expect(200);
    }

    const costs = (await usageRows(keyId)).map((row) => row.cost);
    expect(costs).toEqual(["0.100000", "0.200000", "0.050000"]);
    const usageSum = await usageCostSum(keyId);
    const balance = await remaining(keyId);
    expect(balance).toBe(moneyMinus(initial, usageSum));
    expect(balance).toBe(await ledgerBalance(keyId));
    expect(balance).toBe("4.650000");
    await expectReleased(keyId);
  });

  // Only a lone request may run on less than its estimate; one that would share
  // credit already held by a request in flight must be refused before the upstream.
  it("rejects a second in-flight request whose reservation does not fit", async () => {
    // 1_000 output tokens at $40 per million is 40_000 micros ($0.04). Empty
    // input adds nothing, so one reservation fits in $0.05 and two do not.
    const { publicName } = await createPricedModel({ output: "40.00" });
    const { keyId, secret } = await createKey({ amount: "0.05" });
    const body = {
      contents: [{ parts: [{ text: "" }] }],
      generationConfig: { maxOutputTokens: 1000 },
    };
    const estimate = estimateReservationMicros({
      request: body,
      rules: [pricingRule("input_tokens", INPUT_PER_MILLION), pricingRule("output_tokens", "40.00")],
      at: new Date(),
      modelOutputTokenLimit: null,
      policy: RESERVATION_POLICY,
    });
    expect(estimate).toEqual({ micros: 40_000n, priced: true });

    fakeFactory.fake.usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 1000 };
    const release = fakeFactory.fake.hold();
    const first = generate(publicName, secret, body).then((res) => res);
    await vi.waitFor(() => expect(fakeFactory.fake.calls).toHaveLength(1), { timeout: 5_000 });
    expect(await reservations.activeReservedMicros(keyId)).toBe(40_000n);

    let secondSettled = false;
    const secondPromise = generate(publicName, secret, body).then((res) => {
      secondSettled = true;
      return res;
    });
    try {
      await vi.waitFor(() => {
        expect(secondSettled || fakeFactory.fake.calls.length > 1).toBe(true);
      }, { timeout: 5_000 });
      expect(fakeFactory.fake.calls).toHaveLength(1);
      const second = await secondPromise;
      expect(second.status).toBe(429);
      expect(second.headers["content-type"]).toContain("application/json");
      expect(second.body).toEqual({
        error: {
          code: 429,
          message: "API key credit has been exhausted.",
          status: "RESOURCE_EXHAUSTED",
        },
      });
    } finally {
      release();
      const [completed] = await Promise.all([first, secondPromise]);
      expect(completed.status).toBe(200);
    }

    const balance = await remaining(keyId);
    expect(toMicros(balance) >= 0n).toBe(true);
    expect(balance).toBe("0.010000");
    await expectReleased(keyId);
  });

  it("refuses a reservation that raced a settlement onto a stale balance", async () => {
    const { publicName } = await createPricedModel({ output: "40.00" });
    const { keyId, secret } = await createKey({ amount: "0.05" });
    const body = {
      contents: [{ parts: [{ text: "" }] }],
      generationConfig: { maxOutputTokens: 1000 },
    };
    fakeFactory.fake.usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 1000 };

    const ledger = app.get(CreditLedgerService);
    const original = ledger.remainingMicros.bind(ledger);
    let pauseNext = false;
    let captured = false;
    let resumeRead = (): void => {};
    const readPaused = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    const spy = vi.spyOn(ledger, "remainingMicros").mockImplementation(async (apiKeyId, manager) => {
      const balance = await original(apiKeyId, manager);
      if (pauseNext) {
        pauseNext = false;
        captured = true;
        await readPaused;
        return balance;
      }
      return balance;
    });

    const release = fakeFactory.fake.hold();
    const first = generate(publicName, secret, body).then((res) => res);
    try {
      await vi.waitFor(() => expect(fakeFactory.fake.calls).toHaveLength(1), { timeout: 5_000 });
      pauseNext = true;
      const second = generate(publicName, secret, body).then((res) => res);
      await vi.waitFor(() => expect(captured).toBe(true), { timeout: 5_000 });

      release();
      const completed = await first;
      expect(completed.status).toBe(200);
      expect(await remaining(keyId)).toBe("0.010000");

      resumeRead();
      const refused = await second;
      expect(refused.status).toBe(429);
      expect(refused.body).toEqual({
        error: {
          code: 429,
          message: "API key credit has been exhausted.",
          status: "RESOURCE_EXHAUSTED",
        },
      });
      expect(fakeFactory.fake.calls).toHaveLength(1);
      await expectReleased(keyId);
    } finally {
      release();
      resumeRead();
      spy.mockRestore();
    }
  });

  it("serves again after a manual top-up of an empty balance", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "0" });
    fakeFactory.fake.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };

    const blocked = await generate(publicName, secret, hello);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: {
        code: 429,
        message: "API key credit has been exhausted.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(fakeFactory.fake.calls).toHaveLength(0);
    expect(await remaining(keyId)).toBe("0");

    await addCredit(keyId, "5.00");
    expect(await remaining(keyId)).toBe("5.000000");

    await generate(publicName, secret, hello).expect(200);
    expect(await remaining(keyId)).toBe("4.900000");
    await expectReleased(keyId);
  });

  it("keeps balance, ledger, usage, and limits when the raw key is regenerated", async () => {
    const { publicName } = await createPricedModel();
    const limits = {
      requestsPerMinute: 7,
      maxConcurrentRequests: 3,
      tokensPerDay: 500,
      allowedModels: [publicName],
    };
    const { keyId, secret } = await createKey({ amount: "5.00", limits });
    fakeFactory.fake.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };
    await generate(publicName, secret, hello).expect(200);

    const beforeRemaining = await remaining(keyId);
    const beforeLedger = await ledgerRows(keyId);
    const beforeUsage = await usageRows(keyId);
    const beforeKey = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}`)
      .set("Cookie", cookie)
      .expect(200);

    const regenerated = await request(app.getHttpServer())
      .post(`/admin/api-keys/${keyId}/regenerate`)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrfToken)
      .expect(200);
    const newSecret = regenerated.body.rawKey as string;
    expect(newSecret).not.toBe(secret);

    const stale = await generate(publicName, secret, hello);
    expect(stale.status).toBe(401);
    expect(stale.body).toEqual({
      error: {
        code: 401,
        message: "API key not valid. Please pass a valid API key.",
        status: "UNAUTHENTICATED",
      },
    });

    expect(await remaining(keyId)).toBe(beforeRemaining);
    expect(await ledgerRows(keyId)).toEqual(beforeLedger);
    expect(await usageRows(keyId)).toEqual(beforeUsage);
    const afterKey = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(afterKey.body.apiKey).toMatchObject(limits);
    expect(beforeKey.body.apiKey).toMatchObject(limits);

    // A missing model fails after authentication and writes no usage, so this
    // checks the new secret without moving the balance just compared.
    const authed = await request(app.getHttpServer())
      .post("/v1beta/models/missing-model:generateContent")
      .set("x-goog-api-key", newSecret)
      .send(hello);
    expect(authed.status).toBe(404);
    expect(await remaining(keyId)).toBe(beforeRemaining);
    expect(await ledgerRows(keyId)).toEqual(beforeLedger);
    expect(await usageRows(keyId)).toEqual(beforeUsage);
    await expectReleased(keyId);
  });

  it("bills each request with the price that was effective for it", async () => {
    const { modelId, publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    fakeFactory.fake.usageMetadata = { promptTokenCount: 100_000, candidatesTokenCount: 0 };

    const first = await generate(publicName, secret, hello).expect(200);
    const [original] = await usageRows(keyId);
    expect(original?.cost).toBe("0.100000");
    const originalSnapshot = original?.snapshot;

    await addPrice(modelId, "input_tokens", "4.00");

    const second = await generate(publicName, secret, hello).expect(200);
    const rows = await usageRows(keyId);
    const kept = rows.find((row) => row.requestId === requestIdOf(first));
    const repriced = rows.find((row) => row.requestId === requestIdOf(second));
    expect(kept?.cost).toBe("0.100000");
    expect(kept?.snapshot).toEqual(originalSnapshot);
    expect(repriced?.cost).toBe("0.400000");
    expect(repriced?.snapshot).not.toEqual(originalSnapshot);
    await expectReleased(keyId);
  });

  // Absent or unusable usageMetadata is not turned into a guessed token count.
  // usageQuantitiesFromMetadata returns no quantities and complete=false, so
  // settlement stores cost_undetermined with a null calculated_cost and writes
  // no cost_consumed debit (an incomplete breakdown is not billable, even though
  // calculateCost still produced a zero total). The reservation taken beforehand
  // is the request estimate, not the unknown usage, and settle releases it
  // unconditionally, so the balance does not move.
  it("does not invent a debit when usage metadata is missing or malformed", async () => {
    const { publicName } = await createPricedModel();
    const { keyId, secret } = await createKey({ amount: "5.00" });
    const estimate = estimateReservationMicros({
      request: hello,
      rules: [
        pricingRule("input_tokens", INPUT_PER_MILLION),
        pricingRule("output_tokens", OUTPUT_PER_MILLION),
      ],
      at: new Date(),
      modelOutputTokenLimit: null,
      policy: RESERVATION_POLICY,
    });
    expect(estimate.priced).toBe(true);
    expect(estimate.micros > 0n).toBe(true);

    async function oneUnknown(mode: "absent" | "malformed"): Promise<void> {
      fakeFactory.fake.calls = [];
      fakeFactory.fake.omitUsageMetadata = mode === "absent";
      fakeFactory.fake.usageMetadata = { promptTokenCount: "100", candidatesTokenCount: -1 };
      const before = await remaining(keyId);
      const release = fakeFactory.fake.hold();
      const pending = generate(publicName, secret, hello).then((res) => res);
      try {
        await vi.waitFor(() => expect(fakeFactory.fake.calls).toHaveLength(1), { timeout: 5_000 });
        expect(await reservations.activeReservedMicros(keyId)).toBe(estimate.micros);
      } finally {
        release();
      }
      const res = await pending;
      expect(res.status).toBe(200);
      const [row] = (await usageRows(keyId)).filter((entry) => entry.requestId === requestIdOf(res));
      expect(row?.input).toBeNull();
      expect(row?.output).toBeNull();
      expect(row?.cost).toBeNull();
      expect(row?.undetermined).toBe(true);
      expect(row?.snapshot).not.toBeNull();
      expect(await remaining(keyId)).toBe(before);
      await expectReleased(keyId);
    }

    await oneUnknown("absent");
    await oneUnknown("malformed");
    expect((await ledgerRows(keyId)).map((row) => row.type)).toEqual(["credit_added"]);
  });
});
