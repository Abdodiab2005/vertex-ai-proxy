import { randomBytes } from "node:crypto";
import {
  parseEncryptionKey,
  EncryptionKeyError,
  CredentialCipher,
  CredentialDecryptionError,
} from "./credential-cipher";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

describe("parseEncryptionKey", () => {
  const validKey32 = randomBytes(32);
  const validKey16 = randomBytes(16);
  const validKey31 = randomBytes(31);
  const validKey33 = randomBytes(33);

  const toBase64 = (buf: Buffer) => buf.toString("base64");
  const toBase64Url = (buf: Buffer) =>
    buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  it.each([
    ["base64", toBase64(validKey32)],
    ["base64url", toBase64Url(validKey32)],
    ["base64 with whitespace", `  \n${toBase64(validKey32)}\t `],
    ["base64url with whitespace", `  \n${toBase64Url(validKey32)}\t `],
  ])("accepts %s encoding of 32 random bytes", (_label, encoded) => {
    const key = parseEncryptionKey(encoded);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it.each([
    ["16-byte key", toBase64(validKey16)],
    ["31-byte key", toBase64(validKey31)],
    ["33-byte key", toBase64(validKey33)],
    ["non-base64 text", "not-base64!@#"],
    ["a 32-byte key with a stray character", `${toBase64Url(validKey32)}!`],
    ["empty string", ""],
    ["whitespace only", "   \n\t  "],
  ])("rejects %s", (_label, encoded) => {
    expect(() => parseEncryptionKey(encoded)).toThrow(EncryptionKeyError);
    try {
      parseEncryptionKey(encoded);
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionKeyError);
      const message = (err as Error).message;
      if (encoded) {
        expect(message).not.toContain(encoded);
      }
      expect(message).toContain("32 bytes");
      expect(message).toContain("base64");
    }
  });
});

describe("CredentialCipher", () => {
  const key = randomBytes(32);
  const otherKey = randomBytes(32);
  const cipher = new CredentialCipher(key);
  const otherCipher = new CredentialCipher(otherKey);
  const associatedData = "upstream:test-uuid-123";

  const testCases = [
    ["ASCII", "hello world"],
    ["unicode", "🔐🔑🌍 café naïve résumé"],
    ["multi-line JSON", JSON.stringify({ foo: "bar", nested: { arr: [1, 2, 3] } }, null, 2)],
    ["empty string", ""],
  ];

  it.each(testCases)("round-trips %s", (_label, plaintext) => {
    const payload = cipher.encrypt(plaintext, associatedData);
    const decrypted = cipher.decrypt(payload, associatedData);
    expect(decrypted).toBe(plaintext);
  });

  it("two encryptions of the same plaintext give different payloads (fresh IV)", () => {
    const plaintext = "same plaintext";
    const payload1 = cipher.encrypt(plaintext, associatedData);
    const payload2 = cipher.encrypt(plaintext, associatedData);
    expect(payload1).not.toBe(payload2);
    // But both decrypt correctly
    expect(cipher.decrypt(payload1, associatedData)).toBe(plaintext);
    expect(cipher.decrypt(payload2, associatedData)).toBe(plaintext);
  });

  it("constructor rejects a 31-byte key", () => {
    expect(() => new CredentialCipher(randomBytes(31))).toThrow(EncryptionKeyError);
  });

  describe("tampering and wrong associatedData", () => {
    const plaintext = "secret data";
    const payload = cipher.encrypt(plaintext, associatedData);

    function tamperSegment(segmentIndex: number): string {
      const parts = payload.split(".");
      const original = parts[segmentIndex];
      // Decode, flip a bit in the raw bytes, re-encode. This guarantees the
      // decoded value changes and GCM auth will fail.
      const decoded = fromBase64Url(original);
      const tampered = Buffer.from(decoded);
      tampered[0] ^= 0xff; // flip all bits of first byte
      parts[segmentIndex] = toBase64Url(tampered);
      return parts.join(".");
    }

    it.each([
      [2, "iv"],
      [3, "ciphertext"],
      [4, "tag"],
    ])("tampering with %s -> authentication failed", (index) => {
      const tampered = tamperSegment(index);
      expect(() => cipher.decrypt(tampered, associatedData)).toThrow(
        CredentialDecryptionError,
      );
      try {
        cipher.decrypt(tampered, associatedData);
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialDecryptionError);
        expect((err as Error).message).toBe("authentication failed");
      }
    });

    it("wrong associatedData -> authentication failed", () => {
      expect(() => cipher.decrypt(payload, "different:associated:data")).toThrow(
        CredentialDecryptionError,
      );
      try {
        cipher.decrypt(payload, "different:associated:data");
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialDecryptionError);
        expect((err as Error).message).toBe("authentication failed");
      }
    });
  });

  it("a payload made by a cipher with a different key -> encrypted with a different key", () => {
    const plaintext = "secret data";
    const payload = otherCipher.encrypt(plaintext, associatedData);
    expect(() => cipher.decrypt(payload, associatedData)).toThrow(CredentialDecryptionError);
    try {
      cipher.decrypt(payload, associatedData);
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialDecryptionError);
      expect((err as Error).message).toBe("encrypted with a different key");
    }
  });

  describe("malformed payloads", () => {
    const plaintext = "secret data";
    const validPayload = cipher.encrypt(plaintext, associatedData);
    const parts = validPayload.split(".");

    function makePayload(override: Record<number, string>): string {
      const copy = [...parts];
      for (const [i, val] of Object.entries(override)) {
        copy[Number(i)] = val;
      }
      return copy.join(".");
    }

    it.each([
      ["wrong segment count (4)", parts.slice(0, 4).join(".")],
      ["wrong segment count (6)", "v1.keyid.iv.ct.tag.extra"],
      ['version "v2"', makePayload({ 0: "v2" })],
      ["non-base64url segment (iv)", makePayload({ 2: "not_base64url!" })],
      ["non-base64url segment (ciphertext)", makePayload({ 3: "not_base64url!" })],
      ["non-base64url segment (tag)", makePayload({ 4: "not_base64url!" })],
      ["8-byte IV", makePayload({ 2: "AAAAAAAAAAA" })], // 8 bytes, unpadded base64url
    ])("%s -> malformed payload", (_label, malformed) => {
      expect(() => cipher.decrypt(malformed, associatedData)).toThrow(CredentialDecryptionError);
      try {
        cipher.decrypt(malformed, associatedData);
      } catch (err) {
        expect(err).toBeInstanceOf(CredentialDecryptionError);
        expect((err as Error).message).toBe("malformed payload");
      }
    });
  });
});