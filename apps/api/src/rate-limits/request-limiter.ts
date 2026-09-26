import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service.js";

const RATELIMIT_KEY_PREFIX = "ratelimit:";

type LimitKind =
  | "requests_per_minute"
  | "requests_per_day"
  | "tokens_per_minute"
  | "tokens_per_day"
  | "tokens_per_month";

export interface RequestLimiterLimits {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
}

export interface AdmitResultAllowed {
  allowed: true;
}

export interface AdmitResultRejected {
  allowed: false;
  limit: LimitKind;
  retryAfterSeconds: number;
}

export type AdmitRequestResult = AdmitResultAllowed | AdmitResultRejected;

export interface UsageCounters {
  requestsThisMinute: number;
  requestsToday: number;
  tokensThisMinute: number;
  tokensToday: number;
  tokensThisMonth: number;
}

/**
 * Howard Hinnant's civil date algorithms for Lua.
 * Used to compute UTC calendar month boundaries without os.date().
 */
const CIVIL_DATE_HELPERS = `
-- Howard Hinnant's civil_from_days: converts days since 1970-01-01 to (year, month, day)
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

-- Howard Hinnant's days_from_civil: converts (year, month, day) to days since 1970-01-01
local function days_from_civil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local mp = (m + 9) % 12
  local doy = math.floor((153 * mp + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end
`;

/**
 * Lua script for atomic admitRequest.
 *
 * KEYS[1] = API key prefix with hash tag, e.g. "ratelimit:{<apiKeyId>}:"
 *
 * ARGV[1] = requestsPerMinute limit (or -1 for unlimited)
 * ARGV[2] = requestsPerDay limit (or -1 for unlimited)
 * ARGV[3] = tokensPerMinute limit (or -1 for unlimited)
 * ARGV[4] = tokensPerDay limit (or -1 for unlimited)
 * ARGV[5] = tokensPerMonth limit (or -1 for unlimited)
 * ARGV[6] = estimated tokens for this request (0 if not provided)
 *
 * Returns array:
 * [0] = allowed (1/0)
 * [1] = limit kind index (1=requests_per_minute, 2=requests_per_day, 3=tokens_per_minute, 4=tokens_per_day, 5=tokens_per_month) or 0
 * [2] = retryAfterSeconds (0 if allowed)
 * [3] = current minute request count after increment (if allowed)
 * [4] = current day request count after increment (if allowed)
 */
