import { GeminiApiException } from "../public-api/gemini-errors.js";
import type { AdmitResultRejected } from "./request-limiter.js";

type RejectionResult = AdmitResultRejected | { acquired: false; limit?: string };

/**
 * Maps a rate limit rejection to a GeminiApiException with HTTP 429 and
 * Google status RESOURCE_EXHAUSTED.
 *
 * @param result - The rejection result from RequestLimiter.admitRequest or ConcurrencyLimiter.acquire
 * @returns A GeminiApiException ready to be thrown
 */
export function toRateLimitException(result: RejectionResult): GeminiApiException {
  if ("limit" in result && result.limit !== undefined) {
    // RequestLimiter rejection
    const messages: Record<string, string> = {
      requests_per_minute: "Rate limit exceeded: requests per minute.",
      requests_per_day: "Rate limit exceeded: requests per day.",
      tokens_per_minute: "Rate limit exceeded: tokens per minute.",
      tokens_per_day: "Rate limit exceeded: tokens per day.",
      tokens_per_month: "Rate limit exceeded: tokens per month.",
    };
    const message = messages[result.limit] ?? "Rate limit exceeded.";
    const retryAfterSeconds = "retryAfterSeconds" in result ? result.retryAfterSeconds : null;
    return new GeminiApiException(429, "RESOURCE_EXHAUSTED", message, retryAfterSeconds);
  }
  // ConcurrencyLimiter rejection
  return new GeminiApiException(
    429,
    "RESOURCE_EXHAUSTED",
    "Too many concurrent requests for this API key.",
  );
}