import { canonicalRequestedModelName, isModelName } from "../../models/model-name.js";
import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

export const MAX_BATCH_EMBED_REQUESTS = 100;

const MODEL_MISMATCH_MESSAGE = "Each request's model must match the model in the URL.";

const EMBED_REQUEST_FIELDS = ["content", "taskType", "title", "outputDimensionality"] as const;

export type BatchEmbedParseResult =
  | { ok: true; requests: JsonObject[] }
  | { ok: false; message: string };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `equivalentNames` is the resolved model's public name and aliases. A request may omit
 * `model`. `models/<name>` and `<name>` are the same name, and either may be an alias.
 */
export function parseBatchEmbedRequests(
  body: JsonObject,
  urlModel: string,
  equivalentNames: ReadonlySet<string>,
): BatchEmbedParseResult {
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    return { ok: false, message: "requests must be a non-empty array." };
  }
  if (requests.length > MAX_BATCH_EMBED_REQUESTS) {
    return { ok: false, message: `requests must contain at most ${MAX_BATCH_EMBED_REQUESTS} items.` };
  }

  const mapped: JsonObject[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const item = requests[index];
    if (!isJsonObject(item)) {
      return { ok: false, message: `requests[${index}] must be an object.` };
    }
    if (Object.hasOwn(item, "model") && !sameModel(item.model, urlModel, equivalentNames)) {
      return { ok: false, message: MODEL_MISMATCH_MESSAGE };
    }
    mapped.push(embedContentBody(item));
  }

  return { ok: true, requests: mapped };
}

/**
 * The reservation estimator counts `contents`. An embed item carries one `content`.
 */
export function embedReservationBody(request: JsonObject): JsonObject {
  if (isJsonObject(request.content)) {
    return { contents: [request.content] };
  }
  return {};
}

function sameModel(requested: unknown, urlModel: string, equivalentNames: ReadonlySet<string>): boolean {
  if (typeof requested !== "string") {
    return false;
  }
  const canonical = canonicalRequestedModelName(requested);
  if (!isModelName(canonical)) {
    return false;
  }
  const urlCanonical = canonicalRequestedModelName(urlModel);
  return canonical === urlCanonical || equivalentNames.has(canonical);
}

function embedContentBody(item: JsonObject): JsonObject {
  const body: JsonObject = {};
  for (const field of EMBED_REQUEST_FIELDS) {
    if (Object.hasOwn(item, field)) {
      body[field] = item[field];
    }
  }
  return body;
}
