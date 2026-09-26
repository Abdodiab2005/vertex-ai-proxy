import { describe, it, expect } from "vitest";
import { toRateLimitException } from "./rate-limits-errors.js";
import { GeminiApiException } from "../public-api/gemini-errors.js";
import type { AdmitResultRejected } from "./request-limiter.js";

describe("toRateLimitException (unit)", () => {
  const testCases: Array<{
    input: AdmitResultRejected;
    expectedMessage: string;
    expectedRetryAfter: number;
  }> = [
    {
      input: { allowed: false, limit: "requests_per_minute", retryAfterSeconds: 30 },
      expectedMessage: "Rate limit exceeded: requests per minute.",
      expectedRetryAfter: 30,
    },
    {
      input: { allowed: false, limit: "requests_per_day", retryAfterSeconds: 3600 },
      expectedMessage: "Rate limit exceeded: requests per day.",
      expectedRetryAfter: 3600,
    },
    {
      input: { allowed: false, limit: "tokens_per_minute", retryAfterSeconds: 45 },
      expectedMessage: "Rate limit exceeded: tokens per minute.",
      expectedRetryAfter: 45,
    },
    {
      input: { allowed: false, limit: "tokens_per_day", retryAfterSeconds: 7200 },
      expectedMessage: "Rate limit exceeded: tokens per day.",
      expectedRetryAfter: 7200,
    },
    {
      input: { allowed: false, limit: "tokens_per_month", retryAfterSeconds: 86400 },
      expectedMessage: "Rate limit exceeded: tokens per month.",
      expectedRetryAfter: 86400,
    },
  ];

  for (const tc of testCases) {
    it(`maps ${tc.input.limit} to correct exception`, () => {
      const exc = toRateLimitException(tc.input);
      expect(exc).toBeInstanceOf(GeminiApiException);
      expect(exc.getStatus()).toBe(429);
      const response = exc.getResponse() as { error: { code: number; message: string; status: string } };
      expect(response.error.code).toBe(429);
      expect(response.error.status).toBe("RESOURCE_EXHAUSTED");
      expect(response.error.message).toBe(tc.expectedMessage);
      expect(exc.retryAfterSeconds).toBe(tc.expectedRetryAfter);
    });
  }

  it("maps concurrency rejection", () => {
    const exc = toRateLimitException({ acquired: false });
    expect(exc).toBeInstanceOf(GeminiApiException);
    expect(exc.getStatus()).toBe(429);
    const response = exc.getResponse() as { error: { code: number; message: string; status: string } };
    expect(response.error.code).toBe(429);
    expect(response.error.status).toBe("RESOURCE_EXHAUSTED");
    expect(response.error.message).toBe("Too many concurrent requests for this API key.");
  });

  it("maps unknown limit to generic message", () => {
    const exc = toRateLimitException({
      allowed: false,
      limit: "unknown_limit" as AdmitResultRejected["limit"],
      retryAfterSeconds: 10,
    });
    const response = exc.getResponse() as { error: { message: string } };
    expect(response.error.message).toBe("Rate limit exceeded.");
  });
});