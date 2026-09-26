import { canonicalRequestedModelName, isModelName } from "./model-name.js";

const validNames = [
  "a",
  "Z",
  "0",
  "gemini-2.5-flash",
  "gemini_2.5",
  "gemini.pro",
  "A._-0",
  `a${"b".repeat(127)}`,
];

const invalidNames = [
  "",
  "-gemini",
  ".gemini",
  "_gemini",
  "gemini/flash",
  "gemini flash",
  "gemini\n",
  " models",
  "gemini ",
  "ü",
  "models/gemini-2.5-flash",
  `a${"b".repeat(128)}`,
];

describe("model names", () => {
  it.each(validNames)("accepts %j", (name) => {
    expect(isModelName(name)).toBe(true);
  });

  it.each(invalidNames)("rejects %j", (name) => {
    expect(isModelName(name)).toBe(false);
  });

  it.each([
    ["gemini-2.5-flash", "gemini-2.5-flash"],
    ["models/gemini-2.5-flash", "gemini-2.5-flash"],
    ["models/models/gemini-2.5-flash", "models/gemini-2.5-flash"],
    ["models/", ""],
    ["Models/gemini-2.5-flash", "Models/gemini-2.5-flash"],
  ])("canonicalizes %j to %j", (requested, canonical) => {
    expect(canonicalRequestedModelName(requested)).toBe(canonical);
  });
});
