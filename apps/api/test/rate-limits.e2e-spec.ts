import { describe, beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { createE2eApp, resetE2eState } from "./e2e-app.js";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Redis } from "ioredis";
import { ConfigService } from "../src/config/config.service.js";
import { RequestLimiter, ConcurrencyLimiter, withConcurrencySlot, ConcurrencySlot } from "../src/rate-limits/index.js";
import type { AdmitRequestResult, ConcurrencyAcquireResult } from "../src/rate-limits/index.js";
import type { Redis as RedisType } from "ioredis";
import { RedisService } from "../src/redis/redis.service.js";

function isRejected(result: AdmitRequestResult): result is AdmitRequestResult & { allowed: false } {
  return !result.allowed;
}

function isAcquired(result: ConcurrencyAcquireResult): result is ConcurrencyAcquireResult & { acquired: true } {
  return result.acquired;
}

/**
 * Minimal ConfigService mock for test RedisService.
 */
class MockConfigService {
  readonly env = { REDIS_URL: "" };
}

/**
 * RedisService subclass that uses a pre-created ioredis client.
 * Used in tests to create a second limiter instance on a separate connection.
 */
class TestRedisService extends RedisService {
  constructor(client: RedisType) {
    // Create a mock ConfigService with the Redis URL
    const mockConfig = new MockConfigService();
    // Call super with mock config, but override the client
    super(mockConfig as unknown as ConfigService);
    // Replace the client with the pre-created one (using Object.defineProperty to bypass readonly)
    Object.defineProperty(this, "client", { value: client, writable: true, configurable: true });
    // Re-attach error handler
    this.client.on("error", (err) => {
      (this as unknown as { logger: { warn: (msg: string) => void } }).logger?.warn?.(`Redis connection error: ${err.message}`);
    });
  }
}

/**
 * Reference implementation of Howard Hinnant's algorithms in TypeScript
 * for verifying the Lua calendar math.
 */
function civilFromDays(z: number): { year: number; month: number; day: number } {
  z = z + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const month = m;
  const day = d;
  return { year, month, day };
}

