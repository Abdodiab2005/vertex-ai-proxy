import type { NestExpressApplication } from "@nestjs/platform-express";
import { DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import { createE2eApp, resetE2eState } from "./e2e-app.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { RequestLogRetentionScheduler } from "../src/request-logs/request-log-retention.scheduler.js";
import { RedisService } from "../src/redis/redis.service.js";

describe("Request log retention (e2e)", () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createE2eApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetE2eState(app);
    await app.get(RedisService).client.del("request-logs:retention:lock");
  });

  async function logAgedDays(days: number): Promise<string> {
    const requestId = randomUUID();
    await dataSource.query(
      `INSERT INTO request_logs (request_id, model, endpoint, status, created_at)
       VALUES ($1, 'gemini-2.5-flash', 'generateContent', 'success', now() - make_interval(days => $2))`,
      [requestId, days],
    );
    return requestId;
  }

  async function remaining(): Promise<string[]> {
    const rows: { request_id: string }[] = await dataSource.query("SELECT request_id FROM request_logs ORDER BY created_at");
    return rows.map((row) => row.request_id);
  }

  it("deletes logs older than the configured retention, once per lock period", async () => {
    await app.get(SettingsService).update({ "logging.metadataRetentionDays": 7 }, { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null });
    await logAgedDays(10);
    await logAgedDays(8);
    const recent = await logAgedDays(1);

    const scheduler = app.get(RequestLogRetentionScheduler);
    await expect(scheduler.runOnce()).resolves.toBe(2);
    expect(await remaining()).toEqual([recent]);

    await logAgedDays(30);
    await expect(scheduler.runOnce()).resolves.toBeNull();
    expect(await remaining()).toHaveLength(2);
  });

  it("keeps everything when retention is set to keep forever", async () => {
    await app.get(SettingsService).update({ "logging.metadataRetentionDays": null }, { adminUserId: "00000000-0000-0000-0000-000000000000", ipAddress: null });
    await logAgedDays(400);

    await expect(app.get(RequestLogRetentionScheduler).runOnce()).resolves.toBe(0);
    expect(await remaining()).toHaveLength(1);
  });
});
