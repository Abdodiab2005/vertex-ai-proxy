import { describe, expect, it } from "vitest";

import { GEMINI_ACTIONS, parseModelAction, type GeminiAction } from "./model-path.js";

describe("parseModelAction", () => {
  it.each(
    GEMINI_ACTIONS.map((action) => ({
      action,
      segment: `gemini-2.5.flash-preview:${action}`,
    })),
  )("parses the $action action", ({ action, segment }) => {
    expect(parseModelAction(segment)).toEqual({
      model: "gemini-2.5.flash-preview",
      action: action as GeminiAction,
    });
  });

  it.each([
    ["a segment without an action separator", "gemini-2.5-flash"],
    ["an unknown action", "gemini-2.5-flash:deleteContent"],
    ["an invalid leading model character", "_gemini:generateContent"],
    ["a model with a slash", "gemini/model:generateContent"],
    ["a model with an extra colon", "a:b:generateContent"],
  ] as const)("returns null for %s", (_name, segment) => {
    expect(parseModelAction(segment)).toBeNull();
  });
});
