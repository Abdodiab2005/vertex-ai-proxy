import type { RoutingStrategy } from "@gateway/contracts";
import {
  isAbortedInFlight,
  UpstreamError,
  UpstreamInputError,
} from "../upstreams/providers/upstream-errors.js";

export interface RetryFailureContext {
  responseStarted: boolean;
  clientAborted: boolean;
}

/**
 * To avoid double billing, a request is retried only when the preceding attempt produced no
 * billable output that reached the client; the caller must still settle usage returned by every
 * attempt when the upstream supplied it.
 */
export function isRetryableFailure(error: unknown, context: RetryFailureContext): boolean {
  if (context.responseStarted || context.clientAborted || error instanceof UpstreamInputError) {
    return false;
  }

  if (!(error instanceof UpstreamError) || error.reason === "SAFETY" || isAbortedInFlight(error)) {
    return false;
  }

  switch (error.kind) {
    case "network_error":
    case "quota_exhausted":
      return true;
    case "upstream_error":
      return error.httpStatus === null || error.httpStatus >= 500;
    case "authentication_failed":
    case "permission_denied":
    case "model_unavailable":
      return false;
  }
}

export function maxAttempts(strategy: RoutingStrategy, orderLength: number): number {
  if (strategy === "fallback") {
    return Math.min(orderLength, 3);
  }

  return 1;
}