const ADMIT_REQUEST_SCRIPT = CIVIL_DATE_HELPERS + `
  local prefix = KEYS[1]

  local requests_per_minute_limit = tonumber(ARGV[1])
  local requests_per_day_limit = tonumber(ARGV[2])
  local tokens_per_minute_limit = tonumber(ARGV[3])
  local tokens_per_day_limit = tonumber(ARGV[4])
  local tokens_per_month_limit = tonumber(ARGV[5])
  local estimated_tokens = tonumber(ARGV[6])

  -- Get current time from Redis
  local time = redis.call("TIME")
  local now_seconds = tonumber(time[1])
  local now_microseconds = tonumber(time[2])

  -- Compute window IDs from Redis server time (UTC)
  local minute_id = math.floor(now_seconds / 60)
  local day_id = math.floor(now_seconds / 86400)

  -- Compute month_id = year * 12 + (month - 1) for current UTC month
  local days_since_epoch = math.floor(now_seconds / 86400)
  local y, m, d = civil_from_days(days_since_epoch)
  local month_id = y * 12 + (m - 1)

  -- Compute window ends for retry-after and TTL
  local minute_window_end = (minute_id + 1) * 60
  local day_window_end = (day_id + 1) * 86400
  -- Next month's first day at 00:00:00 UTC
  local next_month_y = m == 12 and y + 1 or y
  local next_month_m = m == 12 and 1 or m + 1
  local month_window_end = days_from_civil(next_month_y, next_month_m, 1) * 86400

  -- Build keys with hash tag (all keys for this API key in same cluster slot)
  local minute_req_key = prefix .. "rpm:" .. minute_id
  local day_req_key = prefix .. "rpd:" .. day_id
  local minute_tok_key = prefix .. "tpm:" .. minute_id
  local day_tok_key = prefix .. "tpd:" .. day_id
  local month_tok_key = prefix .. "tpmo:" .. month_id

  -- Read current counters
  local minute_req_count = tonumber(redis.call("GET", minute_req_key) or "0")
  local day_req_count = tonumber(redis.call("GET", day_req_key) or "0")
  local minute_tok_count = tonumber(redis.call("GET", minute_tok_key) or "0")
  local day_tok_count = tonumber(redis.call("GET", day_tok_key) or "0")
  local month_tok_count = tonumber(redis.call("GET", month_tok_key) or "0")

  -- Check request limits: reject if already at limit
  if requests_per_minute_limit >= 0 and minute_req_count >= requests_per_minute_limit then
    local retry_after = math.max(1, minute_window_end - now_seconds)
    return {0, 1, retry_after, 0, 0}
  end

  if requests_per_day_limit >= 0 and day_req_count >= requests_per_day_limit then
    local retry_after = math.max(1, day_window_end - now_seconds)
    return {0, 2, retry_after, 0, 0}
  end

  -- Check token limits:
  -- Reject if current count >= limit (at limit), OR
  -- if estimated_tokens > 0 and current + estimated > limit (would exceed)
  if tokens_per_minute_limit >= 0 then
    if minute_tok_count >= tokens_per_minute_limit or
       (estimated_tokens > 0 and minute_tok_count + estimated_tokens > tokens_per_minute_limit) then
      local retry_after = math.max(1, minute_window_end - now_seconds)
      return {0, 3, retry_after, 0, 0}
    end
  end

  if tokens_per_day_limit >= 0 then
    if day_tok_count >= tokens_per_day_limit or
       (estimated_tokens > 0 and day_tok_count + estimated_tokens > tokens_per_day_limit) then
      local retry_after = math.max(1, day_window_end - now_seconds)
      return {0, 4, retry_after, 0, 0}
    end
  end

  if tokens_per_month_limit >= 0 then
    if month_tok_count >= tokens_per_month_limit or
       (estimated_tokens > 0 and month_tok_count + estimated_tokens > tokens_per_month_limit) then
      local retry_after = math.max(1, month_window_end - now_seconds)
      return {0, 5, retry_after, 0, 0}
    end
  end

  -- All checks passed: increment request counters
  local new_minute_req = redis.call("INCR", minute_req_key)
  local new_day_req = redis.call("INCR", day_req_key)

  -- Set expiry if not already set (TTL slightly longer than window)
  if redis.call("TTL", minute_req_key) == -1 then
    redis.call("EXPIRE", minute_req_key, 120) -- 2 minutes
  end
  if redis.call("TTL", day_req_key) == -1 then
    redis.call("EXPIRE", day_req_key, 86460) -- 24h + 1 minute
  end
  if redis.call("TTL", minute_tok_key) == -1 then
    redis.call("EXPIRE", minute_tok_key, 120)
  end
  if redis.call("TTL", day_tok_key) == -1 then
    redis.call("EXPIRE", day_tok_key, 86460)
  end
  if redis.call("TTL", month_tok_key) == -1 then
    redis.call("EXPIRE", month_tok_key, 2678460) -- 31 days + 1 minute
  end

  return {1, 0, 0, new_minute_req, new_day_req}
`;

/**
 * Lua script for atomic recordTokens.
 *
 * KEYS[1] = API key prefix with hash tag, e.g. "ratelimit:{<apiKeyId>}:"
 *
 * ARGV[1] = tokens to add (non-negative integer)
 *
 * Returns array: [new_minute, new_day, new_month]
 */
