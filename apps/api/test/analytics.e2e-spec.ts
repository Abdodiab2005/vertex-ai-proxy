import { ApiKeyStatus, CreditTransactionType } from "@gateway/contracts";
import { ApiKey, Upstream } from "@gateway/database";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsClock } from "../src/analytics/analytics-clock.js";
import { bootstrapOwner } from "../src/cli/bootstrap-owner.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { RedisService } from "../src/redis/redis.service.js";
import { cookieHeaderValue, createE2eApp, resetE2eState, sessionCookie } from "./e2e-app.js";

const OWNER_PASSWORD = "correct-horse-1";
const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Session {
  cookieHeader: string;
  csrfToken: string;
}

interface Fixture {
  upstreamA: string;
  upstreamB: string;
  flash: string;
  pro: string;
  alpha: { id: string; keyPrefix: string };
  beta: { id: string; keyPrefix: string };
}

describe("analytics and usage", () => {
  let app: NestExpressApplication | undefined;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;
  let session: Session;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: AnalyticsClock, useValue: { now: () => FIXED_NOW } }],
    });
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetE2eState(requiredApp());
    session = await login();
  });

  it("reports an empty ledger as zero decimals and zero-filled buckets", async () => {
    const overview = await authed().get("/admin/analytics/overview").query({ range: "24h" });
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      range: { from: "2026-06-14T12:00:00.000Z", to: "2026-06-15T12:00:00.000Z" },
      requestsToday: 0,
      requestsThisMonth: 0,
      requestsInRange: 0,
      inputTokensInRange: "0",
      outputTokensInRange: "0",
      costToday: "0.000000",
      costThisMonth: "0.000000",
      costInRange: "0.000000",
      credit: {
        totalAllocated: "0.000000",
        totalConsumed: "0.000000",
        totalRemaining: "0.000000",
      },
      keys: { active: 0, suspended: 0, revoked: 0, expired: 0, creditExhausted: 0 },
      topKeys: [],
      topModels: [],
      currentRpm: 0,
      errorRate: "0.0000",
      activeStreams: 0,
      upstreams: [],
    });

    const requests = await authed().get("/admin/analytics/timeseries").query({
      metric: "requests",
      range: "24h",
    });
    expect(requests.status).toBe(200);
    expect(requests.body).toEqual({ bucket: "hour", points: hourlyPoints({}) });

    const cost = await authed().get("/admin/analytics/timeseries").query({ metric: "cost", range: "24h" });
    expect(cost.body.points.every((point: { value: string }) => point.value === "0.000000")).toBe(true);

    const usage = await authed().get("/admin/usage");
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({
      range: { from: "2026-05-16T12:00:00.000Z", to: "2026-06-15T12:00:00.000Z" },
      totals: {
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        partialCount: 0,
        inputTokens: "0",
        outputTokens: "0",
        otherUsage: {},
        cost: "0.000000",
        costUndeterminedCount: 0,
        avgLatencyMs: null,
      },
      byDay: [],
      byModel: [],
      byKey: [],
    });

    const csv = await authed().get("/admin/usage/export.csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.headers["content-disposition"]).toContain('filename="usage.csv"');
    expect(csv.text).toBe(
      "day,apiKeyId,keyName,keyPrefix,modelId,modelPublicName,requestCount,successCount,errorCount,partialCount,inputTokens,outputTokens,otherUsage,cost,costUndeterminedCount,avgLatencyMs\r\n",
    );
  });

  it("matches the hand totals for the frozen 24h window", async () => {
    const fixture = await seed();
    const overview = await authed().get("/admin/analytics/overview").query({ range: "24h" });
    expect(overview.status).toBe(200);
    expect(overview.body).toEqual({
      range: { from: "2026-06-14T12:00:00.000Z", to: "2026-06-15T12:00:00.000Z" },
      requestsToday: 5,
      requestsThisMonth: 9,
      requestsInRange: 6,
      inputTokensInRange: "183",
      outputTokensInRange: "74",
      costToday: "13.740000",
      costThisMonth: "21.935000",
      costInRange: "3.905000",
      credit: {
        totalAllocated: "135.500000",
        totalConsumed: "14.000000",
        totalRemaining: "121.500000",
      },
      keys: { active: 2, suspended: 1, revoked: 1, expired: 1, creditExhausted: 1 },
      topKeys: [
        {
          apiKeyId: fixture.beta.id,
          name: 'Beta "team", west',
          keyPrefix: fixture.beta.keyPrefix,
          requests: 2,
          cost: "2.125000",
        },
        {
          apiKeyId: fixture.alpha.id,
          name: "Alpha",
          keyPrefix: fixture.alpha.keyPrefix,
          requests: 4,
          cost: "1.780000",
        },
      ],
      topModels: [
        { modelId: fixture.pro, publicName: "gemini-2.5-pro", requests: 2, cost: "2.000000" },
        { modelId: fixture.flash, publicName: "gemini-2.5-flash", requests: 4, cost: "1.905000" },
      ],
      currentRpm: 2,
      errorRate: "0.3333",
      activeStreams: 3,
      upstreams: [
        {
          id: fixture.upstreamA,
          name: "vertex-a",
          enabled: true,
          status: "connected",
          lastCheckedAt: "2026-06-15T11:00:00.000Z",
        },
        {
          id: fixture.upstreamB,
          name: "vertex-b",
          enabled: false,
          status: "unknown",
          lastCheckedAt: null,
        },
      ],
    });

    const week = await authed().get("/admin/analytics/overview").query({ range: "7d" });
    expect(week.body.requestsInRange).toBe(8);
    expect(week.body.costInRange).toBe("11.945000");

    const month = await authed().get("/admin/analytics/overview").query({ range: "30d" });
    expect(month.body.requestsInRange).toBe(9);
    expect(month.body.costInRange).toBe("12.445000");

    const ignoredPresetBounds = await authed().get("/admin/analytics/overview").query({
      range: "24h",
      from: "2020-01-01T00:00:00.000Z",
      to: "2020-01-02T00:00:00.000Z",
    });
    expect(ignoredPresetBounds.body.requestsInRange).toBe(6);
    expect(ignoredPresetBounds.body.range).toEqual({
      from: "2026-06-14T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
    });

    const historical = await authed().get("/admin/analytics/overview").query({
      range: "custom",
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-02T00:00:00.000Z",
    });
    expect(historical.status).toBe(200);
    expect(historical.body.requestsInRange).toBe(0);
    expect(historical.body.costInRange).toBe("0.000000");
    expect(historical.body.errorRate).toBe("0.0000");
    expect(historical.body.topKeys).toEqual([]);
    expect(historical.body.currentRpm).toBe(2);
    expect(historical.body.credit.totalRemaining).toBe("121.500000");
    expect(historical.body.requestsToday).toBe(5);
  });

  it("zero-fills hourly and daily timeseries points", async () => {
    await seed();

    const requests = await authed().get("/admin/analytics/timeseries").query({
      metric: "requests",
      range: "24h",
    });
    expect(requests.body).toEqual({
      bucket: "hour",
      points: hourlyPoints({
        "2026-06-14T12:00:00.000Z": "1",
        "2026-06-14T18:00:00.000Z": "1",
        "2026-06-15T08:00:00.000Z": "1",
        "2026-06-15T09:00:00.000Z": "1",
        "2026-06-15T10:00:00.000Z": "1",
        "2026-06-15T11:00:00.000Z": "1",
      }),
    });

    const tokens = await authed().get("/admin/analytics/timeseries").query({
      metric: "tokens",
      range: "24h",
    });
    expect(tokens.body.points).toEqual(
      hourlyPoints({
        "2026-06-14T12:00:00.000Z": "7",
        "2026-06-14T18:00:00.000Z": "15",
        "2026-06-15T08:00:00.000Z": "75",
        "2026-06-15T10:00:00.000Z": "20",
        "2026-06-15T11:00:00.000Z": "140",
      }),
    );

    const cost = await authed().get("/admin/analytics/timeseries").query({ metric: "cost", range: "24h" });
    expect(cost.body.points).toEqual(
      hourlyPoints(
        {
          "2026-06-14T12:00:00.000Z": "0.030000",
          "2026-06-14T18:00:00.000Z": "0.125000",
          "2026-06-15T08:00:00.000Z": "2.000000",
          "2026-06-15T10:00:00.000Z": "0.250000",
          "2026-06-15T11:00:00.000Z": "1.500000",
        },
        "0.000000",
      ),
    );

    const errors = await authed().get("/admin/analytics/timeseries").query({
      metric: "errors",
      range: "24h",
    });
    expect(errors.body.points).toEqual(
      hourlyPoints({
        "2026-06-14T18:00:00.000Z": "1",
        "2026-06-15T10:00:00.000Z": "1",
      }),
    );

    const week = await authed().get("/admin/analytics/timeseries").query({ metric: "requests", range: "7d" });
    expect(week.body).toEqual({
      bucket: "day",
      points: dailyPoints("2026-06-08T00:00:00.000Z", 8, {
        "2026-06-10T00:00:00.000Z": "1",
        "2026-06-14T00:00:00.000Z": "3",
        "2026-06-15T00:00:00.000Z": "4",
      }),
    });

    const month = await authed().get("/admin/analytics/timeseries").query({
      metric: "requests",
      range: "30d",
    });
    expect(month.body.bucket).toBe("day");
    expect(month.body.points).toHaveLength(31);
    expect(month.body.points[0]).toEqual({ t: "2026-05-16T00:00:00.000Z", value: "0" });
    expect(month.body.points[4]).toEqual({ t: "2026-05-20T00:00:00.000Z", value: "1" });
    expect(month.body.points[30]).toEqual({ t: "2026-06-15T00:00:00.000Z", value: "4" });
  });

  it("totals usage, applies filters, and sums other dimensions", async () => {
    const fixture = await seed();
    const usage = await authed().get("/admin/usage");
    expect(usage.status).toBe(200);
    expect(usage.body.range).toEqual({
      from: "2026-05-16T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
    });
    expect(usage.body.totals).toEqual({
      requestCount: 9,
      successCount: 5,
      errorCount: 3,
      partialCount: 1,
      inputTokens: "1194",
      outputTokens: "588",
      otherUsage: {
        cachedInputTokens: "15",
        imageUnits: "3",
        reasoningTokens: "2",
      },
      cost: "12.445000",
      costUndeterminedCount: 1,
      avgLatencyMs: 137,
    });
    expect(usage.body.byDay).toEqual([
      { day: "2026-05-20", requests: 1, cost: "0.500000" },
      { day: "2026-06-10", requests: 1, cost: "8.000000" },
      { day: "2026-06-14", requests: 3, cost: "0.195000" },
      { day: "2026-06-15", requests: 4, cost: "3.750000" },
    ]);
    expect(usage.body.byModel).toEqual([
      { modelId: fixture.flash, publicName: "gemini-2.5-flash", requests: 6, cost: "9.945000" },
      { modelId: fixture.pro, publicName: "gemini-2.5-pro", requests: 3, cost: "2.500000" },
    ]);
    expect(usage.body.byKey).toEqual([
      {
        apiKeyId: fixture.alpha.id,
        name: "Alpha",
        keyPrefix: fixture.alpha.keyPrefix,
        requests: 5,
        cost: "9.780000",
      },
      {
        apiKeyId: fixture.beta.id,
        name: 'Beta "team", west',
        keyPrefix: fixture.beta.keyPrefix,
        requests: 4,
        cost: "2.665000",
      },
    ]);

    const errors = await authed().get("/admin/usage").query({ status: "error" });
    expect(errors.body.totals).toEqual({
      requestCount: 3,
      successCount: 0,
      errorCount: 3,
      partialCount: 0,
      inputTokens: "34",
      outputTokens: "11",
      otherUsage: { cachedInputTokens: "5" },
      cost: "0.415000",
      costUndeterminedCount: 0,
      avgLatencyMs: 123,
    });

    const alpha = await authed().get("/admin/usage").query({ apiKeyId: fixture.alpha.id });
    expect(alpha.body.totals).toMatchObject({
      requestCount: 5,
      successCount: 4,
      errorCount: 1,
      partialCount: 0,
      inputTokens: "1123",
      outputTokens: "544",
      cost: "9.780000",
      costUndeterminedCount: 1,
      avgLatencyMs: 204,
      otherUsage: { cachedInputTokens: "15", reasoningTokens: "2" },
    });

    const pro = await authed().get("/admin/usage").query({ modelId: fixture.pro });
    expect(pro.body.totals).toMatchObject({
      requestCount: 3,
      successCount: 2,
      partialCount: 1,
      inputTokens: "57",
      outputTokens: "33",
      cost: "2.500000",
      otherUsage: { imageUnits: "3" },
      avgLatencyMs: 105,
    });

    const upstreamB = await authed().get("/admin/usage").query({ upstreamId: fixture.upstreamB });
    expect(upstreamB.body.totals).toMatchObject({
      requestCount: 1,
      errorCount: 1,
      inputTokens: "10",
      outputTokens: "5",
      cost: "0.125000",
      otherUsage: {},
      avgLatencyMs: 50,
    });

    const stream = await authed().get("/admin/usage").query({ endpoint: "streamGenerateContent" });
    expect(stream.body.totals).toMatchObject({
      requestCount: 1,
      partialCount: 1,
      inputTokens: "50",
      outputTokens: "25",
      cost: "2.000000",
      otherUsage: { imageUnits: "3" },
    });

    const june15 = await authed().get("/admin/usage").query({
      from: "2026-06-15T00:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
    });
    expect(june15.body.totals).toMatchObject({
      requestCount: 4,
      successCount: 2,
      errorCount: 1,
      partialCount: 1,
      cost: "3.750000",
    });

    const betaErrors = await authed().get("/admin/usage").query({
      apiKeyId: fixture.beta.id,
      status: "error",
    });
    expect(betaErrors.body.totals).toMatchObject({ requestCount: 2, cost: "0.165000" });
  });

  it("exports one RFC 4180 row per day, key, and model", async () => {
    const fixture = await seed();
    const csv = await authed().get("/admin/usage/export.csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain('filename="usage.csv"');
    expect(csv.text).toBe(expectedCsv(fixture));

    const errors = await authed().get("/admin/usage/export.csv").query({ status: "error" });
    expect(errors.text).toBe(expectedErrorCsv(fixture));
  });

  it("rejects invalid ranges and requires an admin session", async () => {
    const missingCustom = await authed().get("/admin/analytics/overview").query({ range: "custom" });
    expectIssue(missingCustom, "custom range requires from and to");

    const missingTo = await authed().get("/admin/analytics/timeseries").query({
      metric: "cost",
      range: "custom",
      from: "2026-06-01T00:00:00.000Z",
    });
    expectIssue(missingTo, "custom range requires from and to");

    const inverted = await authed().get("/admin/analytics/overview").query({
      range: "custom",
      from: "2026-06-15T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
    });
    expectIssue(inverted, "to must be after from");

    const tooLongFrom = "2024-01-01T00:00:00.000Z";
    const tooLongTo = new Date(Date.parse(tooLongFrom) + 366 * DAY_MS + 1).toISOString();
    const tooLong = await authed().get("/admin/analytics/overview").query({
      range: "custom",
      from: tooLongFrom,
      to: tooLongTo,
    });
    expectIssue(tooLong, "range cannot exceed 366 days");

    const exact = await authed().get("/admin/analytics/overview").query({
      range: "custom",
      from: tooLongFrom,
      to: new Date(Date.parse(tooLongFrom) + 366 * DAY_MS).toISOString(),
    });
    expect(exact.status).toBe(200);
    expect(exact.body.requestsInRange).toBe(0);

    const badMetric = await authed().get("/admin/analytics/timeseries").query({ metric: "latency" });
    expectIssue(badMetric, "metric");

    const usageOneSided = await authed().get("/admin/usage").query({ from: "2026-06-01T00:00:00.000Z" });
    expectIssue(usageOneSided, "from and to must be provided together");

    const usageInverted = await authed().get("/admin/usage").query({
      from: "2026-06-15T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
    });
    expectIssue(usageInverted, "to must be after from");

    const badStatus = await authed().get("/admin/usage").query({ status: "timeout" });
    expectIssue(badStatus, "status");

    for (const path of [
      "/admin/analytics/overview",
      "/admin/analytics/timeseries?metric=requests",
      "/admin/usage",
      "/admin/usage/export.csv",
    ]) {
      const anonymous = await request(httpServer).get(path);
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toMatchObject({ statusCode: 401, message: "Unauthorized" });
    }
  });

  function requiredApp(): NestExpressApplication {
    if (app === undefined) {
      throw new Error("E2E app was not started");
    }
    return app;
  }

  function authed() {
    return {
      get: (url: string) => request(httpServer).get(url).set("Cookie", session.cookieHeader),
      post: (url: string) =>
        request(httpServer).post(url).set("Cookie", session.cookieHeader).set("x-csrf-token", session.csrfToken),
    };
  }

  async function login(): Promise<Session> {
    await bootstrapOwner(requiredApp().get(DataSource), new PasswordHasher(), {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    });
    const response = await request(httpServer)
      .post("/admin/auth/login")
      .send({ email: "owner@example.com", password: OWNER_PASSWORD });
    expect(response.status).toBe(200);
    return {
      csrfToken: response.body.csrfToken as string,
      cookieHeader: cookieHeaderValue(sessionCookie(response)),
    };
  }

  async function seed(): Promise<Fixture> {
    const db = requiredApp().get(DataSource);
    const upstreamA = await db.getRepository(Upstream).save({
      name: "vertex-a",
      enabled: true,
      projectId: "project-1",
      location: "us-central1",
      authMethod: "application-default-credentials",
      priority: 0,
      status: "connected",
      lastCheckedAt: new Date("2026-06-15T11:00:00.000Z"),
    });
    const upstreamB = await db.getRepository(Upstream).save({
      name: "vertex-b",
      enabled: false,
      projectId: "project-2",
      location: "us-central1",
      authMethod: "application-default-credentials",
      priority: 1,
      status: "unknown",
      lastCheckedAt: null,
    });
    const http = authed();
    const flash = await http.post("/admin/models").send({
      publicName: "gemini-2.5-flash",
      upstreamModelName: "gemini-2.5-flash",
      displayName: "Flash",
      upstreamId: upstreamA.id,
    });
    expect(flash.status).toBe(201);
    const pro = await http.post("/admin/models").send({
      publicName: "gemini-2.5-pro",
      upstreamModelName: "gemini-2.5-pro",
      displayName: "Pro",
      upstreamId: upstreamA.id,
    });
    expect(pro.status).toBe(201);

    const alpha = await createKey("Alpha");
    const beta = await createKey('Beta "team", west');
    const suspended = await createKey("Suspended key");
    const revoked = await createKey("Revoked key");
    const expired = await createKey("Expired key");
    const exhausted = await createKey("Exhausted key");
    expect((await http.post(`/admin/api-keys/${suspended.id}/suspend`)).status).toBe(201);
    expect((await http.post(`/admin/api-keys/${revoked.id}/revoke`)).status).toBe(201);
    await db.getRepository(ApiKey).update({ id: expired.id }, { status: ApiKeyStatus.EXPIRED });
    await db.getRepository(ApiKey).update({ id: exhausted.id }, { status: ApiKeyStatus.CREDIT_EXHAUSTED });

    await insertCredit(alpha.id, CreditTransactionType.CREDIT_ADDED, "100.000000");
    await insertCredit(alpha.id, CreditTransactionType.CREDIT_REMOVED, "-20.000000");
    await insertCredit(alpha.id, CreditTransactionType.REFUND, "5.000000");
    await insertCredit(alpha.id, CreditTransactionType.MANUAL_ADJUSTMENT, "-1.500000");
    await insertCredit(alpha.id, CreditTransactionType.COST_CONSUMED, "-10.250000");
    await insertCredit(alpha.id, CreditTransactionType.COST_CONSUMED, "-0.750000");
    await insertCredit(beta.id, CreditTransactionType.CREDIT_ADDED, "50.000000");
    await insertCredit(beta.id, CreditTransactionType.COST_CONSUMED, "-3.000000");
    await insertCredit(beta.id, CreditTransactionType.MANUAL_ADJUSTMENT, "2.000000");

    const flashId = flash.body.model.id as string;
    const proId = pro.body.model.id as string;
    await insertUsage({
      requestId: "req-rpm",
      apiKeyId: alpha.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: "100",
      outputTokens: "40",
      other: { cachedInputTokens: 10, reasoningTokens: 2, note: "included-text" },
      cost: "1.500000",
      latencyMs: 100,
      createdAt: "2026-06-15T11:59:30.000Z",
      pricingSnapshot: { lines: [{ dimension: "input_tokens", cost: "1.500000" }] },
    });
    await insertUsage({
      requestId: "req-today-error",
      apiKeyId: alpha.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "error",
      inputTokens: "20",
      outputTokens: "0",
      other: { cachedInputTokens: 5 },
      cost: "0.250000",
      latencyMs: 300,
      createdAt: "2026-06-15T10:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-partial",
      apiKeyId: beta.id,
      modelId: proId,
      upstreamId: upstreamA.id,
      endpoint: "streamGenerateContent",
      status: "partial",
      inputTokens: "50",
      outputTokens: "25",
      other: { imageUnits: 3 },
      cost: "2.000000",
      latencyMs: 200,
      createdAt: "2026-06-15T08:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-undetermined",
      apiKeyId: alpha.id,
      modelId: proId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: null,
      outputTokens: null,
      other: null,
      cost: null,
      costUndetermined: true,
      latencyMs: null,
      createdAt: "2026-06-15T09:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-yesterday-error",
      apiKeyId: beta.id,
      modelId: flashId,
      upstreamId: upstreamB.id,
      endpoint: "embedContent",
      status: "error",
      inputTokens: "10",
      outputTokens: "5",
      other: null,
      cost: "0.125000",
      latencyMs: 50,
      createdAt: "2026-06-14T18:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-boundary-from",
      apiKeyId: alpha.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: "3",
      outputTokens: "4",
      other: null,
      cost: "0.030000",
      latencyMs: 15,
      createdAt: "2026-06-14T12:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-week",
      apiKeyId: alpha.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: "1000",
      outputTokens: "500",
      other: null,
      cost: "8.000000",
      latencyMs: 400,
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-month-only",
      apiKeyId: beta.id,
      modelId: proId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: "7",
      outputTokens: "8",
      other: null,
      cost: "0.500000",
      latencyMs: 10,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-outside",
      apiKeyId: alpha.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "success",
      inputTokens: "1",
      outputTokens: "1",
      other: null,
      cost: "0.010000",
      latencyMs: 5,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-exact-now",
      apiKeyId: beta.id,
      modelId: proId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "error",
      inputTokens: "999",
      outputTokens: "999",
      other: null,
      cost: "9.990000",
      latencyMs: 1000,
      createdAt: "2026-06-15T12:00:00.000Z",
    });
    await insertUsage({
      requestId: "req-before-24h",
      apiKeyId: beta.id,
      modelId: flashId,
      upstreamId: upstreamA.id,
      endpoint: "generateContent",
      status: "error",
      inputTokens: "4",
      outputTokens: "6",
      other: null,
      cost: "0.040000",
      latencyMs: 20,
      createdAt: "2026-06-14T11:00:00.000Z",
    });

    const redis = requiredApp().get(RedisService).client;
    const time = await redis.time();
    const nowMs = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    await redis.zadd(`ratelimit:{${alpha.id}}:concurrency`, nowMs + 60_000, "live-a");
    await redis.zadd(`ratelimit:{${alpha.id}}:concurrency`, nowMs + 30_000, "live-b");
    await redis.zadd(`ratelimit:{${alpha.id}}:concurrency`, nowMs - 1_000, "expired");
    await redis.zadd(`ratelimit:{${beta.id}}:concurrency`, nowMs + 10_000, "live-c");
    await redis.zadd(`ratelimit:${alpha.id}:concurrency`, nowMs + 60_000, "ignored-no-tag");
    await redis.zadd(`other:{${alpha.id}}:concurrency`, nowMs + 60_000, "ignored-prefix");

    return {
      upstreamA: upstreamA.id,
      upstreamB: upstreamB.id,
      flash: flashId,
      pro: proId,
      alpha,
      beta,
    };
  }

  async function createKey(name: string): Promise<{ id: string; keyPrefix: string }> {
    const response = await authed().post("/admin/api-keys").send({ name });
    expect(response.status).toBe(201);
    return {
      id: response.body.apiKey.id as string,
      keyPrefix: response.body.apiKey.keyPrefix as string,
    };
  }

  async function insertCredit(apiKeyId: string, type: CreditTransactionType, amount: string): Promise<void> {
    await requiredApp().get(DataSource).query(
      `INSERT INTO credit_transactions (api_key_id, type, amount, currency, description, created_at)
       VALUES ($1, $2, $3, 'USD', $4, $5::timestamptz)`,
      [apiKeyId, type, amount, type, "2026-06-15T00:00:00.000Z"],
    );
  }

  async function insertUsage(row: {
    requestId: string;
    apiKeyId: string;
    modelId: string;
    upstreamId: string;
    endpoint: string;
    status: "success" | "error" | "partial";
    inputTokens: string | null;
    outputTokens: string | null;
    other: Record<string, unknown> | null;
    cost: string | null;
    costUndetermined?: boolean;
    latencyMs: number | null;
    createdAt: string;
    pricingSnapshot?: Record<string, unknown> | null;
  }): Promise<void> {
    await requiredApp().get(DataSource).query(
      `INSERT INTO usage_records (
         request_id, api_key_id, model_id, upstream_id, endpoint, status,
         input_tokens, output_tokens, other_usage_dimensions, calculated_cost,
         currency, cost_undetermined, pricing_snapshot, latency_ms, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10,
         'USD', $11, $12::jsonb, $13, $14::timestamptz
       )`,
      [
        row.requestId,
        row.apiKeyId,
        row.modelId,
        row.upstreamId,
        row.endpoint,
        row.status,
        row.inputTokens,
        row.outputTokens,
        row.other === null ? null : JSON.stringify(row.other),
        row.cost,
        row.costUndetermined ?? false,
        row.pricingSnapshot === undefined || row.pricingSnapshot === null
          ? null
          : JSON.stringify(row.pricingSnapshot),
        row.latencyMs,
        row.createdAt,
      ],
    );
  }
});

