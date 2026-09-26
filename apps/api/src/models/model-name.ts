// One character class shared by public names and aliases. A slash is excluded
// so the Gemini "models/{name}" path prefix cannot be part of a stored name.
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GEMINI_MODELS_PREFIX = "models/";

export function isModelName(value: string): boolean {
  return MODEL_NAME_PATTERN.test(value);
}

export function canonicalRequestedModelName(requestedName: string): string {
  if (requestedName.startsWith(GEMINI_MODELS_PREFIX)) {
    return requestedName.slice(GEMINI_MODELS_PREFIX.length);
  }
  return requestedName;
}
