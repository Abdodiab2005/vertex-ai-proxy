import {
  PricingConfigurationError,
  selectEffectiveRules,
  TOKEN_PRICE_FALLBACKS,
  type PricingRuleInput,
} from "../pricing/pricing-engine.js";
import { readMaxOutputTokens } from "../public-api/gemini/generate-content-request.js";
import {
  decodedBase64ByteLength,
  mediaKindForMimeType,
  type MediaKind,
} from "../public-api/gemini/media-parts.js";
import type { JsonObject } from "../upstreams/providers/upstream-provider.js";
import { ceilDivide } from "./money.js";

/**
 * Decoded bytes per reserved token. Compressed audio, video, documents, and
 * images tokenize denser than raw samples, so these ratios over-estimate on
 * purpose. A part smaller than `tokensPerMediaPart` still pays that floor.
 */
export const INLINE_MEDIA_BYTES_PER_TOKEN: Readonly<Record<MediaKind, number>> = Object.freeze({
  audio: 500,
  video: 200,
  document: 200,
  image: 1000,
});

const PRICE_SCALE = 100_000_000n;
const PRICE_SCALE_TO_MICROS = 100n;

export interface ReservationPolicy {
  charsPerToken: number;
  tokensPerMediaPart: number;
  defaultMaxOutputTokens: number;
  /** Tokens reserved per fileData part. The object size is not visible here. */
  fileUriHoldTokens: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimateTextTokens(text: string, policy: ReservationPolicy): number {
  return Math.ceil(Array.from(text).length / policy.charsPerToken);
}

function estimateInlineDataTokens(inlineData: unknown, policy: ReservationPolicy): number {
  if (
    !isJsonObject(inlineData) ||
    typeof inlineData.data !== "string" ||
    typeof inlineData.mimeType !== "string"
  ) {
    return policy.tokensPerMediaPart;
  }

  const kind = mediaKindForMimeType(inlineData.mimeType);
  const bytes = decodedBase64ByteLength(inlineData.data);
  if (kind === null || bytes === null) {
    return policy.tokensPerMediaPart;
  }

  const bytesPerToken = INLINE_MEDIA_BYTES_PER_TOKEN[kind];
  const sized = Math.floor((bytes + bytesPerToken - 1) / bytesPerToken);
  return Math.max(policy.tokensPerMediaPart, sized);
}

function estimatePartTokens(part: unknown, policy: ReservationPolicy): number {
  if (!isJsonObject(part)) {
    return policy.tokensPerMediaPart;
  }

  let tokens = 0;
  let recognized = false;

  if (typeof part.text === "string") {
    tokens += estimateTextTokens(part.text, policy);
    recognized = true;
  }

  if (Object.hasOwn(part, "inlineData")) {
    tokens += estimateInlineDataTokens(part.inlineData, policy);
    recognized = true;
  }

  if (Object.hasOwn(part, "fileData")) {
    tokens += policy.fileUriHoldTokens;
    recognized = true;
  }

  return recognized ? tokens : policy.tokensPerMediaPart;
}

function estimatePartsTokens(parts: unknown, policy: ReservationPolicy): number {
  if (!Array.isArray(parts)) {
    return 0;
  }

  return parts.reduce(
    (tokens, part) => tokens + estimatePartTokens(part, policy),
    0,
  );
}

function estimateFunctionDeclarationTokens(
  declaration: unknown,
  policy: ReservationPolicy,
): number {
  try {
    const serialized = JSON.stringify(declaration);
    return typeof serialized === "string"
      ? estimateTextTokens(serialized, policy)
      : policy.tokensPerMediaPart;
  } catch {
    return policy.tokensPerMediaPart;
  }
}

function estimateToolTokens(tools: unknown, policy: ReservationPolicy): number {
  if (!Array.isArray(tools)) {
    return 0;
  }

  return tools.reduce((tokens, tool) => {
    if (!isJsonObject(tool) || !Array.isArray(tool.functionDeclarations)) {
      return tokens;
    }

    return (
      tokens +
      tool.functionDeclarations.reduce(
        (declarationTokens, declaration) =>
          declarationTokens + estimateFunctionDeclarationTokens(declaration, policy),
        0,
      )
    );
  }, 0);
}

function parsePriceScaled(price: string): bigint {
  const [integerPart = "0", fractionalPart = ""] = price.split(".");
  const scaledFraction = (fractionalPart + "00000000").slice(0, 8);

  return BigInt(integerPart) * PRICE_SCALE + BigInt(scaledFraction);
}

function lineCostMicros(tokens: number, rule: PricingRuleInput): bigint {
  const numerator = BigInt(tokens) * parsePriceScaled(rule.price);
  const denominator = BigInt(rule.unitSize) * PRICE_SCALE_TO_MICROS;

  return ceilDivide(numerator, denominator);
}

function hasHigherPerTokenPrice(
  candidate: PricingRuleInput,
  current: PricingRuleInput,
): boolean {
  return (
    parsePriceScaled(candidate.price) * BigInt(current.unitSize) >
    parsePriceScaled(current.price) * BigInt(candidate.unitSize)
  );
}

function effectiveOrFallback(
  effectiveRules: Map<string, PricingRuleInput>,
  dimension: string,
): PricingRuleInput | undefined {
  const own = effectiveRules.get(dimension);
  if (own !== undefined) {
    return own;
  }

  const fallbackDimension = TOKEN_PRICE_FALLBACKS[dimension];
  if (fallbackDimension === undefined) {
    return undefined;
  }

  return effectiveRules.get(fallbackDimension);
}

function requireSingleCurrency(rules: Iterable<PricingRuleInput>): void {
  let currency: string | null = null;

  for (const rule of rules) {
    if (currency === null) {
      currency = rule.currency;
    } else if (currency !== rule.currency) {
      throw new PricingConfigurationError(
        `Mixed currencies in effective rules: ${currency} and ${rule.currency}`,
      );
    }
  }
}

export function estimateInputTokens(request: JsonObject, policy: ReservationPolicy): number {
  let tokens = 0;

  if (Array.isArray(request.contents)) {
    for (const content of request.contents) {
      if (isJsonObject(content)) {
        tokens += estimatePartsTokens(content.parts, policy);
      }
    }
  }

  if (isJsonObject(request.systemInstruction)) {
    tokens += estimatePartsTokens(request.systemInstruction.parts, policy);
  }

  return tokens + estimateToolTokens(request.tools, policy);
}

export function estimateOutputTokens(
  request: JsonObject,
  modelOutputTokenLimit: number | null,
  policy: ReservationPolicy,
): number {
  const requestedLimit = readMaxOutputTokens(request);

  if (requestedLimit === null) {
    return modelOutputTokenLimit ?? policy.defaultMaxOutputTokens;
  }

  return modelOutputTokenLimit === null
    ? requestedLimit
    : Math.min(requestedLimit, modelOutputTokenLimit);
}

export function estimateReservationMicros(input: {
  request: JsonObject;
  rules: PricingRuleInput[];
  at: Date;
  modelOutputTokenLimit: number | null;
  policy: ReservationPolicy;
}): { micros: bigint; priced: boolean } {
  const effectiveRules = selectEffectiveRules(input.rules, input.at);
  requireSingleCurrency(effectiveRules.values());

  const inputRule = effectiveRules.get("input_tokens");
  const outputRule = effectiveRules.get("output_tokens");

  if (!inputRule || !outputRule) {
    return { micros: 0n, priced: false };
  }

  // Thinking tokens and generated images count against maxOutputTokens, so the whole output budget
  // is held at the highest of the output, reasoning (or its fallback) and image output rates. Only
  // image models have an image price, so text models are held as before.
  const outputReservationRule = [
    effectiveOrFallback(effectiveRules, "reasoning_tokens"),
    effectiveRules.get("image_output_tokens"),
  ].reduce<PricingRuleInput>(
    (highest, candidate) =>
      candidate !== undefined && hasHigherPerTokenPrice(candidate, highest) ? candidate : highest,
    outputRule,
  );

  const inputTokens = estimateInputTokens(input.request, input.policy);
  const outputTokens = estimateOutputTokens(
    input.request,
    input.modelOutputTokenLimit,
    input.policy,
  );

  return {
    micros:
      lineCostMicros(inputTokens, inputRule) +
      lineCostMicros(outputTokens, outputReservationRule),
    priced: true,
  };
}

export function estimateInputOnlyReservationMicros(
  request: JsonObject,
  rule: PricingRuleInput,
  policy: ReservationPolicy,
): bigint {
  const inputTokens = estimateInputTokens(request, policy);
  return lineCostMicros(inputTokens, rule);
}