function expectIssue(response: Response, fragment: string): void {
  expect(response.status).toBe(400);
  expect(response.body.error).toBe("Bad Request");
  expect(JSON.stringify(response.body.message)).toContain(fragment);
}

function hourlyPoints(overrides: Record<string, string>, zero = "0"): { t: string; value: string }[] {
  const start = Date.parse("2026-06-14T12:00:00.000Z");
  return Array.from({ length: 24 }, (_, index) => {
    const t = new Date(start + index * HOUR_MS).toISOString();
    return { t, value: overrides[t] ?? zero };
  });
}

function dailyPoints(
  startIso: string,
  count: number,
  overrides: Record<string, string>,
): { t: string; value: string }[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => {
    const t = new Date(start + index * DAY_MS).toISOString();
    return { t, value: overrides[t] ?? "0" };
  });
}

const CSV_HEADER =
  "day,apiKeyId,keyName,keyPrefix,modelId,modelPublicName,requestCount,successCount,errorCount,partialCount,inputTokens,outputTokens,otherUsage,cost,costUndeterminedCount,avgLatencyMs";

function expectedCsv(fixture: Fixture): string {
  const quotedBeta = `"Beta ""team"", west"`;
  const cached = `"{""cachedInputTokens"":""15"",""reasoningTokens"":""2""}"`;
  const images = `"{""imageUnits"":""3""}"`;
  const lines = [
    CSV_HEADER,
    row(fixture, "2026-05-20", "beta", fixture.pro, "gemini-2.5-pro", quotedBeta, [
      "1", "1", "0", "0", "7", "8", "{}", "0.500000", "0", "10",
    ]),
    row(fixture, "2026-06-10", "alpha", fixture.flash, "gemini-2.5-flash", "Alpha", [
      "1", "1", "0", "0", "1000", "500", "{}", "8.000000", "0", "400",
    ]),
    row(fixture, "2026-06-14", "alpha", fixture.flash, "gemini-2.5-flash", "Alpha", [
      "1", "1", "0", "0", "3", "4", "{}", "0.030000", "0", "15",
    ]),
    row(fixture, "2026-06-14", "beta", fixture.flash, "gemini-2.5-flash", quotedBeta, [
      "2", "0", "2", "0", "14", "11", "{}", "0.165000", "0", "35",
    ]),
    row(fixture, "2026-06-15", "alpha", fixture.flash, "gemini-2.5-flash", "Alpha", [
      "2", "1", "1", "0", "120", "40", cached, "1.750000", "0", "200",
    ]),
    row(fixture, "2026-06-15", "alpha", fixture.pro, "gemini-2.5-pro", "Alpha", [
      "1", "1", "0", "0", "0", "0", "{}", "0.000000", "1", "",
    ]),
    row(fixture, "2026-06-15", "beta", fixture.pro, "gemini-2.5-pro", quotedBeta, [
      "1", "0", "0", "1", "50", "25", images, "2.000000", "0", "200",
    ]),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function expectedErrorCsv(fixture: Fixture): string {
  const quotedBeta = `"Beta ""team"", west"`;
  const cached = `"{""cachedInputTokens"":""5""}"`;
  const lines = [
    CSV_HEADER,
    row(fixture, "2026-06-14", "beta", fixture.flash, "gemini-2.5-flash", quotedBeta, [
      "2", "0", "2", "0", "14", "11", "{}", "0.165000", "0", "35",
    ]),
    row(fixture, "2026-06-15", "alpha", fixture.flash, "gemini-2.5-flash", "Alpha", [
      "1", "0", "1", "0", "20", "0", cached, "0.250000", "0", "300",
    ]),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function row(
  fixture: Fixture,
  day: string,
  key: "alpha" | "beta",
  modelId: string,
  modelName: string,
  keyNameField: string,
  metrics: string[],
): string {
  const apiKey = fixture[key];
  return [day, apiKey.id, keyNameField, apiKey.keyPrefix, modelId, modelName, ...metrics].join(",");
}
