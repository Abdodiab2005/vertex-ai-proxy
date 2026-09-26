import { describe, it, expect } from "vitest";
import { Credit80Rule } from "../credit-rules.js";
import { Credit100Rule } from "../credit-rules.js";
import { HighErrorRateRule } from "../credit-rules.js";
import { UpstreamUnavailableRule } from "../credit-rules.js";
import { SpendThresholdRule } from "../credit-rules.js";
import { Upstream } from "@gateway/database";

describe("Credit80Rule", () => {
  const rule = new Credit80Rule();

  function makeContext(totalAdded: string, totalConsumed: string, remaining: string, apiKeyId = "key-1") {
    return {
      creditSummary: { totalAdded, totalConsumed, remaining, totalRemoved: "0", totalRefunded: "0", adjustmentsNet: "0", currency: "USD" },
      apiKeyId,
    };
  }

  it("alerts at exactly 80% consumed", () => {
    // consumed = 80 (totalConsumed = -80), remaining = 20 => total = 100 => 80%
    const ctx = makeContext("100", "-80", "20");
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.severity).toBe("warning");
    expect(result!.dedupeKey).toBe("credit_80:key-1");
    expect(result!.data.percentage).toBe("80");
  });

  it("alerts above 80% (e.g., 85%)", () => {
    const ctx = makeContext("100", "-85", "15");
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.data.percentage).toBe("85");
  });

  it("does not alert just below 80% (e.g., 79%)", () => {
    const ctx = makeContext("100", "-79", "21");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when remaining <= 0 (no credit left)", () => {
    const ctx = makeContext("100", "-100", "0");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when remaining < 0 (overdrawn)", () => {
    const ctx = makeContext("100", "-120", "-20");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when total is 0 (no credit ever added)", () => {
    const ctx = makeContext("0", "0", "0");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("handles large micro-unit values correctly", () => {
    // 100.50 total, 80.40 consumed, 20.10 remaining = 80%
    const ctx = makeContext("100.50", "-80.40", "20.10");
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.data.percentage).toBe("80");
  });
});

describe("Credit100Rule", () => {
  const rule = new Credit100Rule();

  function makeContext(totalAdded: string, totalConsumed: string, remaining: string, apiKeyId = "key-1") {
    return {
      creditSummary: { totalAdded, totalConsumed, remaining, totalRemoved: "0", totalRefunded: "0", adjustmentsNet: "0", currency: "USD" },
      apiKeyId,
    };
  }

  it("alerts when remaining <= 0 and credit was added", () => {
    const ctx = makeContext("100", "100", "0");
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.severity).toBe("critical");
    expect(result!.dedupeKey).toBe("credit_100:key-1");
  });

  it("alerts when remaining < 0 (overdrawn) and credit was added", () => {
    const ctx = makeContext("100", "120", "-20");
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
  });

  it("does not alert when remaining > 0", () => {
    const ctx = makeContext("100", "50", "50");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when remaining <= 0 but no credit was ever added (totalAdded = 0)", () => {
    const ctx = makeContext("0", "0", "0");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when remaining <= 0 but totalAdded is 0", () => {
    const ctx = makeContext("0", "10", "-10");
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });
});

describe("HighErrorRateRule", () => {
  const rule = new HighErrorRateRule();

  it.each([
    { name: "fewer than 20 requests", total: 19, errors: 19, alert: false },
    { name: "just under 20% errors", total: 100, errors: 19, alert: false },
    { name: "exactly 20% errors", total: 20, errors: 4, alert: true },
    { name: "a high error share", total: 50, errors: 30, alert: true },
    { name: "no traffic", total: 0, errors: 0, alert: false },
  ])("$name -> alert $alert", ({ total, errors, alert }) => {
    const result = rule.evaluate({ requestCounts: { total, errors } });
    expect(result !== null).toBe(alert);
    if (result) {
      expect(result.dedupeKey).toBe("high_error_rate:global");
      expect(result.data).toEqual(expect.objectContaining({ errorCount: errors, totalCount: total }));
    }
  });

  it("does nothing without counts", () => {
    expect(rule.evaluate({})).toBeNull();
  });
});

describe("UpstreamUnavailableRule", () => {
  const rule = new UpstreamUnavailableRule();

  const baseUpstream: Upstream = {
    id: "upstream-1",
    name: "Test Upstream",
    provider: "vertex-ai",
    enabled: true,
    projectId: "test-project",
    location: "us-central1",
    authMethod: "service-account",
    encryptedCredentials: null,
    credentialSummary: null,
    priority: 0,
    status: "connected",
    lastCheckedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("alerts for authentication_failed", () => {
    const ctx = { upstream: { ...baseUpstream, status: "authentication_failed" } };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.severity).toBe("critical");
    expect(result!.dedupeKey).toBe("upstream_unavailable:upstream-1");
  });

  it("alerts for permission_denied", () => {
    const ctx = { upstream: { ...baseUpstream, status: "permission_denied" } };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
  });

  it("alerts for network_error", () => {
    const ctx = { upstream: { ...baseUpstream, status: "network_error" } };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
  });

  it("alerts for quota_exhausted", () => {
    const ctx = { upstream: { ...baseUpstream, status: "quota_exhausted" } };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
  });

  it("alerts for upstream_error", () => {
    const ctx = { upstream: { ...baseUpstream, status: "upstream_error" } };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
  });

  it("does not alert for connected", () => {
    const ctx = { upstream: { ...baseUpstream, status: "connected" } };
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert for unknown", () => {
    const ctx = { upstream: { ...baseUpstream, status: "unknown" } };
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert for model_unavailable", () => {
    const ctx = { upstream: { ...baseUpstream, status: "model_unavailable" } };
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when upstream is disabled", () => {
    const ctx = { upstream: { ...baseUpstream, status: "authentication_failed", enabled: false } };
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when upstream is null", () => {
    const result = rule.evaluate({ upstream: undefined });
    expect(result).toBeNull();
  });
});

describe("SpendThresholdRule", () => {
  const rule = new SpendThresholdRule();

  const baseSpendStatus = {
    trackedSpendUsd: "100.00",
    upstreamBudget: "100.00",
    safetyReserve: "10.00",
    usableTarget: "90.00",
    label: "Gateway tracked / estimated upstream spend",
  } as const;

  it("alerts when thresholdReached is true", () => {
    const ctx = {
      spendStatus: {
        ...baseSpendStatus,
        thresholdReached: true,
      },
    };
    const result = rule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result!.shouldAlert).toBe(true);
    expect(result!.severity).toBe("critical");
    expect(result!.dedupeKey).toBe("spend_threshold:global");
  });

  it("does not alert when thresholdReached is false", () => {
    const ctx = {
      spendStatus: {
        ...baseSpendStatus,
        thresholdReached: false,
      },
    };
    const result = rule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it("does not alert when spendStatus is missing", () => {
    const result = rule.evaluate({});
    expect(result).toBeNull();
  });

  it("does not alert when spendStatus is undefined", () => {
    const result = rule.evaluate({ spendStatus: undefined });
    expect(result).toBeNull();
  });
});