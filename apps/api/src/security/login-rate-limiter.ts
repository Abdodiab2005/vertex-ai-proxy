import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";
import { RedisService } from "../redis/redis.service.js";

const LOGIN_FAILURE_KEY_PREFIX = "admin-login:fail:";

// Atomically check all three throttle windows and admit the attempt.
// If any window is at or over capacity, return blocked and max TTL without incrementing.
// Otherwise, count the attempt in all three windows before password hashing begins.
const ADMIT_LOGIN_SCRIPT = `
  local windowSeconds = tonumber(ARGV[1])
  local limits = {
    tonumber(ARGV[2]),
    tonumber(ARGV[3]),
    tonumber(ARGV[4])
  }

  local maxTtl = 0
  local blocked = false

  for index = 1, #KEYS do
    local raw = redis.call("GET", KEYS[index])
    local count = 0
    if raw then
      count = tonumber(raw)
    end

    if count >= limits[index] then
      blocked = true
      local ttl = redis.call("TTL", KEYS[index])
      if ttl > maxTtl then
        maxTtl = ttl
      end
    end
  end

  if blocked then
    if maxTtl <= 0 then
      maxTtl = 1
    end
    return { 0, maxTtl }
  end

  for index = 1, #KEYS do
    local key = KEYS[index]
    redis.call("INCR", key)

    if redis.call("TTL", key) == -1 then
      redis.call("EXPIRE", key, windowSeconds)
    end
  end

  return { 1, 0 }
`;

// On successful login, reset the account+IP counter and decrement the account and IP
// counters so legitimate attempts do not consume the failure budget.
const RECORD_SUCCESS_SCRIPT = `
  redis.call("DEL", KEYS[1])

  for index = 2, #KEYS do
    local key = KEYS[index]
    local raw = redis.call("GET", key)
    if raw then
      local count = tonumber(raw)
      if count and count > 1 then
        redis.call("DECR", key)
      else
        redis.call("DEL", key)
      end
    end
  end
`;

const RECORD_FAILURE_SCRIPT = `
  local windowSeconds = tonumber(ARGV[1])

  for index = 1, #KEYS do
    local key = KEYS[index]
    redis.call("INCR", key)

    if redis.call("TTL", key) == -1 then
      redis.call("EXPIRE", key, windowSeconds)
    end
  end
`;

export interface LoginRateLimitCounts {
  accountIp: number;
  account: number;
  ip: number;
}

export interface LoginRateLimitTtls {
  accountIp: number;
  account: number;
  ip: number;
}

export interface LoginRateLimitLimits {
  accountIp: number;
  account: number;
  ip: number;
}

export type LoginRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type LoginRateLimitKey = keyof LoginRateLimitCounts;

interface LoginRateLimitKeys {
  accountIp: string;
  account: string;
  ip: string;
}

const rateLimitKeys: LoginRateLimitKey[] = ["accountIp", "account", "ip"];

export function decideLoginRateLimit(
  counts: LoginRateLimitCounts,
  ttls: LoginRateLimitTtls,
  limits: LoginRateLimitLimits,
): LoginRateLimitResult {
  const blockingTtls = rateLimitKeys
    .filter((key) => counts[key] >= limits[key])
    .map((key) => ttls[key]);

  if (blockingTtls.length === 0) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, ...blockingTtls),
  };
}

export function parseAdmitReply(reply: unknown): LoginRateLimitResult {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error("Unexpected Redis login rate-limit admit response");
  }

  const allowedNum = reply[0];
  const retryAfter = reply[1];

  if (typeof allowedNum !== "number" || typeof retryAfter !== "number") {
    throw new Error("Unexpected Redis login rate-limit admit response types");
  }

  if (allowedNum === 1) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, retryAfter),
  };
}

@Injectable()
export class LoginRateLimiter {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async admit(
    email: string,
    ip: string | null | undefined,
  ): Promise<LoginRateLimitResult> {
    const keys = this.keysFor(email, ip);
    const limits = this.limits;

    const reply = await this.redis.client.eval(
      ADMIT_LOGIN_SCRIPT,
      3,
      keys.accountIp,
      keys.account,
      keys.ip,
      this.config.env.ADMIN_LOGIN_WINDOW_SECONDS,
      limits.accountIp,
      limits.account,
      limits.ip,
    );

    return parseAdmitReply(reply);
  }

