import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOKEN_COUNT_FIELDS = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount"];

/**
 * What a relayed stream has shown so far. Vertex puts token counts only on the last event (earlier
 * ones carry `usageMetadata: { trafficType }` and nothing else), so a client that disconnects just
 * before it has received the answer without any usage to bill; the delivered text is what's left
 * to estimate from.
 */
export class StreamObservation {
  private latestUsage: JsonObject | undefined;
  private textChars = 0;

  readonly onEvent = (event: JsonObject): void => {
    const usage = event.usageMetadata;
    if (isJsonObject(usage) && TOKEN_COUNT_FIELDS.some((field) => Object.hasOwn(usage, field))) {
      this.latestUsage = usage;
    }
    this.textChars += deliveredChars(event);
  };

  /** The latest usageMetadata that carries token counts, if any arrived. */
  get usageMetadata(): JsonObject | undefined {
    return this.latestUsage;
  }

  /** Characters of answer text and function-call arguments forwarded to the client. */
  get deliveredTextChars(): number {
    return this.textChars;
  }
}

function deliveredChars(event: JsonObject): number {
  let total = 0;
  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  for (const candidate of candidates) {
    if (!isJsonObject(candidate) || !isJsonObject(candidate.content) || !Array.isArray(candidate.content.parts)) {
      continue;
    }
    for (const part of candidate.content.parts) {
      if (!isJsonObject(part)) {
        continue;
      }
      if (typeof part.text === "string") {
        total += part.text.length;
      }
      if (isJsonObject(part.functionCall)) {
        total += JSON.stringify(part.functionCall).length;
      }
    }
  }
  return total;
}
