import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

export type GenerateContentRequestCheck =
  | { ok: true; request: JsonObject }
  | { ok: false; message: string };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requestError(message: string): GenerateContentRequestCheck {
  return { ok: false, message };
}

/** Vertex remains authoritative for fields the gateway does not need to interpret. */
export function checkGenerateContentRequest(body: unknown): GenerateContentRequestCheck {
  if (!isJsonObject(body)) {
    return requestError("Request body must be a JSON object.");
  }

  const contents = body.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    return requestError("contents must be a non-empty array.");
  }

  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index];
    if (!isJsonObject(content) || !Array.isArray(content.parts)) {
      return requestError(`contents[${index}] must be an object with a parts array.`);
    }
  }

  if (Object.hasOwn(body, "cachedContent")) {
    return requestError(
      "cachedContent is not supported by this gateway. Gemini API cache names do not exist on Vertex.",
    );
  }

  const generationConfig = body.generationConfig;
  if (
    isJsonObject(generationConfig) &&
    Object.hasOwn(generationConfig, "maxOutputTokens") &&
    !isPositiveInteger(generationConfig.maxOutputTokens)
  ) {
    return requestError("generationConfig.maxOutputTokens must be a positive integer.");
  }

  return { ok: true, request: body };
}

export function readMaxOutputTokens(request: JsonObject): number | null {
  const generationConfig = request.generationConfig;

  if (!isJsonObject(generationConfig) || !isPositiveInteger(generationConfig.maxOutputTokens)) {
    return null;
  }

  return generationConfig.maxOutputTokens;
}

/** Whether the request asks for generated images (generationConfig.responseModalities has IMAGE). */
export function requestsImageOutput(request: JsonObject): boolean {
  const generationConfig = request.generationConfig;
  if (!isJsonObject(generationConfig) || !Array.isArray(generationConfig.responseModalities)) {
    return false;
  }
  return generationConfig.responseModalities.some(
    (modality) => typeof modality === "string" && modality.toUpperCase() === "IMAGE",
  );
}

/**
 * Vertex counts thinking tokens toward maxOutputTokens, so this field bounds what a call can cost.
 * Unset, the model runs to its real output limit, which can be far above the tokens the hold priced;
 * above the hold (a client asking past the model limit an admin configured) the same. Either way the
 * body sent upstream carries the reserved amount. A client value within the hold is left alone.
 */
export function withReservedOutputCap(body: JsonObject, reservedOutputTokens: number): JsonObject {
  const requested = readMaxOutputTokens(body);
  if (requested !== null && requested <= reservedOutputTokens) {
    return body;
  }

  const generationConfig = isJsonObject(body.generationConfig) ? body.generationConfig : {};
  return {
    ...body,
    generationConfig: {
      ...generationConfig,
      maxOutputTokens: reservedOutputTokens,
    },
  };
}