function daysFromCivil(y: number, m: number, d: number): number {
  if (m <= 2) y = y - 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function getMonthIdAndEnd(ts: number): { monthId: number; monthEndSeconds: number } {
  const daysSinceEpoch = Math.floor(ts / 86400);
  const { year, month } = civilFromDays(daysSinceEpoch);
  const monthId = year * 12 + (month - 1);
  const nextMonthY = month === 12 ? year + 1 : year;
  const nextMonthM = month === 12 ? 1 : month + 1;
  const monthEndSeconds = daysFromCivil(nextMonthY, nextMonthM, 1) * 86400;
  return { monthId, monthEndSeconds };
}

describe("RateLimits (e2e)", () => {
  let app: NestExpressApplication;
  let requestLimiter: RequestLimiter;
  let concurrencyLimiter: ConcurrencyLimiter;
  let secondRedis: Redis;
  let secondRequestLimiter: RequestLimiter;
  let secondConcurrencyLimiter: ConcurrencyLimiter;

  beforeAll(async () => {
    app = await createE2eApp();
    requestLimiter = app.get(RequestLimiter);
    concurrencyLimiter = app.get(ConcurrencyLimiter);

    // Create a second Redis connection to the same DB for multi-instance tests
    const config = app.get(ConfigService);
    secondRedis = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    const testRedisService = new TestRedisService(secondRedis);
    secondRequestLimiter = new RequestLimiter(testRedisService);
    secondConcurrencyLimiter = new ConcurrencyLimiter(testRedisService);
  });

  afterAll(async () => {
    await app.close();
    await secondRedis.quit();
  });

  beforeEach(async () => {
    await resetE2eState(app);
  });

  const apiKeyId = "test-key-123";

  describe("Calendar math (Lua helpers)", () => {
    const testTimestamps = [
      { desc: "2024-02-29T23:59:59Z (leap day)", ts: new Date("2024-02-29T23:59:59Z").getTime() / 1000 },
      { desc: "2024-03-01T00:00:00Z", ts: new Date("2024-03-01T00:00:00Z").getTime() / 1000 },
      { desc: "2023-12-31T23:59:59Z", ts: new Date("2023-12-31T23:59:59Z").getTime() / 1000 },
      { desc: "2024-01-01T00:00:00Z", ts: new Date("2024-01-01T00:00:00Z").getTime() / 1000 },
      { desc: "2100-02-28T12:00:00Z (not a leap year)", ts: new Date("2100-02-28T12:00:00Z").getTime() / 1000 },
      { desc: "2000-02-29T00:00:00Z (a leap year)", ts: new Date("2000-02-29T00:00:00Z").getTime() / 1000 },
      { desc: "now", ts: Math.floor(Date.now() / 1000) },
    ];

    const CALENDAR_TEST_SCRIPT = `
      local function civil_from_days(z)
        z = z + 719468
        local era = math.floor(z / 146097)
        local doe = z - era * 146097
        local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
        local y = yoe + era * 400
        local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
        local mp = math.floor((5 * doy + 2) / 153)
        local d = doy - math.floor((153 * mp + 2) / 5) + 1
        local m = mp < 10 and mp + 3 or mp - 9
        if m <= 2 then y = y + 1 end
        return y, m, d
      end

      local function days_from_civil(y, m, d)
        if m <= 2 then y = y - 1 end
        local era = math.floor(y / 400)
        local yoe = y - era * 400
        local mp = (m + 9) % 12
        local doy = math.floor((153 * mp + 2) / 5) + d - 1
        local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
        return era * 146097 + doe - 719468
      end

      local ts = tonumber(ARGV[1])
      local days_since_epoch = math.floor(ts / 86400)
      local y, m, d = civil_from_days(days_since_epoch)
      local month_id = y * 12 + (m - 1)
      local next_month_y = m == 12 and y + 1 or y
      local next_month_m = m == 12 and 1 or m + 1
      local month_end = days_from_civil(next_month_y, next_month_m, 1) * 86400
      return {month_id, month_end}
    `;

    for (const { desc, ts } of testTimestamps) {
      it(`monthId and monthEnd match TS reference for ${desc}`, async () => {
        const redis = app.get(RedisService).client;
        const result = (await redis.eval(CALENDAR_TEST_SCRIPT, 0, ts.toString())) as number[];
        const luaMonthId = result[0];
        const luaMonthEnd = result[1];

        const ref = getMonthIdAndEnd(ts);
        expect(luaMonthId).toBe(ref.monthId);
        expect(luaMonthEnd).toBe(ref.monthEndSeconds);
      });
    }
  });

  describe("Key scheme", () => {
    it("keys created after admitRequest follow ratelimit:{<id>}:rpm:<minuteId> scheme", async () => {
      const redis = app.get(RedisService).client;
      const limits = { requestsPerMinute: 10, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      // Make a request to create keys
      await requestLimiter.admitRequest(apiKeyId, limits, 0);

      // Get the current minute_id from Redis TIME
      const time = await redis.time();
      const nowSeconds = time[0];
      const minuteId = Math.floor(nowSeconds / 60);

      // Check keys exist with correct pattern
      const rpmKey = `ratelimit:{${apiKeyId}}:rpm:${minuteId}`;
      const rpdKey = `ratelimit:{${apiKeyId}}:rpd:${Math.floor(nowSeconds / 86400)}`;

      const rpmExists = await redis.exists(rpmKey);
      const rpdExists = await redis.exists(rpdKey);

      expect(rpmExists).toBe(1);
      expect(rpdExists).toBe(1);

      // Verify the key values
      const rpmVal = await redis.get(rpmKey);
      expect(parseInt(rpmVal!, 10)).toBe(1);
    });
  });

  describe("RequestLimiter.admitRequest", () => {
    it("allows exactly N requests per minute then rejects with requests_per_minute", async () => {
      const limits = { requestsPerMinute: 3, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      for (let i = 0; i < 3; i++) {
        const result = await requestLimiter.admitRequest(apiKeyId, limits, 0);
        expect(result).toEqual({ allowed: true });
      }

      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("requests_per_minute");
        expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    });

    it("allows exactly N requests per day then rejects with requests_per_day", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: 2, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      for (let i = 0; i < 2; i++) {
        const result = await requestLimiter.admitRequest(apiKeyId, limits, 0);
        expect(result).toEqual({ allowed: true });
      }

      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("requests_per_day");
        expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(86400);
      }
    });

    it("a rejected request increments nothing", async () => {
      const limits = { requestsPerMinute: 1, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      await requestLimiter.admitRequest(apiKeyId, limits, 0);
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(isRejected(rejected)).toBe(true);

      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.requestsThisMinute).toBe(1);
    });

    it("token limits enforced on next request: tokens_per_minute", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: 100, tokensPerDay: null, tokensPerMonth: null };

      // First request with estimated 50 tokens - allowed
      await requestLimiter.admitRequest(apiKeyId, limits, 50);
      // Record 60 tokens (more than estimated)
      await requestLimiter.recordTokens(apiKeyId, 60);
      // Next request with 50 estimated tokens would exceed 100 (60+50>100) -> rejected
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 50);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("tokens_per_minute");
      }
    });

    it("token limits enforced on next request: tokens_per_day", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: 200, tokensPerMonth: null };

      await requestLimiter.admitRequest(apiKeyId, limits, 100);
      await requestLimiter.recordTokens(apiKeyId, 150);
      // 150 + 100 > 200 -> rejected
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 100);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("tokens_per_day");
      }
    });

    it("token limits enforced on next request: tokens_per_month", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: 500 };

      await requestLimiter.admitRequest(apiKeyId, limits, 200);
      await requestLimiter.recordTokens(apiKeyId, 350);
      // 350 + 200 > 500 -> rejected
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 200);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("tokens_per_month");
      }
    });

    it("usage() reflects the counters", async () => {
      const limits = { requestsPerMinute: 10, requestsPerDay: 100, tokensPerMinute: 1000, tokensPerDay: 10000, tokensPerMonth: 100000 };

      await requestLimiter.admitRequest(apiKeyId, limits, 50);
      await requestLimiter.admitRequest(apiKeyId, limits, 50);
      await requestLimiter.recordTokens(apiKeyId, 120);

      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.requestsThisMinute).toBe(2);
      expect(usage.requestsToday).toBe(2);
      expect(usage.tokensThisMinute).toBe(120);
      expect(usage.tokensToday).toBe(120);
      expect(usage.tokensThisMonth).toBe(120);
    });

    it("resetCounters clears all counters", async () => {
      const limits = { requestsPerMinute: 10, requestsPerDay: 100, tokensPerMinute: 1000, tokensPerDay: 10000, tokensPerMonth: 100000 };

      await requestLimiter.admitRequest(apiKeyId, limits, 50);
      await requestLimiter.recordTokens(apiKeyId, 120);

      await requestLimiter.resetCounters(apiKeyId);

      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.requestsThisMinute).toBe(0);
      expect(usage.requestsToday).toBe(0);
      expect(usage.tokensThisMinute).toBe(0);
      expect(usage.tokensToday).toBe(0);
      expect(usage.tokensThisMonth).toBe(0);
    });

    it("null limits (unlimited) still count requests but always allow", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      for (let i = 0; i < 100; i++) {
        const result = await requestLimiter.admitRequest(apiKeyId, limits, 0);
        expect(result).toEqual({ allowed: true });
      }

      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.requestsThisMinute).toBe(100);
      expect(usage.requestsToday).toBe(100);
    });

    it("MULTIPLE INSTANCES: both instances share counters", async () => {
      const limits = { requestsPerMinute: 5, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      // First instance makes 3 requests
      for (let i = 0; i < 3; i++) {
        await requestLimiter.admitRequest(apiKeyId, limits, 0);
      }
      // Second instance makes 2 requests
      for (let i = 0; i < 2; i++) {
        await secondRequestLimiter.admitRequest(apiKeyId, limits, 0);
      }
      // Next request from first instance should be rejected
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("requests_per_minute");
      }
    });

    it("parallel admitRequest calls (Promise.all of 20 against RPM 10) admit exactly 10", async () => {
      const limits = { requestsPerMinute: 10, requestsPerDay: null, tokensPerMinute: null, tokensPerDay: null, tokensPerMonth: null };

      const promises = Array.from({ length: 20 }, () => requestLimiter.admitRequest(apiKeyId, limits, 0));
      const results = await Promise.all(promises);

      const allowed = results.filter((r) => r.allowed).length;
      const rejected = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(10);
      expect(rejected).toBe(10);
      for (const r of results) {
        if (!r.allowed) {
          expect(r.limit).toBe("requests_per_minute");
        }
      }
    });

    it("token pre-check rejects when at limit without estimatedTokens", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: 100, tokensPerDay: null, tokensPerMonth: null };

      // Fill up to exactly the limit
      await requestLimiter.recordTokens(apiKeyId, 100);

      // Next request with estimatedTokens=0 should be rejected (at limit)
      const rejected = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(isRejected(rejected)).toBe(true);
      if (isRejected(rejected)) {
        expect(rejected.limit).toBe("tokens_per_minute");
      }
    });

    it("token pre-check allows when under limit even with estimatedTokens=0", async () => {
      const limits = { requestsPerMinute: null, requestsPerDay: null, tokensPerMinute: 100, tokensPerDay: null, tokensPerMonth: null };

      // Record 50 tokens (under limit)
      await requestLimiter.recordTokens(apiKeyId, 50);

      // Next request with estimatedTokens=0 should be allowed (under limit)
      const allowed = await requestLimiter.admitRequest(apiKeyId, limits, 0);
      expect(allowed).toEqual({ allowed: true });
    });
  });

  describe("RequestLimiter.recordTokens", () => {
    it("adds tokens to minute, day, and month counters atomically", async () => {
      await requestLimiter.recordTokens(apiKeyId, 50);
      await requestLimiter.recordTokens(apiKeyId, 30);

      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.tokensThisMinute).toBe(80);
      expect(usage.tokensToday).toBe(80);
      expect(usage.tokensThisMonth).toBe(80);
    });

    it("rejects negative tokens", async () => {
      await expect(requestLimiter.recordTokens(apiKeyId, -1)).rejects.toThrow("non-negative safe integer");
    });

    it("rejects non-integer tokens", async () => {
      await expect(requestLimiter.recordTokens(apiKeyId, 1.5)).rejects.toThrow("non-negative safe integer");
    });

    it("zero tokens is a no-op", async () => {
      await requestLimiter.recordTokens(apiKeyId, 0);
      const usage = await requestLimiter.usage(apiKeyId);
      expect(usage.tokensThisMinute).toBe(0);
    });
  });

  describe("ConcurrencyLimiter", () => {
    const leaseMs = 5000; // 5 second lease for tests

    it("admits exactly max concurrent requests", async () => {
      const maxConcurrent = 3;
      const slots: ConcurrencySlot[] = [];

      for (let i = 0; i < maxConcurrent; i++) {
        const result = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
        expect(isAcquired(result)).toBe(true);
        if (isAcquired(result)) {
          slots.push(result.slot);
        }
      }

      const rejected = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(rejected.acquired).toBe(false);

      // Release one and try again
      await slots[0].release();
      const acquired = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(acquired)).toBe(true);
      if (isAcquired(acquired)) {
        await acquired.slot.release();
      }

      // Cleanup
      for (const slot of slots.slice(1)) {
        await slot.release();
      }
    });

    it("release is idempotent", async () => {
      const result = await concurrencyLimiter.acquire(apiKeyId, 1, leaseMs);
      expect(isAcquired(result)).toBe(true);
      if (!isAcquired(result)) return;

      await result.slot.release();
      await result.slot.release(); // Should not throw
      await result.slot.release(); // Should not throw

      // Should be able to acquire again
      const again = await concurrencyLimiter.acquire(apiKeyId, 1, leaseMs);
      expect(isAcquired(again)).toBe(true);
      if (isAcquired(again)) {
        await again.slot.release();
      }
    });

    it("expired lease is reclaimed", async () => {
      const shortLeaseMs = 50; // Very short lease
      const result = await concurrencyLimiter.acquire(apiKeyId, 1, shortLeaseMs);
      expect(isAcquired(result)).toBe(true);
      if (!isAcquired(result)) return;

      // Wait for lease to expire
      await new Promise((r) => setTimeout(r, 100));

      // Should be able to acquire again (expired lease reclaimed)
      const again = await concurrencyLimiter.acquire(apiKeyId, 1, shortLeaseMs);
      expect(isAcquired(again)).toBe(true);
      if (isAcquired(again)) {
        await again.slot.release();
      }
    });

    it("extend keeps a slot alive", async () => {
      const result = await concurrencyLimiter.acquire(apiKeyId, 1, leaseMs);
      expect(isAcquired(result)).toBe(true);
      if (!isAcquired(result)) return;

      // Extend before expiry
      const extended = await result.slot.extend(leaseMs);
      expect(extended).toBe(true);

      // Wait a bit, extend again
      await new Promise((r) => setTimeout(r, 100));
      const extended2 = await result.slot.extend(leaseMs);
      expect(extended2).toBe(true);

      await result.slot.release();
    });

    it("extend returns false if lease already expired and reclaimed", async () => {
      const shortLeaseMs = 50;
      const result = await concurrencyLimiter.acquire(apiKeyId, 1, shortLeaseMs);
      expect(isAcquired(result)).toBe(true);
      if (!isAcquired(result)) return;

      await new Promise((r) => setTimeout(r, 100));

      const extended = await result.slot.extend(shortLeaseMs);
      expect(extended).toBe(false);
    });

    it("null maxConcurrent (unlimited) returns a slot with no-op release", async () => {
      const result = await concurrencyLimiter.acquire(apiKeyId, null, leaseMs);
      expect(isAcquired(result)).toBe(true);
      if (!isAcquired(result)) return;

      // Should be able to acquire many
      const many = await Promise.all(
        Array.from({ length: 10 }, () => concurrencyLimiter.acquire(apiKeyId, null, leaseMs)),
      );
      expect(many.every((r) => isAcquired(r))).toBe(true);

      // Release all
      await Promise.all([result.slot.release(), ...many.filter(isAcquired).map((r) => r.slot.release())]);
    });

    it("MULTIPLE INSTANCES: both instances share concurrency slots", async () => {
      const maxConcurrent = 2;

      // First instance acquires 1 slot
      const r1 = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(r1)).toBe(true);
      if (!isAcquired(r1)) return;

      // Second instance acquires 1 slot
      const r2 = await secondConcurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(r2)).toBe(true);
      if (!isAcquired(r2)) return;

      // First instance tries to acquire 3rd slot -> rejected
      const rejected = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(rejected.acquired).toBe(false);

      // Release from second instance
      await r2.slot.release();

      // First instance can now acquire
      const r3 = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(r3)).toBe(true);
      if (!isAcquired(r3)) return;

      await r1.slot.release();
      await r3.slot.release();
    });
  });

  describe("withConcurrencySlot helper", () => {
    it("releases slot in finally block on success", async () => {
      const maxConcurrent = 1;
      const leaseMs = 5000;

      let workExecuted = false;
      const result = await withConcurrencySlot(
        concurrencyLimiter,
        apiKeyId,
        maxConcurrent,
        leaseMs,
        async (_slot) => {
          workExecuted = true;
          return "done";
        },
      );

      expect(result).toBe("done");
      expect(workExecuted).toBe(true);

      // Slot should be released, can acquire again
      const again = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(again)).toBe(true);
      if (isAcquired(again)) {
        await again.slot.release();
      }
    });

    it("releases slot in finally block on error", async () => {
      const maxConcurrent = 1;
      const leaseMs = 5000;

      await expect(
        withConcurrencySlot(
          concurrencyLimiter,
          apiKeyId,
          maxConcurrent,
          leaseMs,
          async () => {
            throw new Error("work failed");
          },
        ),
      ).rejects.toThrow("work failed");

      // Slot should be released, can acquire again
      const again = await concurrencyLimiter.acquire(apiKeyId, maxConcurrent, leaseMs);
      expect(isAcquired(again)).toBe(true);
      if (isAcquired(again)) {
        await again.slot.release();
      }
    });
  });
});