import { describe, it, expect } from "vitest";
import { redactSecrets, encodeCursor, decodeCursor } from "./redactor.js";

describe("redactSecrets", () => {
  it("redacts password keys", () => {
    const input = { password: "secret123", other: "value" };
    const result = redactSecrets(input);
    expect(result).toEqual({ password: "[redacted]", other: "value" });
  });

  it("redacts passWord (case variant)", () => {
    const input = { passWord: "secret123" };
    const result = redactSecrets(input);
    expect(result).toEqual({ passWord: "[redacted]" });
  });

  it("redacts api_key", () => {
    const input = { api_key: "sk-123", name: "test" };
    const result = redactSecrets(input);
    expect(result).toEqual({ api_key: "[redacted]", name: "test" });
  });

  it("redacts apikey (no underscore)", () => {
    const input = { apikey: "sk-123" };
    const result = redactSecrets(input);
    expect(result).toEqual({ apikey: "[redacted]" });
  });

  it("redacts private_key", () => {
    const input = { private_key: "-----BEGIN PRIVATE KEY-----..." };
    const result = redactSecrets(input);
    expect(result).toEqual({ private_key: "[redacted]" });
  });

  it("redacts privatekey (no underscore)", () => {
    const input = { privatekey: "secret" };
    const result = redactSecrets(input);
    expect(result).toEqual({ privatekey: "[redacted]" });
  });

  it("redacts token", () => {
    const input = { token: "abc123", data: "keep" };
    const result = redactSecrets(input);
    expect(result).toEqual({ token: "[redacted]", data: "keep" });
  });

  it("redacts secret", () => {
    const input = { secret: "hidden", visible: "shown" };
    const result = redactSecrets(input);
    expect(result).toEqual({ secret: "[redacted]", visible: "shown" });
  });

  it("redacts credential", () => {
    const input = { credential: "cred123" };
    const result = redactSecrets(input);
    expect(result).toEqual({ credential: "[redacted]" });
  });

  it("redacts hash", () => {
    const input = { hash: "abc123" };
    const result = redactSecrets(input);
    expect(result).toEqual({ hash: "[redacted]" });
  });

  it("redacts nested object keys", () => {
    const input = { config: { api_key: "sk-123", timeout: 30 } };
    const result = redactSecrets(input);
    expect(result).toEqual({ config: { api_key: "[redacted]", timeout: 30 } });
  });

  it("redacts keys in arrays of objects", () => {
    const input = { items: [{ password: "p1" }, { token: "t2", name: "keep" }] };
    const result = redactSecrets(input);
    expect(result).toEqual({
      items: [{ password: "[redacted]" }, { token: "[redacted]", name: "keep" }],
    });
  });

  it("does not mutate the original input", () => {
    const input = { password: "secret123", nested: { token: "abc" } };
    const originalPassword = input.password;
    const originalNestedToken = input.nested.token;
    redactSecrets(input);
    expect(input.password).toBe(originalPassword);
    expect(input.nested.token).toBe(originalNestedToken);
  });

  it("leaves non-matching keys untouched", () => {
    const input = { name: "test", email: "a@b.com", count: 42, enabled: true };
    const result = redactSecrets(input);
    expect(result).toEqual(input);
  });

  it("handles null input", () => {
    const result = redactSecrets(null);
    expect(result).toBeNull();
  });

  it("handles undefined-like values (passed as null)", () => {
    const result = redactSecrets({ a: null, b: "value" });
    expect(result).toEqual({ a: null, b: "value" });
  });

  it("handles arrays with primitives", () => {
    const input = { tags: ["a", "b", "c"] };
    const result = redactSecrets(input);
    expect(result).toEqual({ tags: ["a", "b", "c"] });
  });

  it("handles deeply nested structures", () => {
    const input = {
      level1: {
        level2: {
          secret: "deep",
          level3: [{ private_key: "very_deep" }],
        },
      },
    };
    const result = redactSecrets(input);
    expect(result).toEqual({
      level1: {
        level2: {
          secret: "[redacted]",
          level3: [{ private_key: "[redacted]" }],
        },
      },
    });
  });
});

describe("encodeCursor / decodeCursor", () => {
  const testCases = [
    { createdAt: new Date("2024-01-15T10:30:00.000Z"), id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    { createdAt: new Date("2024-12-31T23:59:59.999Z"), id: "00000000-0000-0000-0000-000000000001" },
    { createdAt: new Date("2020-06-15T00:00:00.000Z"), id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
  ];

  for (const tc of testCases) {
    it(`round-trips cursor for ${tc.createdAt.toISOString()}`, () => {
      const cursor = encodeCursor(tc.createdAt, tc.id);
      const decoded = decodeCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded!.createdAt.toISOString()).toBe(tc.createdAt.toISOString());
      expect(decoded!.id).toBe(tc.id);
    });
  }

  it("returns null for invalid base64", () => {
    expect(decodeCursor("not-valid-base64!")).toBeNull();
  });

  it("returns null for malformed payload (no pipe)", () => {
    const bad = Buffer.from("no-pipe-here", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for invalid date", () => {
    const bad = Buffer.from("not-a-date|a1b2c3d4-e5f6-7890-abcd-ef1234567890", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for invalid UUID", () => {
    const bad = Buffer.from("2024-01-15T10:30:00.000Z|not-a-uuid", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });
});