import { describe, expect, it } from "vitest";
import {
  decideLoginRateLimit,
  parseAdmitReply,
  type LoginRateLimitCounts,
  type LoginRateLimitLimits,
  type LoginRateLimitTtls,
} from "./login-rate-limiter.js";

const limits: LoginRateLimitLimits = {
  accountIp: 5,
  account: 50,
  ip: 20,
};

const underLimitCounts: LoginRateLimitCounts = {
  accountIp: 4,
  account: 49,
  ip: 19,
};

const ttls: LoginRateLimitTtls = {
  accountIp: 30,
  account: 60,
  ip: 45,
};

describe("decideLoginRateLimit", () => {
  it("allows attempts while every counter is below its limit", () => {
    expect(decideLoginRateLimit(underLimitCounts, ttls, limits)).toEqual({
      allowed: true,
    });
  });

  it.each([
    ["account and IP", "accountIp", 5],
    ["account", "account", 50],
    ["IP", "ip", 20],
  ] as const)("blocks when the %s counter reaches its limit", (_label, key, value) => {
    const counts = { ...underLimitCounts, [key]: value };

    expect(decideLoginRateLimit(counts, ttls, limits)).toEqual({
      allowed: false,
      retryAfterSeconds: ttls[key],
    });
  });

  it("uses the longest TTL among blocking counters and never returns zero", () => {
    expect(
      decideLoginRateLimit(
        { accountIp: 5, account: 50, ip: 19 },
        { accountIp: 0, account: 75, ip: 45 },
        limits,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 75 });

    expect(
      decideLoginRateLimit(
        { accountIp: 5, account: 49, ip: 19 },
        { accountIp: -2, account: 60, ip: 45 },
        limits,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe("parseAdmitReply", () => {
  it("parses allowed reply [1, 0]", () => {
    expect(parseAdmitReply([1, 0])).toEqual({ allowed: true });
  });

  it("parses blocked reply [0, ttl] with retryAfterSeconds", () => {
    expect(parseAdmitReply([0, 42])).toEqual({
      allowed: false,
      retryAfterSeconds: 42,
    });
  });

  it("ensures retryAfterSeconds is at least 1 when Redis reports 0 or negative TTL", () => {
    expect(parseAdmitReply([0, 0])).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(parseAdmitReply([0, -1])).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("throws on invalid or non-array replies", () => {
    expect(() => parseAdmitReply(null)).toThrow("Unexpected Redis login rate-limit admit response");
    expect(() => parseAdmitReply([1])).toThrow("Unexpected Redis login rate-limit admit response");
    expect(() => parseAdmitReply(["1", "0"])).toThrow("Unexpected Redis login rate-limit admit response types");
  });
});
