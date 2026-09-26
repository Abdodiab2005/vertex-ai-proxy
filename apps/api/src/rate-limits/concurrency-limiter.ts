import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RedisService } from "../redis/redis.service.js";

const CONCURRENCY_KEY_PREFIX = "ratelimit:";

/**
 * A slot representing an acquired concurrency lease.
 * Release is idempotent; extend returns false if the lease was already reclaimed.
 */
export class ConcurrencySlot {
  private readonly redis: RedisService;
  private readonly key: string;
  private readonly member: string;
  private released = false;

  constructor(redis: RedisService, key: string, member: string) {
    this.redis = redis;
    this.key = key;
    this.member = member;
  }

  /**
   * Releases the concurrency slot. Idempotent - safe to call multiple times.
   */
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    await this.redis.client.zrem(this.key, this.member);
    this.released = true;
  }

  /**
   * Extends the lease for long-running streams (heartbeat).
   * Returns false if the lease already expired and was reclaimed.
   * Uses Redis server time for consistency with acquire().
   */
  async extend(leaseMs: number): Promise<boolean> {
    if (this.released) {
      return false;
    }

    const result = (await this.redis.client.eval(
      EXTEND_SCRIPT,
      1,
      this.key,
      this.member,
      leaseMs.toString(),
    )) as number[];

    const extended = result[0] === 1;
    if (!extended) {
      this.released = true;
    }
    return extended;
  }
}

/**
 * Result of acquiring a concurrency slot.
 */
export type ConcurrencyAcquireResult =
  | { acquired: true; slot: ConcurrencySlot }
  | { acquired: false };

/**
 * Lua script for atomic acquire.
 *
 * KEYS[1] = concurrency sorted set key with hash tag, e.g. "ratelimit:{<apiKeyId>}:concurrency"
 *
 * ARGV[1] = max concurrent (or -1 for unlimited)
 * ARGV[2] = lease duration in milliseconds
 * ARGV[3] = unique slot member id
 *
 * Returns:
 *   [0] = acquired (1/0)
 *   [1] = current count after acquire (if acquired) or current count (if rejected)
 */
const ACQUIRE_SCRIPT = `
  local key = KEYS[1]
  local max_concurrent = tonumber(ARGV[1])
  local lease_ms = tonumber(ARGV[2])
  local member = ARGV[3]

  -- Get current time from Redis in milliseconds
  local time = redis.call("TIME")
  local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local lease_expiry = now_ms + lease_ms

  -- Remove expired leases first (score < now_ms)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", "(" .. now_ms)

  if max_concurrent < 0 then
    -- Unlimited: just add the member
    redis.call("ZADD", key, lease_expiry, member)
    local count = redis.call("ZCARD", key)
    return {1, count}
  end

  local current_count = redis.call("ZCARD", key)
  if current_count >= max_concurrent then
    return {0, current_count}
  end

  redis.call("ZADD", key, lease_expiry, member)
  local new_count = redis.call("ZCARD", key)
  return {1, new_count}
`;

/**
 * Lua script for atomic extend.
 *
 * KEYS[1] = concurrency sorted set key
 * ARGV[1] = member id
 * ARGV[2] = lease duration in milliseconds
 *
 * Returns:
 *   [0] = extended (1/0) - 1 if member existed and was updated, 0 if member didn't exist (expired/reclaimed)
 */
const EXTEND_SCRIPT = `
  local key = KEYS[1]
  local member = ARGV[1]
  local lease_ms = tonumber(ARGV[2])

  -- Get current time from Redis in milliseconds
  local time = redis.call("TIME")
  local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local new_expiry = now_ms + lease_ms

  -- Remove expired leases first (score < now_ms)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", "(" .. now_ms)

  -- Check if member still exists
  local score = redis.call("ZSCORE", key, member)
  if score == false then
    return {0}
  end

  -- Update the member's score (expiry)
  redis.call("ZADD", key, new_expiry, member)
  return {1}
`;

function getConcurrencyKey(apiKeyId: string): string {
  return `${CONCURRENCY_KEY_PREFIX}{${apiKeyId}}:concurrency`;
}

@Injectable()
export class ConcurrencyLimiter {
  constructor(private readonly redis: RedisService) {}

  /**
   * Acquires a concurrency slot for the given API key.
   *
   * @param apiKeyId - The API key identifier
   * @param maxConcurrent - Maximum concurrent requests (null = unlimited)
   * @param leaseMs - Lease duration in milliseconds
   * @returns ConcurrencyAcquireResult with slot if acquired
   */
  async acquire(
    apiKeyId: string,
    maxConcurrent: number | null,
    leaseMs: number,
  ): Promise<ConcurrencyAcquireResult> {
    const key = getConcurrencyKey(apiKeyId);
    const member = randomUUID();
    const limit = maxConcurrent ?? -1;

    const result = (await this.redis.client.eval(
      ACQUIRE_SCRIPT,
      1,
      key,
      limit.toString(),
      leaseMs.toString(),
      member,
    )) as number[];

    const acquired = result[0] === 1;
    if (!acquired) {
      return { acquired: false };
    }

    return {
      acquired: true,
      slot: new ConcurrencySlot(this.redis, key, member),
    };
  }
}

/**
 * Helper that acquires a concurrency slot, runs the work function, and ensures
 * the slot is released in a finally block. For non-streaming request paths.
 *
 * @param limiter - ConcurrencyLimiter instance
 * @param apiKeyId - The API key identifier
 * @param maxConcurrent - Maximum concurrent requests (null = unlimited)
 * @param leaseMs - Lease duration in milliseconds
 * @param work - Async function to execute while holding the slot
 * @returns The result of the work function
 * @throws If acquisition fails or work throws
 */
export async function withConcurrencySlot<T>(
  limiter: ConcurrencyLimiter,
  apiKeyId: string,
  maxConcurrent: number | null,
  leaseMs: number,
  work: (slot: ConcurrencySlot) => Promise<T>,
): Promise<T> {
  const result = await limiter.acquire(apiKeyId, maxConcurrent, leaseMs);
  if (!result.acquired) {
    throw new Error("Concurrency limit exceeded");
  }
  try {
    return await work(result.slot);
  } finally {
    await result.slot.release();
  }
}