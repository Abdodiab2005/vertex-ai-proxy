import { describe, it, expect } from "vitest";
import { parseCreateOwnerArgs, firstLine, UsageError } from "./create-owner-input.js";

describe("parseCreateOwnerArgs", () => {
  it.each([
    ["valid email", ["--email", "test@example.com"], { help: false, email: "test@example.com" }],
    ["valid email short flag", ["-e", "test@example.com"], { help: false, email: "test@example.com" }],
    ["help flag", ["--help"], { help: true }],
    ["help short flag", ["-h"], { help: true }],
  ])("%s", (_name, argv, expected) => {
    expect(parseCreateOwnerArgs(argv)).toEqual(expected);
  });

  it.each([
    ["missing email", [], "--email is required"],
    ["unknown flag", ["--unknown"], "Unknown option"],
    ["positional arg", ["test@example.com"], "Unknown positional argument"],
  ])("throws UsageError for %s", (_name, argv, expectedMessage) => {
    expect(() => parseCreateOwnerArgs(argv)).toThrow(UsageError);
    expect(() => parseCreateOwnerArgs(argv)).toThrow(expectedMessage);
  });
});

describe("firstLine", () => {
  it.each([
    ["with LF", "pw\n", "pw"],
    ["with CRLF", "pw\r\n", "pw"],
    ["without newline", "pw", "pw"],
    ["empty string", "", ""],
    ["multiple lines", "a\nb\n", "a"],
    ["only newline", "\n", ""],
    ["CRLF only", "\r\n", ""],
  ])("%s", (_name, input, expected) => {
    expect(firstLine(input)).toBe(expected);
  });
});