const RECORD_TOKENS_SCRIPT = CIVIL_DATE_HELPERS + `
  local prefix = KEYS[1]
  local tokens_to_add = tonumber(ARGV[1])
  if tokens_to_add < 0 then tokens_to_add = 0 end

  -- Get current time from Redis
  local time = redis.call("TIME")
  local now_seconds = tonumber(time[1])

  -- Compute window IDs
  local minute_id = math.floor(now_seconds / 60)
  local day_id = math.floor(now_seconds / 86400)
  local days_since_epoch = math.floor(now_seconds / 86400)
  local y, m, d = civil_from_days(days_since_epoch)
  local month_id = y * 12 + (m - 1)

  -- Build keys
  local minute_tok_key = prefix .. "tpm:" .. minute_id
  local day_tok_key = prefix .. "tpd:" .. day_id
  local month_tok_key = prefix .. "tpmo:" .. month_id

  local new_minute = redis.call("INCRBY", minute_tok_key, tokens_to_add)
  local new_day = redis.call("INCRBY", day_tok_key, tokens_to_add)
  local new_month = redis.call("INCRBY", month_tok_key, tokens_to_add)

  -- Set expiry if not already set
  if redis.call("TTL", minute_tok_key) == -1 then
    redis.call("EXPIRE", minute_tok_key, 120)
  end
  if redis.call("TTL", day_tok_key) == -1 then
    redis.call("EXPIRE", day_tok_key, 86460)
  end
  if redis.call("TTL", month_tok_key) == -1 then
    redis.call("EXPIRE", month_tok_key, 2678460)
  end

  return {new_minute, new_day, new_month}
`;

/**
 * Lua script for getting usage counters.
 *
 * KEYS[1] = API key prefix with hash tag, e.g. "ratelimit:{<apiKeyId>}:"
 *
 * Returns array: [minute_req, day_req, minute_tok, day_tok, month_tok]
 */
const USAGE_SCRIPT = CIVIL_DATE_HELPERS + `
  local prefix = KEYS[1]

  -- Get current time from Redis
  local time = redis.call("TIME")
  local now_seconds = tonumber(time[1])

  -- Compute window IDs
  local minute_id = math.floor(now_seconds / 60)
  local day_id = math.floor(now_seconds / 86400)
  local days_since_epoch = math.floor(now_seconds / 86400)
  local y, m, d = civil_from_days(days_since_epoch)
  local month_id = y * 12 + (m - 1)

  -- Build keys
  local minute_req_key = prefix .. "rpm:" .. minute_id
  local day_req_key = prefix .. "rpd:" .. day_id
  local minute_tok_key = prefix .. "tpm:" .. minute_id
  local day_tok_key = prefix .. "tpd:" .. day_id
  local month_tok_key = prefix .. "tpmo:" .. month_id

  local minute_req = tonumber(redis.call("GET", minute_req_key) or "0")
  local day_req = tonumber(redis.call("GET", day_req_key) or "0")
  local minute_tok = tonumber(redis.call("GET", minute_tok_key) or "0")
  local day_tok = tonumber(redis.call("GET", day_tok_key) or "0")
  local month_tok = tonumber(redis.call("GET", month_tok_key) or "0")

  return {minute_req, day_req, minute_tok, day_tok, month_tok}
`;

/**
 * Lua script for resetting all counters for an API key.
 * Uses SCAN with pattern "ratelimit:{<apiKeyId>}:*" (braces escaped for MATCH).
 * Note: This is called from TS side since SCAN cannot be used inside Lua effectively.
 * But we can still use a Lua script for the actual deletion if we pass the keys.
 * For simplicity, we keep the TS-side SCAN loop but with the new pattern.
 */

/**
 * Builds the Redis key prefix with hash tag for a given API key ID.
 * Format: "ratelimit:{<apiKeyId>}:"
 */
function getKeyPrefix(apiKeyId: string): string {
  return `${RATELIMIT_KEY_PREFIX}{${apiKeyId}}:`;
}

/**
 * Builds the SCAN pattern for resetCounters.
 * Braces must be escaped in MATCH pattern: "ratelimit:\{<id>\}:*"
 */
function getScanPattern(apiKeyId: string): string {
  return `${RATELIMIT_KEY_PREFIX}\\{${apiKeyId}\\}:*`;
}

