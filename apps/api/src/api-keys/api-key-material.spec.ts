import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, looksLikeApiKey } from "./api-key-material.js";

describe("api-key-material", () => {
  describe("generateApiKey", () => {
    it("generates a key with the correct length and prefix", () => {
      const key = generateApiKey();
      expect(key.startsWith("lvg_")).toBe(true);
      expect(key.length).toBe(4 + 32);
    });

    it("generates unique keys", () => {
      const keys = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        keys.add(generateApiKey());
      }
      expect(keys.size).toBe(1000);
    });

    it("only uses characters from the base62 alphabet", () => {
      const key = generateApiKey();
      const payload = key.slice(4);
      expect(payload).toMatch(/^[A-Za-z0-9]{32}$/);
    });
  });

  describe("hashApiKey", () => {
    it("is deterministic", () => {
      const hash1 = hashApiKey("test_key");
      const hash2 = hashApiKey("test_key");
      expect(hash1).toBe(hash2);
    });

    it("produces a valid sha256 hex string", () => {
      const hash = hashApiKey("test_key");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("looksLikeApiKey", () => {
    it("returns true for a valid generated key", () => {
      expect(looksLikeApiKey(generateApiKey())).toBe(true);
    });

    it("returns false for wrong prefix", () => {
      const key = generateApiKey().replace("lvg_", "foo_");
      expect(looksLikeApiKey(key)).toBe(false);
    });

    it("returns false for wrong length", () => {
      const key = generateApiKey() + "a";
      expect(looksLikeApiKey(key)).toBe(false);
    });

    it("returns false for invalid characters", () => {
      const key = generateApiKey();
      const invalid = key.slice(0, -1) + "!";
      expect(looksLikeApiKey(invalid)).toBe(false);
    });
  });
});
