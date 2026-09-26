import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service.js";
import { randomUUID } from "node:crypto";


// Lua numbers are doubles, exact below 2^53 micros. 
// A single reservation or balance cannot exceed 2^53 - 1 (approx. $9B).
const RESERVE_SCRIPT = `
  local zset_key = KEYS[1]
  local hash_key = KEYS[2]
  local now_ms = tonumber(ARGV[1])
  local balance_micros = tonumber(ARGV[2])
  local estimate_micros = tonumber(ARGV[3])
  local lease_ms = tonumber(ARGV[4])
  local reservation_id = ARGV[5]

  -- 1. Purge expired reservations
  local expired = redis.call('ZRANGEBYSCORE', zset_key, '-inf', now_ms - 1)
  if #expired > 0 then
    redis.call('ZREMRANGEBYSCORE', zset_key, '-inf', now_ms - 1)
    redis.call('HDEL', hash_key, unpack(expired))
  end

  -- 2. Sum remaining active reservations
  local active_ids = redis.call('ZRANGE', zset_key, 0, -1)
  local active_reservations_micros = 0
  if #active_ids > 0 then
    local values = redis.call('HMGET', hash_key, unpack(active_ids))
    for i = 1, #values do
      if values[i] then
        active_reservations_micros = active_reservations_micros + tonumber(values[i])
      end
    end
  end

  -- 3. Decide (mirror of decideReservation in TS)
  local available_micros = balance_micros - active_reservations_micros
  if available_micros <= 0 then
    return {0, "0"} -- allowed: false
  end

  local reserve_micros = estimate_micros
  if estimate_micros > available_micros then
    if active_reservations_micros > 0 then
      return {0, "0"} -- allowed: false; it would share credit other requests already hold
    end
    reserve_micros = available_micros
  end

  -- 4. Store the new reservation
  local expiry = now_ms + lease_ms
  redis.call('ZADD', zset_key, expiry, reservation_id)
  -- convert reserve_micros to string without scientific notation by using string.format
  -- Lua format %f will leave decimal zeroes; %d handles integers.
  local reserve_str = string.format("%.0f", reserve_micros)
  redis.call('HSET', hash_key, reservation_id, reserve_str)

  -- Extend TTL of the keys to clear them out eventually if unused
  local max_expiry = redis.call('ZREVRANGE', zset_key, 0, 0, 'WITHSCORES')
  if #max_expiry >= 2 then
    local ttl_ms = tonumber(max_expiry[2]) - now_ms
    if ttl_ms > 0 then
      local ttl_sec = math.ceil(ttl_ms / 1000)
      redis.call('EXPIRE', zset_key, ttl_sec)
      redis.call('EXPIRE', hash_key, ttl_sec)
    end
  end

  return {1, reserve_str} -- allowed: true
`;

// Renews one hold. Returns 0 when the id is already gone so a caller cannot
// revive a hold that reserve or activeReservedMicros would treat as expired.
// The key TTL is whatever reserve set; without a refresh the key would
// disappear at the original lease even after the score moved forward.
const EXTEND_SCRIPT = `
  local zset_key = KEYS[1]
  local hash_key = KEYS[2]
  local reservation_id = ARGV[1]
  local lease_ms = tonumber(ARGV[2])

  local time = redis.call('TIME')
  local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

  local expired = redis.call('ZRANGEBYSCORE', zset_key, '-inf', now_ms - 1)
  if #expired > 0 then
    redis.call('ZREMRANGEBYSCORE', zset_key, '-inf', now_ms - 1)
    redis.call('HDEL', hash_key, unpack(expired))
  end

  local score = redis.call('ZSCORE', zset_key, reservation_id)
  if score == false then
    redis.call('HDEL', hash_key, reservation_id)
    return 0
  end

  local amount = redis.call('HGET', hash_key, reservation_id)
  if amount == false then
    redis.call('ZREM', zset_key, reservation_id)
    return 0
  end

  local expiry = now_ms + lease_ms
  redis.call('ZADD', zset_key, expiry, reservation_id)

  local max_expiry = redis.call('ZREVRANGE', zset_key, 0, 0, 'WITHSCORES')
  if #max_expiry >= 2 then
    local ttl_ms = tonumber(max_expiry[2]) - now_ms
    if ttl_ms > 0 then
      local ttl_sec = math.ceil(ttl_ms / 1000)
      redis.call('EXPIRE', zset_key, ttl_sec)
      redis.call('EXPIRE', hash_key, ttl_sec)
    end
  end

  return 1
`;

@Injectable()
export class CreditReservationStore {
  constructor(private readonly redisService: RedisService) {}

  async reserve(
    apiKeyId: string,
    balanceMicros: bigint,
    estimateMicros: bigint,
    leaseMs: number
  ): Promise<{ allowed: false } | { allowed: true; reservationId: string; reservedMicros: bigint }> {
    const zsetKey = `credit:zset:${apiKeyId}`;
    const hashKey = `credit:hash:${apiKeyId}`;
    const reservationId = randomUUID();
    
    // We use the local Redis server's exact current time for expiration scoring.
    // TIME returns [seconds, microseconds].
    const timeRes = await this.redisService.client.time();
    const nowMs = parseInt(String(timeRes[0]), 10) * 1000 + Math.floor(parseInt(String(timeRes[1]), 10) / 1000);

    const result = await this.redisService.client.eval(
      RESERVE_SCRIPT,
      2,
      zsetKey,
      hashKey,
      nowMs.toString(),
      balanceMicros.toString(),
      estimateMicros.toString(),
      leaseMs.toString(),
      reservationId
    ) as [number, string];

    if (result[0] === 0) {
      return { allowed: false };
    }

    return {
      allowed: true,
      reservationId,
      reservedMicros: BigInt(result[1]),
    };
  }

  async extend(apiKeyId: string, reservationId: string, leaseMs: number): Promise<boolean> {
    const zsetKey = `credit:zset:${apiKeyId}`;
    const hashKey = `credit:hash:${apiKeyId}`;
    const result = (await this.redisService.client.eval(
      EXTEND_SCRIPT,
      2,
      zsetKey,
      hashKey,
      reservationId,
      leaseMs.toString(),
    )) as number;

    return result === 1;
  }

  async release(apiKeyId: string, reservationId: string): Promise<void> {
    const zsetKey = `credit:zset:${apiKeyId}`;
    const hashKey = `credit:hash:${apiKeyId}`;

    await this.redisService.client
      .multi()
      .zrem(zsetKey, reservationId)
      .hdel(hashKey, reservationId)
      .exec();
  }

  async activeReservedMicros(apiKeyId: string): Promise<bigint> {
    const zsetKey = `credit:zset:${apiKeyId}`;
    const hashKey = `credit:hash:${apiKeyId}`;
    
    const timeRes = await this.redisService.client.time();
    const nowMs = parseInt(String(timeRes[0]), 10) * 1000 + Math.floor(parseInt(String(timeRes[1]), 10) / 1000);

    // Run a quick cleanup and sum
    await this.redisService.client
      .multi()
      .zremrangebyscore(zsetKey, "-inf", (nowMs - 1).toString())
      .exec();

    const activeIds = await this.redisService.client.zrange(zsetKey, "0", "-1");
    if (activeIds.length === 0) {
      return 0n;
    }

    const values = await this.redisService.client.hmget(hashKey, ...activeIds);
    let total = 0n;
    for (const val of values) {
      if (val) {
        total += BigInt(val);
      }
    }

    return total;
  }
}