@Injectable()
export class RequestLimiter {
  constructor(private readonly redis: RedisService) {}

  /**
   * Atomically checks all configured limits and increments request counters if allowed.
   * All time and window boundaries come from Redis server TIME inside the Lua script.
   *
   * @param apiKeyId - The API key identifier
   * @param limits - Per-key limits from the database (null = unlimited)
   * @param estimatedTokens - Estimated tokens for this request (input tokens), used for pre-checking token limits
   * @returns AdmitRequestResult with allowed=true or rejection details including retryAfterSeconds
   */
  async admitRequest(
    apiKeyId: string,
    limits: RequestLimiterLimits,
    estimatedTokens: number = 0,
  ): Promise<AdmitRequestResult> {
    const prefix = getKeyPrefix(apiKeyId);

    const args = [
      limits.requestsPerMinute ?? -1,
      limits.requestsPerDay ?? -1,
      limits.tokensPerMinute ?? -1,
      limits.tokensPerDay ?? -1,
      limits.tokensPerMonth ?? -1,
      estimatedTokens,
    ];

    const result = (await this.redis.client.eval(
      ADMIT_REQUEST_SCRIPT,
      1,
      prefix,
      ...args.map(String),
    )) as number[];

    const allowed = result[0] === 1;
    if (allowed) {
      return { allowed: true };
    }

    const limitKindIndex = result[1];
    const retryAfterSeconds = result[2];
    const limitKinds: LimitKind[] = [
      "requests_per_minute",
      "requests_per_day",
      "tokens_per_minute",
      "tokens_per_day",
      "tokens_per_month",
    ];

    return {
      allowed: false,
      limit: limitKinds[limitKindIndex - 1],
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  /**
   * Records token usage after a request completes.
   * Token limits are enforced on the NEXT request (pre-check in admitRequest).
   * The gateway can't know a response's tokens in advance, so this is called
   * after the upstream responds with actual token counts.
   *
   * Pre-check semantics in admitRequest:
   * - Reject if current token count >= limit (at limit), OR
   * - if estimatedTokens > 0 and current + estimatedTokens > limit (would exceed)
   *
   * @param apiKeyId - The API key identifier
   * @param tokens - Total tokens used (prompt + completion), must be non-negative
   */
  async recordTokens(apiKeyId: string, tokens: number): Promise<void> {
    if (tokens < 0 || !Number.isSafeInteger(tokens)) {
      throw new Error("tokens must be a non-negative safe integer");
    }
    if (tokens === 0) {
      return; // No-op for zero tokens
    }

    const prefix = getKeyPrefix(apiKeyId);

    await this.redis.client.eval(RECORD_TOKENS_SCRIPT, 1, prefix, tokens.toString());
  }

  /**
   * Returns current usage counters for the admin UI.
   * All windows use Redis server time for consistency.
   */
  async usage(apiKeyId: string): Promise<UsageCounters> {
    const prefix = getKeyPrefix(apiKeyId);

    const result = (await this.redis.client.eval(USAGE_SCRIPT, 1, prefix)) as number[];

    return {
      requestsThisMinute: result[0],
      requestsToday: result[1],
      tokensThisMinute: result[2],
      tokensToday: result[3],
      tokensThisMonth: result[4],
    };
  }

  /**
   * Deletes all rate limit counters for an API key.
   * Uses SCAN to avoid blocking Redis (never KEYS).
   * Pattern: "ratelimit:\{<apiKeyId>\}:*" (braces escaped for MATCH).
   * This never touches the database, so historical usage and credit history are untouched.
   */
  async resetCounters(apiKeyId: string): Promise<void> {
    const pattern = getScanPattern(apiKeyId);
    let cursor = "0";
    const keysToDelete: string[] = [];

    do {
      const [nextCursor, keys] = await this.redis.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      keysToDelete.push(...keys);
    } while (cursor !== "0");

    if (keysToDelete.length > 0) {
      await this.redis.client.del(...keysToDelete);
    }
  }
}