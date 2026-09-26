import { isAbortedInFlight, UpstreamError } from "../upstreams/providers/upstream-errors.js";

/**
 * Vertex answers 429 "Resource exhausted. Please try again later." when the shared capacity for a
 * model runs short for a moment (it happens at random, most with new models). Google doesn't bill
 * those requests and asks callers to retry with exponential backoff, so the same upstream is tried
 * again after each of these delays before the 429 reaches the client.
 */
const DEFAULT_QUOTA_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

let delaysOverride: readonly number[] | null = null;

export function quotaRetryDelays(): readonly number[] {
  return delaysOverride ?? DEFAULT_QUOTA_RETRY_DELAYS_MS;
}

/** Short delays let tests exercise the retries without waiting out the production backoff. */
export function setQuotaRetryDelaysForTests(delays: readonly number[] | null): void {
  delaysOverride = delays;
}

export function isQuotaExhausted(error: unknown): boolean {
  return error instanceof UpstreamError && error.kind === "quota_exhausted";
}

/**
 * Failures worth retrying on the same upstream: a capacity 429, and a connection that was never
 * established (the request never reached Vertex, so it cannot have been billed). A request that may
 * have been sent is never repeated.
 */
export function isRetryableOnSameUpstream(error: unknown): boolean {
  if (isQuotaExhausted(error)) {
    return true;
  }
  return error instanceof UpstreamError && error.kind === "network_error" && !isAbortedInFlight(error);
}

/** ±25% so requests that failed together don't all retry at the same instant. */
export function jittered(delayMs: number, random: () => number = Math.random): number {
  return Math.round(delayMs * (0.75 + random() * 0.5));
}

/** Resolves true after the delay, or false as soon as the signal aborts (the client left). */
export function sleepUnlessAborted(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
