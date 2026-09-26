import { afterEach, describe, expect, it, vi } from "vitest";
import { UPSTREAM_ABORTED_IN_FLIGHT, UpstreamError } from "../upstreams/providers/upstream-errors.js";
import { isQuotaExhausted, isRetryableOnSameUpstream, jittered, quotaRetryDelays, setQuotaRetryDelaysForTests, sleepUnlessAborted } from "./quota-retry.js";

describe("quota retry helpers", () => {
  afterEach(() => {
    setQuotaRetryDelaysForTests(null);
    vi.useRealTimers();
  });

  it("backs off 1 s, 2 s, 4 s by default", () => {
    expect(quotaRetryDelays()).toEqual([1000, 2000, 4000]);
    setQuotaRetryDelaysForTests([5]);
    expect(quotaRetryDelays()).toEqual([5]);
  });

  it.each([
    [new UpstreamError("busy", { kind: "quota_exhausted", httpStatus: 429 }), true],
    [new UpstreamError("down", { kind: "upstream_error", httpStatus: 503 }), false],
    [new UpstreamError("bad", { kind: "upstream_error", httpStatus: 400 }), false],
    [new Error("other"), false],
  ])("treats only a quota 429 as retryable here (%#)", (error, expected) => {
    expect(isQuotaExhausted(error)).toBe(expected);
  });

  it.each([
    ["a capacity 429", new UpstreamError("busy", { kind: "quota_exhausted", httpStatus: 429 }), true],
    ["a connection never established", new UpstreamError("down", { kind: "network_error", httpStatus: null, causeCode: "ETIMEDOUT" }), true],
    [
      "a request that may have been sent",
      new UpstreamError("lost", { kind: "network_error", httpStatus: null, reason: UPSTREAM_ABORTED_IN_FLIGHT }),
      false,
    ],
    ["an upstream 5xx", new UpstreamError("down", { kind: "upstream_error", httpStatus: 503 }), false],
    ["an auth failure", new UpstreamError("no", { kind: "authentication_failed", httpStatus: 401 }), false],
  ])("retries %s on the same upstream: %s", (_name, error, expected) => {
    expect(isRetryableOnSameUpstream(error)).toBe(expected);
  });

  it("keeps the jitter within ±25%", () => {
    expect(jittered(1000, () => 0)).toBe(750);
    expect(jittered(1000, () => 0.5)).toBe(1000);
    expect(jittered(1000, () => 0.999999)).toBe(1250);
  });

  it("sleeps the full delay unless the signal aborts first", async () => {
    vi.useFakeTimers();
    const done = sleepUnlessAborted(1000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBe(true);

    const controller = new AbortController();
    const cut = sleepUnlessAborted(1000, controller.signal);
    controller.abort();
    await expect(cut).resolves.toBe(false);

    const already = new AbortController();
    already.abort();
    await expect(sleepUnlessAborted(1000, already.signal)).resolves.toBe(false);
  });
});