  async recordSuccess(
    email: string,
    ip: string | null | undefined,
  ): Promise<void> {
    const keys = this.keysFor(email, ip);

    await this.redis.client.eval(
      RECORD_SUCCESS_SCRIPT,
      3,
      keys.accountIp,
      keys.account,
      keys.ip,
    );
  }

  async check(
    email: string,
    ip: string | null | undefined,
  ): Promise<LoginRateLimitResult> {
    const keys = this.keysFor(email, ip);
    const transaction = this.redis.client.multi();

    transaction.mget([keys.accountIp, keys.account, keys.ip]);
    transaction.ttl(keys.accountIp);
    transaction.ttl(keys.account);
    transaction.ttl(keys.ip);

    const replies = unpackTransactionReplies(await transaction.exec());
    const counts = parseCounts(replies[0]);
    const ttls: LoginRateLimitTtls = {
      accountIp: parseTtl(replies[1]),
      account: parseTtl(replies[2]),
      ip: parseTtl(replies[3]),
    };

    return decideLoginRateLimit(counts, ttls, this.limits);
  }

  async recordFailure(
    email: string,
    ip: string | null | undefined,
  ): Promise<void> {
    const keys = this.keysFor(email, ip);

    await this.redis.client.eval(
      RECORD_FAILURE_SCRIPT,
      3,
      keys.accountIp,
      keys.account,
      keys.ip,
      this.config.env.ADMIN_LOGIN_WINDOW_SECONDS,
    );
  }

  clearAccountIp(
    email: string,
    ip: string | null | undefined,
  ): Promise<void> {
    return this.redis.client.del(this.keysFor(email, ip).accountIp).then(() => undefined);
  }

  private get limits(): LoginRateLimitLimits {
    return {
      accountIp: this.config.env.ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT_IP,
      account: this.config.env.ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT,
      ip: this.config.env.ADMIN_LOGIN_MAX_FAILURES_PER_IP,
    };
  }

  private keysFor(
    email: string,
    ip: string | null | undefined,
  ): LoginRateLimitKeys {
    const emailHash = createHash("sha256")
      .update(email.trim().toLowerCase())
      .digest("hex");
    const ipBucket = ip ?? "unknown";

    return {
      accountIp: `${LOGIN_FAILURE_KEY_PREFIX}account-ip:${emailHash}:${ipBucket}`,
      account: `${LOGIN_FAILURE_KEY_PREFIX}account:${emailHash}`,
      ip: `${LOGIN_FAILURE_KEY_PREFIX}ip:${ipBucket}`,
    };
  }
}

function unpackTransactionReplies(
  replies: [Error | null, unknown][] | null,
): unknown[] {
  if (replies === null) {
    throw new Error("Redis transaction was aborted");
  }

  return replies.map(([error, result]) => {
    if (error !== null) {
      throw error;
    }

    return result;
  });
}

function parseCounts(reply: unknown): LoginRateLimitCounts {
  if (!Array.isArray(reply) || reply.length !== rateLimitKeys.length) {
    throw new Error("Unexpected Redis login rate-limit counter response");
  }

  return {
    accountIp: parseCounter(reply[0]),
    account: parseCounter(reply[1]),
    ip: parseCounter(reply[2]),
  };
}

function parseCounter(reply: unknown): number {
  if (reply === null) {
    return 0;
  }

  if (typeof reply !== "string" || !/^\d+$/.test(reply)) {
    throw new Error("Unexpected Redis login rate-limit counter value");
  }

  const count = Number(reply);
  if (!Number.isSafeInteger(count)) {
    throw new Error("Unexpected Redis login rate-limit counter value");
  }

  return count;
}

function parseTtl(reply: unknown): number {
  if (typeof reply !== "number" || !Number.isInteger(reply)) {
    throw new Error("Unexpected Redis login rate-limit TTL response");
  }

  return reply;
}
