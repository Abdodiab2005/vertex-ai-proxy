import { UpstreamError, UpstreamInputError } from "./upstream-errors.js";
import type { JsonObject } from "./upstream-provider.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): UpstreamError {
  return new UpstreamError("Upstream returned an invalid count tokens response.", {
    kind: "upstream_error",
    httpStatus: null,
  });
}

const COUNT_TOKENS_INPUT_MESSAGE =
  "Count tokens input must include contents or generateContentRequest.";

/**
 * Vertex selects the model from the URL, so the nested Gemini model must not be forwarded.
 */
export function toVertexCountTokensRequest(geminiRequest: JsonObject): JsonObject {
  if (Object.hasOwn(geminiRequest, "generateContentRequest")) {
    const generateContentRequest = geminiRequest.generateContentRequest;
    if (!isJsonObject(generateContentRequest)) {
      throw new UpstreamInputError(COUNT_TOKENS_INPUT_MESSAGE);
    }

    const vertexRequest: JsonObject = { ...generateContentRequest };
    delete vertexRequest.model;
    return vertexRequest;
  }

  if (Object.hasOwn(geminiRequest, "contents")) {
    return { ...geminiRequest };
  }

  throw new UpstreamInputError(COUNT_TOKENS_INPUT_MESSAGE);
}

export function fromVertexCountTokensResponse(body: unknown): JsonObject {
  if (!isJsonObject(body)) {
    throw invalidResponse();
  }

  const totalTokens = body.totalTokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) {
    throw invalidResponse();
  }

  const response: JsonObject = { totalTokens };

  if (body.promptTokensDetails !== undefined) {
    if (!Array.isArray(body.promptTokensDetails)) {
      throw invalidResponse();
    }

    response.promptTokensDetails = body.promptTokensDetails;
  }

  if (body.cachedContentTokenCount !== undefined) {
    const cachedContentTokenCount = body.cachedContentTokenCount;
    if (typeof cachedContentTokenCount !== "number" || !Number.isFinite(cachedContentTokenCount)) {
      throw invalidResponse();
    }

    response.cachedContentTokenCount = cachedContentTokenCount;
  }

  return response;
}
