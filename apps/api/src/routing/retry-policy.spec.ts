import type { RoutingStrategy } from "@gateway/contracts";
import { describe, expect, it } from "vitest";
import {
  UPSTREAM_ABORTED_IN_FLIGHT,
  UpstreamError,
  UpstreamInputError,
  type UpstreamErrorOptions,
} from "../upstreams/providers/upstream-errors.js";
import {
  isRetryableFailure,
  maxAttempts,
  type RetryFailureContext,
} from "./retry-policy.js";

interface FailureCase {
  name: string;
  options: UpstreamErrorOptions;
  expectedWithoutClientState: boolean;
}

const failureCases: FailureCase[] = [
  {
    name: "authentication failures",
    options: { kind: "authentication_failed", httpStatus: 401 },
    expectedWithoutClientState: false,
  },
  {
    name: "permission failures",
    options: { kind: "permission_denied", httpStatus: 403 },
    expectedWithoutClientState: false,
  },
  {
    name: "unavailable models",
    options: { kind: "model_unavailable", httpStatus: 404 },
    expectedWithoutClientState: false,
  },
  {
    name: "upstream quota exhaustion",
    options: { kind: "quota_exhausted", httpStatus: 429 },
    expectedWithoutClientState: true,
  },
  {
    name: "network failures",
    options: { kind: "network_error", httpStatus: null },
    expectedWithoutClientState: true,
  },
  {
    name: "upstream 5xx failures",
    options: { kind: "upstream_error", httpStatus: 503 },
    expectedWithoutClientState: true,
  },
  {
    name: "upstream failures without an HTTP status",
    options: { kind: "upstream_error", httpStatus: null },
    expectedWithoutClientState: true,
  },
  {
    name: "upstream 4xx failures",
    options: { kind: "upstream_error", httpStatus: 400 },
    expectedWithoutClientState: false,
  },
];

const blockedClientContexts: Array<{ name: string; context: RetryFailureContext }> = [
  {
    name: "after a response starts",
    context: { responseStarted: true, clientAborted: false },
  },
  {
    name: "after the client aborts",
    context: { responseStarted: false, clientAborted: true },
  },
  {
    name: "after a response starts and the client aborts",
    context: { responseStarted: true, clientAborted: true },
  },
];

describe("isRetryableFailure", () => {
  it.each(failureCases)(
    "retries $name only before response data reaches the client",
    ({ options, expectedWithoutClientState }) => {
      const error = new UpstreamError("Upstream failed.", options);

      expect(
        isRetryableFailure(error, { responseStarted: false, clientAborted: false }),
      ).toBe(expectedWithoutClientState);
    },
  );

  it.each(
    failureCases.flatMap((failure) =>
      blockedClientContexts.map((clientState) => ({
        name: `${failure.name} ${clientState.name}`,
        options: failure.options,
        context: clientState.context,
      })),
    ),
  )("does not retry $name", ({ options, context }) => {
    const error = new UpstreamError("Upstream failed.", options);

    expect(isRetryableFailure(error, context)).toBe(false);
  });

  it("does not retry a safety refusal even when it otherwise looks retryable", () => {
    const error = new UpstreamError("Upstream refused the request.", {
      kind: "network_error",
      httpStatus: null,
      reason: "SAFETY",
    });

    expect(isRetryableFailure(error, { responseStarted: false, clientAborted: false })).toBe(
      false,
    );
  });

  it("does not retry a request cancelled in flight, which the upstream may already have billed", () => {
    const error = new UpstreamError("Cancelled.", {
      kind: "network_error",
      httpStatus: null,
      reason: UPSTREAM_ABORTED_IN_FLIGHT,
    });

    expect(isRetryableFailure(error, { responseStarted: false, clientAborted: false })).toBe(
      false,
    );
  });

  it.each([
    {
      name: "input validation errors",
      error: new UpstreamInputError("Input is invalid."),
    },
    { name: "ordinary errors", error: new Error("Unexpected failure.") },
    { name: "non-error values", error: { kind: "network_error" } },
  ])("does not retry $name", ({ error }) => {
    expect(isRetryableFailure(error, { responseStarted: false, clientAborted: false })).toBe(
      false,
    );
  });
});

describe("maxAttempts", () => {
  it.each([
    { strategy: "fallback", orderLength: 0, expected: 0 },
    { strategy: "fallback", orderLength: 1, expected: 1 },
    { strategy: "fallback", orderLength: 2, expected: 2 },
    { strategy: "fallback", orderLength: 3, expected: 3 },
    { strategy: "fallback", orderLength: 4, expected: 3 },
    { strategy: "priority", orderLength: 4, expected: 1 },
    { strategy: "round_robin", orderLength: 4, expected: 1 },
    { strategy: "manual", orderLength: 4, expected: 1 },
  ] satisfies Array<{ strategy: RoutingStrategy; orderLength: number; expected: number }>)(
    "allows $expected attempt(s) for $strategy with $orderLength route(s)", ({
      strategy,
      orderLength,
      expected,
    }) => {
      expect(maxAttempts(strategy, orderLength)).toBe(expected);
    });
});
