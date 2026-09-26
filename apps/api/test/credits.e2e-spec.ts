import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { DataSource } from "typeorm";
import { AdminUser, CreditTransaction, UsageRecord } from "@gateway/database";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { ApiKeyStatus } from "@gateway/contracts";
import { CreditReservationStore } from "../src/credits/credit-reservation.store.js";
import { UsageAccountingService } from "../src/credits/usage-accounting.service.js";

describe("Credits (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;
  

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);

    const hasher = app.get(PasswordHasher);
    const pass = await hasher.hash("password");
    
    const adminRepo = dataSource.getRepository(AdminUser);
    await adminRepo.save({
      email: "admin@example.com",
      passwordHash: pass,
      enabled: true,
    });
    

    const res = await request(app.getHttpServer())
      .post("/admin/auth/login")
      .send({ email: "admin@example.com", password: "password" });
    
    sessionHeader = cookieHeaderValue(sessionCookie(res));
    csrfToken = res.body.csrfToken;

    // Create upstream and model for foreign key constraints in usage_records

    // If POST /admin/upstreams is not available, we could insert manually:
    // We will do manual insert to be safe since I don't know the exact DTO
    const { Upstream, Model } = await import("@gateway/database");
    
    const upstream = await dataSource.getRepository(Upstream).save({
      name: "Test Upstream",
      projectId: "test-project",
      location: "us-central1",
      authMethod: "service_account",
      apiUrl: "https://example.com/v1",
      credentials: {},
      status: "active",
      healthStatus: "healthy"
    });

    await dataSource.getRepository(Model).save({
      id: "00000000-0000-0000-0000-000000000001",
      publicName: "test-model",
      upstreamModelName: "test-model",
      displayName: "Test Model",
      provider: "google",
      upstreamId: upstream.id
    });
  });

  async function createKey(initialCredit?: string) {
    const payload: Record<string, unknown> = { name: "Test Key" };
    if (initialCredit) payload.initialCredit = initialCredit;
    const res = await request(app.getHttpServer())
      .post("/admin/api-keys")
      .set("Cookie", sessionHeader)
      .set("X-CSRF-Token", csrfToken)
      .send(payload);
    expect(res.status).toBe(201);
    return res.body.apiKey.id;
  }

  async function addCredit(id: string, payload: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/admin/api-keys/${id}/credits`)
      .set("Cookie", sessionHeader)
      .set("X-CSRF-Token", csrfToken)
      .send(payload);
  }

  it("admin credit endpoints: validations and audit", async () => {
    const keyId = await createKey();

    // Requires description for removed, refund, manual_adjustment
    for (const type of ["credit_removed", "refund", "manual_adjustment"]) {
      const res = await addCredit(keyId, { type, amount: "10.0" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message).toLowerCase()).toContain("description");
    }

    // Sign rules
    const resNegative = await addCredit(keyId, { type: "credit_added", amount: "-10.0" });
    expect(resNegative.status).toBe(400);
    expect(JSON.stringify(resNegative.body.message)).toContain("Invalid sign");

    const resZero = await addCredit(keyId, { type: "credit_added", amount: "0.0" });
    expect(resZero.status).toBe(400);

    const resManualZero = await addCredit(keyId, { type: "manual_adjustment", amount: "0", description: "foo" });
    expect(resManualZero.status).toBe(400);

    // 404 for unknown key
    const res404 = await addCredit("00000000-0000-0000-0000-000000000000", { type: "credit_added", amount: "10.0" });
    expect(res404.status).toBe(404);

    // Requires CSRF
    const resCsrf = await request(app.getHttpServer())
      .post(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", sessionHeader)
      .send({ type: "credit_added", amount: "10.0" });
    expect(resCsrf.status).toBe(403);
  });

  it("summary math across all types", async () => {
    const keyId = await createKey();

    await addCredit(keyId, { type: "credit_added", amount: "100.50" }); // +100.5
    await addCredit(keyId, { type: "credit_removed", amount: "10.25", description: "test" }); // -10.25
    await addCredit(keyId, { type: "refund", amount: "5.00", description: "test" }); // +5.0
    await addCredit(keyId, { type: "manual_adjustment", amount: "-2.00", description: "test" }); // -2.0

    // consumed is via settle usually, but let's test manual insertion if possible, or just what we have
    // Actually, manual_adjustment can be positive too
    await addCredit(keyId, { type: "manual_adjustment", amount: "1.00", description: "test" }); // +1.0 (net -1.0)

    const res = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/credits`)
      .set("Cookie", sessionHeader);

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual(expect.objectContaining({
      totalAdded: "100.500000",
      totalRemoved: "-10.250000",
      totalRefunded: "5.000000",
      adjustmentsNet: "-1.000000",
      remaining: "94.250000" // 100.5 - 10.25 + 5 - 1 = 94.25
    }));
  });

  it("ledger is append-only and check constraint works", async () => {
    const keyId = await createKey("10.0");

    const tx = await dataSource.getRepository(CreditTransaction).findOne({ where: { apiKeyId: keyId } });
    expect(tx).toBeDefined();

    // UPDATE fails
    await expect(
      dataSource.query(`UPDATE credit_transactions SET amount = '20.0' WHERE id = '${tx!.id}'`)
    ).rejects.toThrow(/credit_transactions is append-only/);

    // DELETE fails
    await expect(
      dataSource.query(`DELETE FROM credit_transactions WHERE id = '${tx!.id}'`)
    ).rejects.toThrow(/credit_transactions is append-only/);

    // Wrong signed row inserted directly fails
    await expect(
      dataSource.query(`INSERT INTO credit_transactions (api_key_id, type, amount, currency) VALUES ('${keyId}', 'credit_added', '-5.0', 'USD')`)
    ).rejects.toThrow(/new row for relation "credit_transactions" violates check constraint/);
  });

  it("initialCredit and list/get views carry credit", async () => {
    const keyId = await createKey("50.00");

    const listRes = await request(app.getHttpServer())
      .get("/admin/api-keys")
      .set("Cookie", sessionHeader);
    
    const key = listRes.body.apiKeys.find((k: { id: string, credit: { remaining: string, consumed: string } }) => k.id === keyId);
    expect(key.credit).toBeDefined();
    expect(key.credit.remaining).toBe("50.000000");
    expect(key.credit.consumed).toBe("0");

    const getRes = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}`)
      .set("Cookie", sessionHeader);
    expect(getRes.body.apiKey.credit.remaining).toBe("50.000000");
  });

  it("status flips credit_exhausted <-> active", async () => {
    const keyId = await createKey("1.00");

    const getStatus = async () => {
      const { body } = await request(app.getHttpServer()).get(`/admin/api-keys/${keyId}`).set("Cookie", sessionHeader);
      return body.apiKey.status;
    };

    expect(await getStatus()).toBe(ApiKeyStatus.ACTIVE);

    // Remove more than balance -> exhaust
    await addCredit(keyId, { type: "credit_removed", amount: "2.00", description: "test" });
    expect(await getStatus()).toBe(ApiKeyStatus.CREDIT_EXHAUSTED);

    // Add back -> active
    await addCredit(keyId, { type: "credit_added", amount: "5.00" });
    expect(await getStatus()).toBe(ApiKeyStatus.ACTIVE);

    // Suspend
    await request(app.getHttpServer()).post(`/admin/api-keys/${keyId}/suspend`).set("Cookie", sessionHeader).set("X-CSRF-Token", csrfToken);
    expect(await getStatus()).toBe(ApiKeyStatus.SUSPENDED);

    // Append credit, should stay suspended
    await addCredit(keyId, { type: "credit_added", amount: "5.00" });
    expect(await getStatus()).toBe(ApiKeyStatus.SUSPENDED);
  });

  it("reservations concurrent limits and reclamation", async () => {
    const keyId = await createKey();
    const reservationStore = app.get(CreditReservationStore);

    // balance = 100,000 micros, 10 concurrent calls of 30,000 micros. Three fit; the 10,000 left
    // can't be shared with a fourth while the others hold theirs, so the other seven are refused.
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(reservationStore.reserve(keyId, 100000n, 30000n, 5000));
    }
    const results = await Promise.all(promises);

    let totalReserved = 0n;
    for (const r of results) {
      if (r.allowed) totalReserved += r.reservedMicros;
    }

    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(totalReserved).toBe(90000n);

    const active = await reservationStore.activeReservedMicros(keyId);
    expect(active).toBe(90000n);

    // Alone, a request may still run on less than its estimate.
    const soloKeyId = await createKey();
    const solo = await reservationStore.reserve(soloKeyId, 10000n, 30000n, 5000);
    expect(solo).toEqual(expect.objectContaining({ allowed: true, reservedMicros: 10000n }));

    // Idempotent release
    const validRes = results.find(r => r.allowed) as { allowed: true; reservationId: string; reservedMicros: bigint };
    await reservationStore.release(keyId, validRes.reservationId);
    await reservationStore.release(keyId, validRes.reservationId); // idempotent
    
    const activeAfterRelease = await reservationStore.activeReservedMicros(keyId);
    expect(activeAfterRelease).toBe(90000n - validRes.reservedMicros);

    // Test expiry
    const shortRes = await reservationStore.reserve(keyId, 100000n, 30000n, 1);
    expect(shortRes.allowed).toBe(true);
    await new Promise(r => setTimeout(r, 10)); // wait for expiry

    // triggering next reserve will purge
    await reservationStore.reserve(keyId, 100000n, 1n, 5000);
    const activeAfterExpiry = await reservationStore.activeReservedMicros(keyId);
    expect(activeAfterExpiry).toBeLessThanOrEqual(100000n - 30000n + 1n);
  });

  it("extend keeps a hold past its original lease and returns false when it is gone", async () => {
    const keyId = await createKey();
    const reservationStore = app.get(CreditReservationStore);
    const reserved = await reservationStore.reserve(keyId, 100_000n, 1_000n, 400);
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) {
      return;
    }

    expect(await reservationStore.extend(keyId, reserved.reservationId, 10_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(await reservationStore.activeReservedMicros(keyId)).toBe(reserved.reservedMicros);

    await reservationStore.release(keyId, reserved.reservationId);
    expect(await reservationStore.extend(keyId, reserved.reservationId, 10_000)).toBe(false);
    expect(await reservationStore.extend(keyId, "00000000-0000-0000-0000-000000000000", 10_000)).toBe(false);
    expect(await reservationStore.activeReservedMicros(keyId)).toBe(0n);
  });

  it("settle writes usage record + cost_consumed atomically, handles flips and releases", async () => {
    const keyId = await createKey("10.00");
    const acctService = app.get(UsageAccountingService);
    const reservationStore = app.get(CreditReservationStore);

    const res = await reservationStore.reserve(keyId, 10000000n, 5000000n, 10000); // $5 reserve
    expect(res.allowed).toBe(true);
    const reservationId = (res as { reservationId: string }).reservationId;

    await acctService.settle({
      requestId: "req-1",
      apiKeyId: keyId,
      modelId: "00000000-0000-0000-0000-000000000001",
      upstreamId: null,
      endpoint: "chat",
      status: "success",
      latencyMs: 100,
      quantities: { input_tokens: "100" },
      usageComplete: true,
      breakdown: {
        currency: "USD",
        total: "12.000000",
        lines: [],
        unpricedDimensions: [],
        snapshot: { version: 1, rules: [] }
      },
      reservation: { reservationId }
    });

    const active = await reservationStore.activeReservedMicros(keyId);
    expect(active).toBe(0n); // Released

    const getRes = await request(app.getHttpServer()).get(`/admin/api-keys/${keyId}`).set("Cookie", sessionHeader);
    expect(getRes.body.apiKey.status).toBe(ApiKeyStatus.CREDIT_EXHAUSTED); // balance went -2
    expect(getRes.body.apiKey.credit.remaining).toBe("-2.000000");

    // partial usage Complete = false
    await acctService.settle({
      requestId: "req-2",
      apiKeyId: keyId,
      modelId: "00000000-0000-0000-0000-000000000001",
      upstreamId: null,
      endpoint: "chat",
      status: "success",
      latencyMs: null,
      quantities: { input_tokens: 5000000 },
      usageComplete: false,
      breakdown: {
        currency: "USD",
        total: "5.000000",
        lines: [
          { dimension: "input_tokens", quantity: "5000000", unitSize: "1000000", price: "1.00", currency: "USD", ruleId: "r1", cost: "5.000000" },
        ],
        unpricedDimensions: [],
        snapshot: { version: 1, rules: [] }
      },
      reservation: null
    });

    const ur = await dataSource.getRepository(UsageRecord).findOne({ where: { requestId: "req-2" } });
    expect(ur?.costUndetermined).toBe(true);

    // Incomplete usage still debits what was priced: it is a lower bound, never zero.
    const debit = await dataSource.getRepository(CreditTransaction).findOne({ where: { usageRecordId: ur!.id } });
    expect(debit?.amount).toBe("-5.000000");
  });

  it("usage-summary aggregates byModel and byDimension", async () => {
    const keyId = await createKey();
    const acctService = app.get(UsageAccountingService);

    await acctService.settle({
      requestId: "req-3",
      apiKeyId: keyId,
      modelId: "00000000-0000-0000-0000-000000000001",
      upstreamId: null,
      endpoint: "chat",
      status: "success",
      latencyMs: 100,
      quantities: {},
      usageComplete: true,
      breakdown: {
        currency: "USD",
        total: "1.000000",
        lines: [
          { dimension: "input_tokens", cost: "0.400000" },
          { dimension: "output_tokens", cost: "0.600000" }
        ],
        unpricedDimensions: [],
        snapshot: { version: 1, rules: [] }
      },
      reservation: null
    });

    await acctService.settle({
      requestId: "req-4",
      apiKeyId: keyId,
      modelId: "00000000-0000-0000-0000-000000000001",
      upstreamId: null,
      endpoint: "chat",
      status: "success",
      latencyMs: 100,
      quantities: {},
      usageComplete: true,
      breakdown: {
        currency: "USD",
        total: "2.000000",
        lines: [
          { dimension: "input_tokens", cost: "0.800000" },
          { dimension: "output_tokens", cost: "1.200000" }
        ],
        unpricedDimensions: [],
        snapshot: { version: 1, rules: [] }
      },
      reservation: null
    });

    const res = await request(app.getHttpServer())
      .get(`/admin/api-keys/${keyId}/usage-summary`)
      .set("Cookie", sessionHeader);

    expect(res.status).toBe(200);
    expect(res.body.byModel).toContainEqual({
      modelId: "00000000-0000-0000-0000-000000000001",
      publicName: "test-model",
      requests: 2,
      costUsd: "3.000000"
    });

    expect(res.body.byDimension).toEqual(
      expect.arrayContaining([
        { dimension: "input_tokens", costUsd: "1.200000" },
        { dimension: "output_tokens", costUsd: "1.800000" }
      ])
    );
  });
});
