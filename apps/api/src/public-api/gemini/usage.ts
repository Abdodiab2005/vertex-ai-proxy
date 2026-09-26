import type { UsageQuantities } from "../../pricing/pricing-engine.js";
import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

interface Count {
  present: boolean;
  value: number | null;
}

interface ModalityDetails {
  audio: number;
  audioPresent: boolean;
  image: number;
  imagePresent: boolean;
  valid: boolean;
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCount(object: JsonObject, field: string): Count {
  if (!Object.hasOwn(object, field)) {
    return { present: false, value: null };
  }

  const value = object[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { present: true, value: null };
  }

  return { present: true, value };
}

function isValidCount(count: Count): boolean {
  return !count.present || count.value !== null;
}

function actualCountValue(count: Count): number | null {
  return count.present ? count.value : null;
}

function optionalCountValue(count: Count): number | null {
  if (!isValidCount(count)) {
    return null;
  }

  return count.value ?? 0;
}

function readModalityDetails(object: JsonObject, field: string): ModalityDetails {
  if (!Object.hasOwn(object, field)) {
    return { audio: 0, audioPresent: false, image: 0, imagePresent: false, valid: true };
  }

  const value = object[field];
  if (!Array.isArray(value)) {
    return { audio: 0, audioPresent: false, image: 0, imagePresent: false, valid: false };
  }

  let audio = 0;
  let audioPresent = false;
  let image = 0;
  let imagePresent = false;
  let valid = true;

  for (const item of value) {
    if (!isJsonObject(item)) {
      valid = false;
      continue;
    }

    const tokenCount = readCount(item, "tokenCount");
    if (!tokenCount.present || tokenCount.value === null) {
      valid = false;
      continue;
    }

    if (item.modality === "AUDIO") {
      audioPresent = true;
      if (audio > MAX_SAFE_INTEGER - tokenCount.value) {
        valid = false;
        continue;
      }
      audio += tokenCount.value;
    } else if (item.modality === "IMAGE") {
      imagePresent = true;
      if (image > MAX_SAFE_INTEGER - tokenCount.value) {
        valid = false;
        continue;
      }
      image += tokenCount.value;
    }
  }

  return { audio, audioPresent, image, imagePresent, valid };
}

function positiveQuantity(quantities: UsageQuantities, dimension: string, value: number | null): void {
  if (value !== null && value > 0) {
    quantities[dimension] = value;
  }
}

function subtractCounts(left: number, right: number): number | null {
  if (right > left) {
    return null;
  }

  return left - right;
}

function inputTokens(
  prompt: Count,
  toolUsePrompt: Count,
  cached: Count,
  promptDetails: ModalityDetails,
): number | null {
  const promptValue = optionalCountValue(prompt);
  const toolUsePromptValue = optionalCountValue(toolUsePrompt);
  const cachedValue = optionalCountValue(cached);

  if (
    promptValue === null ||
    toolUsePromptValue === null ||
    cachedValue === null ||
    !promptDetails.valid
  ) {
    return null;
  }

  if (promptValue > MAX_SAFE_INTEGER - toolUsePromptValue) {
    return null;
  }

  const promptAndToolUse = promptValue + toolUsePromptValue;
  const afterCache = subtractCounts(promptAndToolUse, cachedValue);
  return afterCache === null ? null : subtractCounts(afterCache, promptDetails.audio);
}

function outputTokens(candidates: Count, candidateDetails: ModalityDetails): number | null {
  const candidatesValue = optionalCountValue(candidates);
  if (candidatesValue === null || !candidateDetails.valid) {
    return null;
  }

  // Generated images are billed at their own (much higher) rate, so they leave output_tokens too.
  const withoutAudio = subtractCounts(candidatesValue, candidateDetails.audio);
  return withoutAudio === null ? null : subtractCounts(withoutAudio, candidateDetails.image);
}

/**
 * To avoid billing a token twice: cached_input_tokens = cachedContentTokenCount;
 * audio dimensions use AUDIO details; input_tokens = prompt + tool use - cached
 * - input audio; output_tokens = candidates - output audio - output images; image_output_tokens =
 * IMAGE candidate details (input images stay in input_tokens); reasoning_tokens = thoughts.
 */
export function usageQuantitiesFromMetadata(usageMetadata: unknown): {
  quantities: UsageQuantities;
  complete: boolean;
} {
  if (!isJsonObject(usageMetadata)) {
    return { quantities: {}, complete: false };
  }

  const prompt = readCount(usageMetadata, "promptTokenCount");
  const candidates = readCount(usageMetadata, "candidatesTokenCount");
  const total = readCount(usageMetadata, "totalTokenCount");
  const cached = readCount(usageMetadata, "cachedContentTokenCount");
  const thoughts = readCount(usageMetadata, "thoughtsTokenCount");
  const toolUsePrompt = readCount(usageMetadata, "toolUsePromptTokenCount");
  const promptDetails = readModalityDetails(usageMetadata, "promptTokensDetails");
  const candidateDetails = readModalityDetails(usageMetadata, "candidatesTokensDetails");
  const cacheDetails = readModalityDetails(usageMetadata, "cacheTokensDetails");

  // Gemini's JSON omits zero-valued counts, so an absent candidatesTokenCount (e.g. a
  // blocked prompt) is zero output. A real prompt always has tokens, so an absent
  // promptTokenCount means the usage can't be trusted.
  let complete =
    prompt.present &&
    isValidCount(prompt) &&
    isValidCount(candidates) &&
    isValidCount(total) &&
    isValidCount(cached) &&
    isValidCount(thoughts) &&
    isValidCount(toolUsePrompt) &&
    promptDetails.valid &&
    candidateDetails.valid &&
    cacheDetails.valid;

  const quantities: UsageQuantities = {};

  positiveQuantity(quantities, "cached_input_tokens", actualCountValue(cached));
  positiveQuantity(
    quantities,
    "audio_input_tokens",
    promptDetails.valid && promptDetails.audioPresent ? promptDetails.audio : null,
  );
  positiveQuantity(quantities, "reasoning_tokens", actualCountValue(thoughts));
  positiveQuantity(
    quantities,
    "audio_output_tokens",
    candidateDetails.valid && candidateDetails.audioPresent ? candidateDetails.audio : null,
  );
  // Vertex reports generated images inside candidatesTokenCount, split out as IMAGE details.
  positiveQuantity(
    quantities,
    "image_output_tokens",
    candidateDetails.valid && candidateDetails.imagePresent ? candidateDetails.image : null,
  );

  const input = inputTokens(prompt, toolUsePrompt, cached, promptDetails);
  if (input === null) {
    if (prompt.present && isValidCount(prompt)) {
      complete = false;
    }
  } else {
    positiveQuantity(quantities, "input_tokens", input);
  }

  const output = outputTokens(candidates, candidateDetails);
  if (output === null) {
    if (candidates.present && isValidCount(candidates)) {
      complete = false;
    }
  } else {
    positiveQuantity(quantities, "output_tokens", output);
  }

  return { quantities, complete };
}
