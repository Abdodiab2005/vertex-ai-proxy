import { UpstreamError, UpstreamInputError } from "./upstream-errors.js";
import type { JsonObject } from "./upstream-provider.js";

export type VertexEmbeddingApi = "predict" | "embedContent";

export interface VertexEmbeddingResult {
  response: JsonObject;
  inputTokens: number | null;
}

const TEXT_ONLY_EMBEDDING_INPUT_MESSAGE = "Embedding input must be text for this model.";
const UNSUPPORTED_EMBEDDING_MODEL_MESSAGE = "Embeddings are not supported for this model.";
const NON_TEXT_PART_FIELDS = [
  "inlineData",
  "fileData",
  "functionCall",
  "functionResponse",
  "executableCode",
  "codeExecutionResult",
] as const;

/**
 * gemini-embedding-001 and the text-embedding family are still served by predict.
 * Later models use embedContent only when the id actually names a Gemini model.
 */
export function vertexEmbeddingApiFor(upstreamModelId: string): VertexEmbeddingApi {
  if (
    upstreamModelId === "gemini-embedding-001" ||
    upstreamModelId.startsWith("text-embedding-") ||
    upstreamModelId.startsWith("text-multilingual-embedding-")
  ) {
    return "predict";
  }

  if (upstreamModelId.includes("gemini")) {
    return "embedContent";
  }

  throw new UpstreamInputError(UNSUPPORTED_EMBEDDING_MODEL_MESSAGE);
}

export function toVertexPredictEmbeddingRequest(geminiRequest: JsonObject): JsonObject {
  const content = geminiRequest.content;
  if (!isJsonObject(content) || !Array.isArray(content.parts)) {
    throw inputError();
  }

  const texts = content.parts.map((part) => textFromPart(part));

  const instance: JsonObject = { content: texts.join("\n") };
  if (typeof geminiRequest.taskType === "string") {
    instance.task_type = geminiRequest.taskType;
  }
  if (typeof geminiRequest.title === "string") {
    instance.title = geminiRequest.title;
  }

  const request: JsonObject = { instances: [instance] };
  const outputDimensionality = finiteOutputDimensionality(geminiRequest.outputDimensionality);
  if (outputDimensionality !== undefined) {
    request.parameters = { outputDimensionality };
  }

  return request;
}

export function toVertexEmbedContentRequest(geminiRequest: JsonObject): JsonObject {
  const request: JsonObject = { content: geminiRequest.content };
  const embedContentConfig: JsonObject = {};

  if (typeof geminiRequest.taskType === "string") {
    embedContentConfig.taskType = geminiRequest.taskType;
  }
  if (typeof geminiRequest.title === "string") {
    embedContentConfig.title = geminiRequest.title;
  }
  const outputDimensionality = finiteOutputDimensionality(geminiRequest.outputDimensionality);
  if (outputDimensionality !== undefined) {
    embedContentConfig.outputDimensionality = outputDimensionality;
  }

  if (Object.keys(embedContentConfig).length > 0) {
    request.embedContentConfig = embedContentConfig;
  }

  return request;
}

export function fromVertexPredictEmbeddingResponse(body: unknown): VertexEmbeddingResult {
  if (!isJsonObject(body) || !Array.isArray(body.predictions)) {
    throw invalidEmbeddingResponse();
  }

  const prediction = body.predictions[0];
  if (!isJsonObject(prediction) || !isJsonObject(prediction.embeddings)) {
    throw invalidEmbeddingResponse();
  }

  const { embeddings } = prediction;
  if (!isNumberArray(embeddings.values)) {
    throw invalidEmbeddingResponse();
  }

  return {
    response: { embedding: { values: embeddings.values } },
    inputTokens: optionalNumberFrom(embeddings.statistics, "token_count"),
  };
}

export function fromVertexEmbedContentResponse(body: unknown): VertexEmbeddingResult {
  if (!isJsonObject(body) || !isJsonObject(body.embedding) || !isNumberArray(body.embedding.values)) {
    throw invalidEmbeddingResponse();
  }

  return {
    response: { embedding: { values: body.embedding.values } },
    inputTokens: optionalNumberFrom(body.usageMetadata, "promptTokenCount"),
  };
}

function textFromPart(part: unknown): string {
  if (!isJsonObject(part) || typeof part.text !== "string") {
    throw inputError();
  }

  // A media or tool payload is not text input, even when a text field is also set.
  if (NON_TEXT_PART_FIELDS.some((field) => part[field] !== undefined)) {
    throw inputError();
  }

  return part.text;
}

function finiteOutputDimensionality(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    throw new UpstreamInputError("Embedding outputDimensionality must be a finite number.");
  }

  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function optionalNumberFrom(value: unknown, key: string): number | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return null;
  }

  return candidate;
}

function inputError(): UpstreamInputError {
  return new UpstreamInputError(TEXT_ONLY_EMBEDDING_INPUT_MESSAGE);
}

function invalidEmbeddingResponse(): UpstreamError {
  return new UpstreamError("Upstream returned an invalid embedding response.", {
    kind: "upstream_error",
    httpStatus: null,
  });
}
