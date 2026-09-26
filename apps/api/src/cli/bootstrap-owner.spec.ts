import { describe, it, expect } from "vitest";
import { validateBootstrapOwnerInput, InvalidOwnerInputError } from "./bootstrap-owner.js";

describe("validateBootstrapOwnerInput", () => {
  it("normalizes email (trims and lowercases)", () => {
    const result = validateBootstrapOwnerInput({
      email: "  ADMIN@Example.COM  ",
      password: "ValidPassw0rd!",
    });
    expect(result.email).toBe("admin@example.com");
  });

  it("rejects invalid email format", () => {
    expect(() => validateBootstrapOwnerInput({ email: "not-an-email", password: "ValidPassw0rd!" })).toThrow(
      InvalidOwnerInputError,
    );
  });

  it("rejects email exceeding 254 characters", () => {
    const longEmail = "a".repeat(250) + "@example.com";
    expect(() => validateBootstrapOwnerInput({ email: longEmail, password: "ValidPassw0rd!" })).toThrow(
      InvalidOwnerInputError,
    );
  });

  it("rejects password shorter than 12 characters", () => {
    expect(() => validateBootstrapOwnerInput({ email: "admin@example.com", password: "Short1!" })).toThrow(
      InvalidOwnerInputError,
    );
  });

  it("rejects password longer than 256 characters", () => {
    const longPassword = "a".repeat(257);
    expect(() => validateBootstrapOwnerInput({ email: "admin@example.com", password: longPassword })).toThrow(
      InvalidOwnerInputError,
    );
  });

  it("accepts password at exactly 12 characters", () => {
    const password = "a".repeat(12);
    const result = validateBootstrapOwnerInput({ email: "admin@example.com", password });
    expect(result.password).toBe(password);
  });

  it("accepts password at exactly 256 characters", () => {
    const password = "a".repeat(256);
    const result = validateBootstrapOwnerInput({
      email: "admin@example.com",
      password,
    });
    expect(result.password).toBe(password);
  });

  it("error message does not contain the submitted password", () => {
    const testCases = [
      { email: "admin@example.com", password: "short" },
      { email: "admin@example.com", password: "a".repeat(257) },
      { email: "invalid", password: "SecretPassw0rd!" },
    ];

    for (const input of testCases) {
      try {
        validateBootstrapOwnerInput(input);
        throw new Error("Expected to throw");
      } catch (error) {
        if (error instanceof InvalidOwnerInputError) {
          expect(error.message).not.toContain(input.password);
        } else {
          throw error;
        }
      }
    }
  });

  it("error message includes field path and message", () => {
    try {
      validateBootstrapOwnerInput({ email: "bad", password: "short" });
      throw new Error("Expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidOwnerInputError);
      expect((error as InvalidOwnerInputError).message).toContain("email:");
      expect((error as InvalidOwnerInputError).message).toContain("password:");
    }
  });
});
