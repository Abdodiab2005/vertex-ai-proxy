import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Thrown when the encryption key format is invalid (wrong length, encoding, etc.).
 * The message never contains the invalid input.
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * Thrown when decryption fails due to malformed payload, wrong key, or
 * authentication failure. The message never contains the plaintext, key,
 * or associatedData.
 */
export class CredentialDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

/**
 * Accepts base64 or base64url text that decodes to EXACTLY 32 bytes (AES-256).
 * Surrounding whitespace is trimmed.
 * Anything else (wrong length, invalid characters, empty) throws EncryptionKeyError.
 */
export function parseEncryptionKey(encoded: string): Buffer {
  const trimmed = encoded.trim();
  // Buffer.from(..., "base64") never throws: it silently skips characters outside the
  // alphabet, so a mistyped key could still decode to 32 bytes. Validate the text first.
  const buffer = ENCRYPTION_KEY_TEXT.test(trimmed) ? Buffer.from(trimmed, "base64") : null;

  if (buffer === null || buffer.length !== 32) {
    throw new EncryptionKeyError(
      "Encryption key must be 32 bytes encoded as base64, e.g. from `openssl rand -base64 32`",
    );
  }

  return buffer;
}

// Standard base64 (optionally padded) or unpadded base64url; Node decodes both alphabets.
const ENCRYPTION_KEY_TEXT = /^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+)$/;

/**
 * Computes the key identifier: first 16 hex characters of SHA-256 over the raw 32-byte key.
 */
function computeKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Encodes a Buffer to base64url without padding.
 */
function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Decodes a base64url string to Buffer. Throws on invalid characters.
 * Empty string is valid (decodes to empty buffer).
 */
function fromBase64Url(str: string): Buffer {
  if (str.length === 0) {
    return Buffer.alloc(0);
  }
  // Validate base64url characters only (A-Z, a-z, 0-9, -, _)
  if (!/^[A-Za-z0-9\-_]+$/.test(str)) {
    throw new Error("invalid base64url character");
  }
  // Add padding back if needed
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

/**
 * Authenticated encryption for stored credentials (upstream service account keys, API keys).
 * Uses AES-256-GCM with a fresh 12-byte IV per encryption.
 * Payload format: v1.<keyId>.<iv>.<ciphertext>.<tag> (dot-separated base64url segments).
 */
export class CredentialCipher {
  private readonly key: Buffer;
  private readonly keyId: string;

  /**
   * @param key - Exactly 32 bytes (AES-256 key). Throws EncryptionKeyError otherwise.
   */
  constructor(key: Buffer) {
    if (!(key instanceof Buffer) || key.length !== 32) {
      throw new EncryptionKeyError(
        "Encryption key must be 32 bytes encoded as base64, e.g. from `openssl rand -base64 32`",
      );
    }
    this.key = key;
    this.keyId = computeKeyId(key);
  }

  /**
   * Encrypts plaintext with AES-256-GCM.
   * @param plaintext - The data to encrypt (can be empty string).
   * @param associatedData - Required, non-empty. Bound as GCM AAD (UTF-8).
   * @returns Payload string: v1.<keyId>.<iv>.<ciphertext>.<tag>
   */
  encrypt(plaintext: string, associatedData: string): string {
    if (!associatedData) {
      throw new Error("associatedData is required and must be non-empty");
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const segments = [
      "v1",
      this.keyId,
      toBase64Url(iv),
      toBase64Url(ciphertext),
      toBase64Url(tag),
    ];

    return segments.join(".");
  }

  /**
   * Decrypts a payload produced by encrypt().
   * @param payload - The encrypted payload string.
   * @param associatedData - Must match the value used during encryption.
   * @returns The decrypted plaintext.
   * @throws CredentialDecryptionError for malformed payload, wrong key, or auth failure.
   */
  decrypt(payload: string, associatedData: string): string {
    if (!associatedData) {
      throw new Error("associatedData is required and must be non-empty");
    }

    const segments = payload.split(".");
    if (segments.length !== 5) {
      throw new CredentialDecryptionError("malformed payload");
    }

    const [version, keyId, ivB64, ciphertextB64, tagB64] = segments;

    if (version !== "v1") {
      throw new CredentialDecryptionError("malformed payload");
    }

    if (keyId !== this.keyId) {
      throw new CredentialDecryptionError("encrypted with a different key");
    }

    let iv: Buffer;
    let ciphertext: Buffer;
    let tag: Buffer;

    try {
      iv = fromBase64Url(ivB64);
      ciphertext = fromBase64Url(ciphertextB64);
      tag = fromBase64Url(tagB64);
    } catch {
      throw new CredentialDecryptionError("malformed payload");
    }

    if (iv.length !== 12) {
      throw new CredentialDecryptionError("malformed payload");
    }

    if (tag.length !== 16) {
      throw new CredentialDecryptionError("malformed payload");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new CredentialDecryptionError("authentication failed");
    }

    return plaintext.toString("utf8");
  }
}