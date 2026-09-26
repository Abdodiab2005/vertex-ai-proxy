import { classifyHttpFailure, UpstreamError } from "./upstream-errors.js";

describe("classifyHttpFailure", () => {
  it.each([
    [
      "invalid API key",
      400,
      {
        error: {
          code: 400,
          message: "Invalid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      },
      "authentication_failed",
      "INVALID_ARGUMENT",
      "API_KEY_INVALID",
      "Invalid API key.",
    ],
    [
      "invalid API key after another detailed reason",
      400,
      {
        error: {
          code: 400,
          message: "Invalid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "BAD_REQUEST" }, { reason: "API_KEY_INVALID" }],
        },
      },
      "authentication_failed",
      "INVALID_ARGUMENT",
      "API_KEY_INVALID",
      "Invalid API key.",
    ],
    [
      "other bad request",
      400,
      {
        error: {
          code: 400,
          message: "Request is invalid.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "BAD_REQUEST" }],
        },
      },
      "upstream_error",
      "INVALID_ARGUMENT",
      "BAD_REQUEST",
      "Request is invalid.",
    ],
    [
      "unauthenticated response",
      401,
      { error: { code: 401, message: "Authentication is required.", status: "UNAUTHENTICATED" } },
      "authentication_failed",
      "UNAUTHENTICATED",
      null,
      "Authentication is required.",
    ],
    [
      "service disabled",
      403,
      {
        error: {
          code: 403,
          message: "Vertex AI is disabled.",
          status: "PERMISSION_DENIED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.RequestInfo" },
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
          ],
        },
      },
      "permission_denied",
      "PERMISSION_DENIED",
      "SERVICE_DISABLED",
      "Vertex AI is disabled.",
    ],
    [
      "missing model",
      404,
      { error: { code: 404, message: "Model was not found.", status: "NOT_FOUND" } },
      "model_unavailable",
      "NOT_FOUND",
      null,
      "Model was not found.",
    ],
    [
      "rate limited response",
      429,
      { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } },
      "quota_exhausted",
      "RESOURCE_EXHAUSTED",
      null,
      "Quota exceeded.",
    ],
    [
      "internal server response",
      500,
      { error: { code: 500, message: "Internal error.", status: "INTERNAL" } },
      "upstream_error",
      "INTERNAL",
      null,
      "Internal error.",
    ],
    [
      "unavailable response",
      503,
      { error: { code: 503, message: "Service unavailable.", status: "UNAVAILABLE" } },
      "upstream_error",
      "UNAVAILABLE",
      null,
      "Service unavailable.",
    ],
    ["non-Google response", 502, "not JSON", "upstream_error", null, null, "Upstream returned HTTP 502."],
  ])(
    "classifies %s",
    (_name, httpStatus, body, kind, upstreamStatus, reason, message) => {
      const error = classifyHttpFailure(httpStatus, body);

      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ kind, httpStatus, upstreamStatus, reason, message });
    },
  );

  it("trims and limits a Google error message", () => {
    const error = classifyHttpFailure(500, { error: { message: `  ${"x".repeat(501)}  ` } });

    expect(error.message).toHaveLength(500);
    expect(error.message).toBe("x".repeat(500));
  });
});
