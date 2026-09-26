import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DataSource } from "typeorm";
import { createE2eApp, resetE2eState, sessionCookie, cookieHeaderValue } from "./e2e-app.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import { randomUUID } from "node:crypto";
import { AdminUser, Upstream, Model, CreditTransaction, SystemSetting } from "@gateway/database";
import { CreditTransactionType, type AlertView as ContractAlertView } from "@gateway/contracts";
import { NOTIFICATION_CHANNELS_TOKEN } from "../src/alerts/notification-dispatcher.js";
import type { NotificationChannel } from "../src/alerts/notification-channel.js";
import { RedisService } from "../src/redis/redis.service.js";

/** Records what it is sent, so the test can see exactly which alerts were notified. */
class RecordingChannel implements NotificationChannel {
  readonly name = "recording";
  readonly sent: ContractAlertView[] = [];
  async send(alert: ContractAlertView): Promise<void> {
    this.sent.push(alert);
  }
}

class FailingChannel implements NotificationChannel {
  readonly name = "failing";
  async send(): Promise<void> {
    throw new Error("channel down");
  }
}

interface AlertView {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  dedupeKey: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  status: "active" | "acknowledged" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedByAdminId: string | null;
  acknowledgedByAdminEmail: string | null;
  resolvedAt: string | null;
}

