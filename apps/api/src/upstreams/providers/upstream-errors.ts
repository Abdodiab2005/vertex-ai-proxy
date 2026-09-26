export type UpstreamFailureKind =
  | "authentication_failed"
  | "permission_denied"
  | "model_unavailable"
  | "quota_exhausted"
  | "network_error"
  | "upstream_error";

export interface UpstreamErrorOptions {
  kind: UpstreamFailureKind;
  httpStatus: number | null;
  upstreamStatus?: string | null;
  reason?: string | null;
  /** The socket error code behind a network failure (e.g. ETIMEDOUT), for logs only. */
  causeCode?: string | null;
}

export class UpstreamError extends Error {
  readonly kind: UpstreamFailureKind;
  readonly httpStatus: number | null;
  readonly upstreamStatus: string | null;
  readonly reason: string | null;
  readonly causeCode: string | null;

  constructor(message: string, options: UpstreamErrorOptions) {
    super(message);
    this.name = "UpstreamError";
    this.kind = options.kind;
    this.httpStatus = options.httpStatus;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.reason = options.reason ?? null;
    this.causeCode = options.causeCode ?? null;
  }
}

/**
 * The request was already on its way when it was cancelled (a timeout or the client leaving), so the
 * upstream may have processed and billed it. Retrying elsewhere could pay for it twice.
 */
export const UPSTREAM_ABORTED_IN_FLIGHT = "ABORTED_IN_FLIGHT";

export function isAbortedInFlight(error: unknown): boolean {
  return error instanceof UpstreamError && error.reason === UPSTREAM_ABORTED_IN_FLIGHT;
}

export class UpstreamInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamInputError";
  }
}

interface GoogleErrorDetails {
  message: string | null;
  upstreamStatus: string | null;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getGoogleErrorDetails(body: unknown): GoogleErrorDetails {
  if (!isRecord(body) || !isRecord(body.error)) {
    return { message: null, upstreamStatus: null, reason: null };
  }

  const error = body.error;
  const rawMessage = error.message;
  const message = typeof rawMessage === "string" ? rawMessage.trim().slice(0, 500) : null;
  const upstreamStatus = typeof error.status === "string" ? error.status : null;
  const reasons = Array.isArray(error.details)
    ? error.details.flatMap((detail) =>
        isRecord(detail) && typeof detail.reason === "string" ? [detail.reason] : [],
      )
    : [];
  const reason = reasons.find((candidate) => candidate === "API_KEY_INVALID") ?? reasons[0] ?? null;

  return {
    message,
    upstreamStatus,
    reason,
  };
}

function failureKindFor(httpStatus: number, reason: string | null): UpstreamFailureKind {
  if (httpStatus === 400 && reason === "API_KEY_INVALID") {
    return "authentication_failed";
  }

  switch (httpStatus) {
    case 401:
      return "authentication_failed";
    case 403:
      return "permission_denied";
    case 404:
      return "model_unavailable";
    case 429:
      return "quota_exhausted";
    default:
      return "upstream_error";
  }
}

export function classifyHttpFailure(httpStatus: number, body: unknown): UpstreamError {
  const { message, upstreamStatus, reason } = getGoogleErrorDetails(body);

  return new UpstreamError(message ?? `Upstream returned HTTP ${httpStatus}.`, {
    kind: failureKindFor(httpStatus, reason),
    httpStatus,
    upstreamStatus,
    reason,
  });
}
