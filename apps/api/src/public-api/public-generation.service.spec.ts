import { mapUpstreamError } from "./public-generation.service.js";
import { UpstreamError } from "../upstreams/providers/upstream-errors.js";
import { GeminiApiException } from "./gemini-errors.js";

describe("PublicGenerationService errors", () => {
  describe("mapUpstreamError", () => {
    it("maps authentication_failed to 503 without leaking message", () => {
      const error = new UpstreamError("Provider says invalid key", { kind: "authentication_failed", httpStatus: 401 });
      const mapped = mapUpstreamError(error);
      expect(mapped).toBeInstanceOf(GeminiApiException);
      expect(mapped.getStatus()).toBe(503);
      expect((mapped.getResponse() as { error: { message: string } }).error.message).toBe("The model is temporarily unavailable.");
    });
    
    it("maps permission_denied to 503 without leaking message", () => {
      const error = new UpstreamError("Provider says forbidden", { kind: "permission_denied", httpStatus: 403 });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(503);
      expect((mapped.getResponse() as { error: { message: string } }).error.message).toBe("The model is temporarily unavailable.");
    });
    
    it("maps model_unavailable to 404 NOT_FOUND", () => {
      const error = new UpstreamError("Model not found there", { kind: "model_unavailable", httpStatus: 404 });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(404);
      expect((mapped.getResponse() as { error: { status: string; message: string } }).error.status).toBe("NOT_FOUND");
    });
    
    it("maps quota_exhausted to 429 RESOURCE_EXHAUSTED", () => {
      const error = new UpstreamError("Upstream out of quota", { kind: "quota_exhausted", httpStatus: 429 });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(429);
      expect((mapped.getResponse() as { error: { message: string } }).error.message).toBe("Upstream capacity exhausted. Please retry later.");
    });
    
    it("maps network_error to 503 UNAVAILABLE", () => {
      const error = new UpstreamError("ECONNRESET", { kind: "network_error", httpStatus: null });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(503);
    });
    
    it("maps upstream_error with httpStatus 400 to 400 INVALID_ARGUMENT with message", () => {
      const error = new UpstreamError("Bad temperature", { kind: "upstream_error", httpStatus: 400 });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(400);
      expect((mapped.getResponse() as { error: { message: string } }).error.message).toBe("Bad temperature");
    });
    
    it("maps other upstream_error to 502 UNAVAILABLE with generic message", () => {
      const error = new UpstreamError("Internal server error", { kind: "upstream_error", httpStatus: 500 });
      const mapped = mapUpstreamError(error);
      expect(mapped.getStatus()).toBe(502);
      expect((mapped.getResponse() as { error: { message: string; status: string } }).error.message).toBe("An error occurred with the upstream provider.");
      expect((mapped.getResponse() as { error: { status: string } }).error.status).toBe("UNAVAILABLE");
    });
  });
});
