const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const GEMINI_ACTIONS = [
  "generateContent",
  "streamGenerateContent",
  "countTokens",
  "embedContent",
  "batchEmbedContents",
] as const;

export type GeminiAction = (typeof GEMINI_ACTIONS)[number];

function isGeminiAction(value: string): value is GeminiAction {
  return (GEMINI_ACTIONS as readonly string[]).includes(value);
}

export function parseModelAction(segment: string): { model: string; action: GeminiAction } | null {
  const separatorIndex = segment.lastIndexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  const model = segment.slice(0, separatorIndex);
  const action = segment.slice(separatorIndex + 1);

  if (!MODEL_ID_PATTERN.test(model) || !isGeminiAction(action)) {
    return null;
  }

  return { model, action };
}