describe("Alerts (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let sessionHeader: string;
  let csrfToken: string;

  // The failing channel is registered first: it must not stop the recording one or the evaluator.
  const recording = new RecordingChannel();

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: NOTIFICATION_CHANNELS_TOKEN, useValue: [new FailingChannel(), recording] }],
    });
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    recording.sent.length = 0;

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
    const upstream = await dataSource.getRepository(Upstream).save({
      name: "Test Upstream",
      projectId: "test-project",
      location: "us-central1",
      authMethod: "service_account",
      apiUrl: "https://example.com/v1",
      credentials: {},
      status: "active",
      healthStatus: "healthy",
      enabled: true,
    });

    await dataSource.getRepository(Model).save({
      id: "00000000-0000-0000-0000-000000000001",
      publicName: "test-model",
      upstreamModelName: "test-model",
      displayName: "Test Model",
      provider: "google",
      upstreamId: upstream.id,
    });

    // Configure spend threshold settings
    await dataSource.getRepository(SystemSetting).save([
      { key: "spend.upstreamBudget", value: "100.00", type: "decimal" },
      { key: "spend.safetyReserve", value: "10.00", type: "decimal" },
      { key: "spend.blockWhenThresholdReached", value: "false", type: "boolean" },
    ]);
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

  async function evaluateAlerts() {
    return request(app.getHttpServer())
      .post("/admin/alerts/evaluate")
      .set("Cookie", sessionHeader)
      .set("X-CSRF-Token", csrfToken)
      .send({});
  }

  async function listAlerts(status?: string, limit?: number) {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    return request(app.getHttpServer())
      .get(`/admin/alerts?${params.toString()}`)
      .set("Cookie", sessionHeader);
  }

  function acknowledgeAlert(id: string) {
    return request(app.getHttpServer())
      .post(`/admin/alerts/${id}/acknowledge`)
      .set("Cookie", sessionHeader)
      .set("X-CSRF-Token", csrfToken)
      .send({});
  }

  async function insertRequestLog(status: "success" | "error") {
    await dataSource.query(
      "INSERT INTO request_logs (request_id, model, endpoint, status) VALUES ($1, 'test-model', 'generateContent', $2)",
      [randomUUID(), status],
    );
  }

  async function insertCostConsumed(apiKeyId: string, amount: string) {
    await dataSource.getRepository(CreditTransaction).save({
      apiKeyId,
      type: CreditTransactionType.COST_CONSUMED,
      amount,
      currency: "USD",
      usageRecordId: null,
    });
  }

  async function setupAllAlertConditions() {
    // 1. credit_80: key with 80% consumed (cost_consumed), remaining > 0
    const key80 = await createKey("100.00"); // initialCredit = 100 (credit_added)
    // Add cost_consumed = 80 (simulating 80% consumption)
    await insertCostConsumed(key80, "-80.00");
    // Now: totalAdded = 100, totalConsumed = -80, remaining = 20
    // consumed = 80, remaining = 20, total = 100, percentage = 80%

    // 2. credit_100: key with remaining <= 0 and credit added
    const key100 = await createKey("50.00"); // initialCredit = 50
    // Consume all 50
    await insertCostConsumed(key100, "-50.00");
    // Now: totalAdded = 50, totalConsumed = -50, remaining = 0

    // 3. high_error_rate: 20 requests in the last 15 minutes, 5 of them errors (25%)
    for (let i = 0; i < 15; i++) {
      await insertRequestLog("success");
    }
    for (let i = 0; i < 5; i++) {
      await insertRequestLog("error");
    }

    // 4. upstream_unavailable: upstream with unhealthy status
    await dataSource.getRepository(Upstream).update(
      { name: "Test Upstream" },
      { status: "authentication_failed" }
    );

    // 5. spend_threshold: tracked spend >= usable target (budget=100, reserve=10, usable=90)
    // Use a separate key so we don't affect key80's credit_80 condition
    const keySpend = await createKey("1000.00");
    await insertCostConsumed(keySpend, "-95.00");

    return { key80, key100, keySpend };
  }

  it("POST /admin/alerts/evaluate creates expected alerts for credit_80, credit_100, high_error_rate, upstream_unavailable, spend_threshold", async () => {
    await setupAllAlertConditions();

    // First evaluation - should create all 5 alerts
    const eval1 = await evaluateAlerts();
    expect(eval1.status).toBe(201);
    expect(eval1.body).toEqual({ skipped: false, created: 5, resolved: 0 });
    expect(recording.sent.map((alert) => alert.type).sort()).toEqual([
      "credit_100",
      "credit_80",
      "high_error_rate",
      "spend_threshold",
      "upstream_unavailable",
    ]);

    const alerts1 = await listAlerts("open");
    expect(alerts1.status).toBe(200);
    expect(alerts1.body.alerts.length).toBe(5);

    const types1 = alerts1.body.alerts.map((a: AlertView) => a.type).sort();
    expect(types1).toEqual([
      "credit_100",
      "credit_80",
      "high_error_rate",
      "spend_threshold",
      "upstream_unavailable",
    ]);

    // Check severity
    const credit80 = alerts1.body.alerts.find((a: AlertView) => a.type === "credit_80");
    expect(credit80.severity).toBe("warning");
    const credit100 = alerts1.body.alerts.find((a: AlertView) => a.type === "credit_100");
    expect(credit100.severity).toBe("critical");
    const highError = alerts1.body.alerts.find((a: AlertView) => a.type === "high_error_rate");
    expect(highError.severity).toBe("warning");
    const upstream = alerts1.body.alerts.find((a: AlertView) => a.type === "upstream_unavailable");
    expect(upstream.severity).toBe("critical");
    const spend = alerts1.body.alerts.find((a: AlertView) => a.type === "spend_threshold");
    expect(spend.severity).toBe("critical");

    // Second evaluation - no duplicates
    const eval2 = await evaluateAlerts();
    expect(eval2.status).toBe(201);
    expect(eval2.body.created).toBe(0);
    expect(eval2.body.resolved).toBe(0);

    const alerts2 = await listAlerts("open");
    expect(alerts2.body.alerts.length).toBe(5);
    // A continuing condition is not notified again.
    expect(recording.sent).toHaveLength(5);
  });

  it("acknowledge alert updates status and audits", async () => {
    await setupAllAlertConditions();
    await evaluateAlerts();

    const alerts = await listAlerts("open");
    const credit80Alert = alerts.body.alerts.find((a: AlertView) => a.type === "credit_80");
    expect(credit80Alert).toBeDefined();

    const ack = await acknowledgeAlert(credit80Alert.id);
    expect(ack.status).toBe(204);

    const afterAck = await listAlerts("open");
    const ackedAlert = afterAck.body.alerts.find((a: AlertView) => a.id === credit80Alert.id);
    expect(ackedAlert.status).toBe("acknowledged");
    expect(ackedAlert.acknowledgedByAdminId).toBeDefined();

    // Verify audit log
    const audits = await dataSource.query(
      `SELECT * FROM audit_logs WHERE action = 'admin.alert.acknowledged' AND entity_id = $1`,
      [credit80Alert.id]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toEqual(expect.objectContaining({ status: "active", type: "credit_80" }));
    expect(audits[0].after).toEqual({ status: "acknowledged" });
  });

  it("condition clears -> alert resolved on next evaluate", async () => {
    const { key80 } = await setupAllAlertConditions();
    await evaluateAlerts();

    let alerts = await listAlerts("open");
    const credit80Alert = alerts.body.alerts.find((a: AlertView) => a.type === "credit_80");
    expect(credit80Alert).toBeDefined();

    // Add more credit so usage drops below 80% (remaining becomes 120, consumed 80 = 40%)
    // We need to add credit_added to increase remaining
    await addCredit(key80, { type: "credit_added", amount: "100.00" });

    await evaluateAlerts();

    alerts = await listAlerts("open");
    const resolvedAlert = alerts.body.alerts.find((a: AlertView) => a.id === credit80Alert.id);
    expect(resolvedAlert).toBeUndefined(); // Should be resolved, not in open

    const resolved = await listAlerts("resolved");
    const found = resolved.body.alerts.find((a: AlertView) => a.id === credit80Alert.id);
    expect(found).toBeDefined();
    expect(found.status).toBe("resolved");
    expect(found.resolvedAt).toBeDefined();
  });

  it("keeps an acknowledged alert acknowledged while its condition persists", async () => {
    await setupAllAlertConditions();
    await evaluateAlerts();
    const open = await listAlerts("open");
    const alert = open.body.alerts.find((a: AlertView) => a.type === "upstream_unavailable");
    await acknowledgeAlert(alert.id).expect(204);

    await evaluateAlerts();

    const after = await listAlerts("acknowledged");
    const same = after.body.alerts.find((a: AlertView) => a.id === alert.id);
    expect(same.status).toBe("acknowledged");
    expect(new Date(same.lastSeenAt).getTime()).toBeGreaterThanOrEqual(new Date(alert.lastSeenAt).getTime());
  });

  it("answers 404 for an unknown alert and 409 for acknowledging twice", async () => {
    await setupAllAlertConditions();
    await evaluateAlerts();
    const open = await listAlerts("open");

    await acknowledgeAlert(randomUUID()).expect(404);
    await acknowledgeAlert(open.body.alerts[0].id).expect(204);
    await acknowledgeAlert(open.body.alerts[0].id).expect(409);
  });

  it("skips an evaluation while another one holds the lock", async () => {
    await setupAllAlertConditions();
    await app.get(RedisService).client.set("alerts:evaluate:lock", "someone-else", "PX", 5000);

    const res = await evaluateAlerts();
    expect(res.body).toEqual({ skipped: true, created: 0, resolved: 0 });
    expect((await listAlerts("open")).body.alerts).toHaveLength(0);
  });

  it("GET /admin/alerts supports status filters", async () => {
    const { key80 } = await setupAllAlertConditions();
    await evaluateAlerts();

    const all = await listAlerts("open");
    expect(all.body.alerts.length).toBe(5);

    const active = await listAlerts("active");
    expect(active.body.alerts.length).toBe(5);
    expect(active.body.alerts.every((a: AlertView) => a.status === "active")).toBe(true);

    const ack = await acknowledgeAlert(all.body.alerts[0].id);
    expect(ack.status).toBe(204);

    const acknowledged = await listAlerts("acknowledged");
    expect(acknowledged.body.alerts.length).toBe(1);
    expect(acknowledged.body.alerts.every((a: AlertView) => a.status === "acknowledged")).toBe(true);

    const activeAfterAck = await listAlerts("active");
    expect(activeAfterAck.body.alerts.length).toBe(4);

    // Resolve one by clearing condition (use key from initial setup)
    await addCredit(key80, { type: "credit_added", amount: "100.00" });
    await evaluateAlerts();

    const resolved = await listAlerts("resolved");
    expect(resolved.body.alerts.length).toBeGreaterThanOrEqual(1);
    expect(resolved.body.alerts.every((a: AlertView) => a.status === "resolved")).toBe(true);
  });

  it("GET /admin/alerts respects limit", async () => {
    await setupAllAlertConditions();
    await evaluateAlerts();

    const limited = await listAlerts("open", 2);
    expect(limited.body.alerts.length).toBe(2);
  });

  it("requires admin session", async () => {
    const res = await request(app.getHttpServer()).get("/admin/alerts");
    expect(res.status).toBe(401);
  });

  it("requires CSRF for acknowledge and evaluate", async () => {
    await setupAllAlertConditions();
    await evaluateAlerts();

    const alerts = await listAlerts("open");
    const alert = alerts.body.alerts[0];

    const noCsrfAck = await request(app.getHttpServer())
      .post(`/admin/alerts/${alert.id}/acknowledge`)
      .set("Cookie", sessionHeader)
      .send({});
    expect(noCsrfAck.status).toBe(403);

    const noCsrfEval = await request(app.getHttpServer())
      .post("/admin/alerts/evaluate")
      .set("Cookie", sessionHeader)
      .send({});
    expect(noCsrfEval.status).toBe(403);
  });
});