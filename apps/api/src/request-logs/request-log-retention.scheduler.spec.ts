import { describe, expect, it, vi } from "vitest";
import type { RedisService } from "../redis/redis.service.js";
import { RequestLogRetentionScheduler } from "./request-log-retention.scheduler.js";
import type { RequestLogRetentionService } from "./request-log-retention.service.js";

function scheduler(lockReply: "OK" | null, purge: () => Promise<number>) {
  const redis = { client: { set: vi.fn().mockResolvedValue(lockReply) } };
  const retention = { purgeOlderThan: vi.fn(purge) };
  return {
    retention,
    redis,
    subject: new RequestLogRetentionScheduler(
      retention as unknown as RequestLogRetentionService,
      redis as unknown as RedisService,
    ),
  };
}

describe("RequestLogRetentionScheduler", () => {
  it("purges when it wins this hour's lock", async () => {
    const { subject, retention, redis } = scheduler("OK", async () => 12);

    await expect(subject.runOnce()).resolves.toBe(12);
    expect(retention.purgeOlderThan).toHaveBeenCalledTimes(1);
    expect(redis.client.set).toHaveBeenCalledWith("request-logs:retention:lock", expect.any(String), "PX", expect.any(Number), "NX");
  });

  it("skips the purge while another instance holds the lock", async () => {
    const { subject, retention } = scheduler(null, async () => 12);

    await expect(subject.runOnce()).resolves.toBeNull();
    expect(retention.purgeOlderThan).not.toHaveBeenCalled();
  });

  it("never throws out of the timer when the purge fails", async () => {
    const { subject } = scheduler("OK", async () => {
      throw new Error("database down");
    });

    await expect(subject.runOnce()).resolves.toBeNull();
  });
});
