import { randomBytes, createHash } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX = "lvg_";
const KEY_LENGTH = 32;

/**
 * Generates a secure API key with the "lvg_" prefix and 32 base62 characters.
 * Uses rejection sampling to ensure uniform distribution (no modulo bias).
 */
export function generateApiKey(): string {
  const charLength = ALPHABET.length; // 62
  // We want bytes < 62 * floor(256 / 62) to avoid modulo bias.
  // 256 / 62 = 4.129, so floor is 4. Max valid byte is 62 * 4 - 1 = 247.
  const maxValidByte = charLength * Math.floor(256 / charLength) - 1;

  let key = "";
  while (key.length < KEY_LENGTH) {
    const bytes = randomBytes(KEY_LENGTH);
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte !== undefined && byte <= maxValidByte) {
        key += ALPHABET[byte % charLength];
        if (key.length === KEY_LENGTH) {
          break;
        }
      }
    }
  }

  return PREFIX + key;
}

/**
 * Hashes a raw API key using SHA-256 and returns a hex string.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Fast format check for an API key.
 * Expected shape: "lvg_" followed by 32 characters from ALPHABET.
 */
export function looksLikeApiKey(rawKey: string): boolean {
  if (!rawKey.startsWith(PREFIX)) return false;
  if (rawKey.length !== PREFIX.length + KEY_LENGTH) return false;
  
  const payload = rawKey.slice(PREFIX.length);
  for (let i = 0; i < payload.length; i++) {
    const charCode = payload.charCodeAt(i);
    // [0-9] is 48-57, [A-Z] is 65-90, [a-z] is 97-122
    if (
      !(charCode >= 48 && charCode <= 57) &&
      !(charCode >= 65 && charCode <= 90) &&
      !(charCode >= 97 && charCode <= 122)
    ) {
      return false;
    }
  }
  return true;
}
