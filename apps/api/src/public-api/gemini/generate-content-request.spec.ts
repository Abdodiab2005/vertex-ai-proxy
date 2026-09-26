import { describe, expect, it } from "vitest";

import {
  checkGenerateContentRequest,
  readMaxOutputTokens,
  requestsImageOutput,
  withReservedOutputCap,
} from "./generate-content-request.js";
import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";

function validRequest(overrides: JsonObject = {}): JsonObject {
  return {
    contents: [{ role: "user", parts: [{ text: "A prompt that must never appear in an error." }] }],
    ...overrides,
  };
}

function checkedRequest(body: unknown): JsonObject {
  const result = checkGenerateContentRequest(body);
  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.request;
}

describe("checkGenerateContentRequest", () => {
  it("accepts a minimal request without changing it", () => {
    const request = validRequest();
    const returnedRequest = checkedRequest(request);

    expect(returnedRequest).toEqual(request);
    expect(returnedRequest).toBe(request);
  });

  it.each([null, [], "not an object", 42])("rejects a non-object body", (body) => {
    const result = checkGenerateContentRequest(body);

    expect(result).toMatchObject({ ok: false, message: "Request body must be a JSON object." });
  });

  it.each([
    ["missing contents", {}],
    ["empty contents", { contents: [] }],
    ["non-array contents", { contents: "not an array" }],
  ])("rejects %s", (_description, body) => {
    const result = checkGenerateContentRequest(body);

    expect(result).toMatchObject({ ok: false, message: "contents must be a non-empty array." });
  });

  it.each([
    ["a content without parts", { contents: [{}] }],
    ["a content whose parts are not an array", { contents: [{ parts: "not an array" }] }],
    ["a non-object content", { contents: [null] }],
  ])("rejects %s", (_description, body) => {
    const result = checkGenerateContentRequest(body);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.message).toContain("parts array");
      expect(result.message).not.toContain("A prompt that must never appear in an error.");
    }
  });

  it("rejects cachedContent with an explicit Vertex compatibility message", () => {
    const result = checkGenerateContentRequest(
      validRequest({ cachedContent: "cachedContents/example" }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "cachedContent is not supported by this gateway. Gemini API cache names do not exist on Vertex.",
    });
  });

  it.each([0, -1, 1.5, "100", null])(
    "rejects an invalid maxOutputTokens value %j",
    (maxOutputTokens) => {
      const result = checkGenerateContentRequest(
        validRequest({ generationConfig: { maxOutputTokens } }),
      );

      expect(result).toEqual({
        ok: false,
        message: "generationConfig.maxOutputTokens must be a positive integer.",
      });
    },
  );

  it("passes through unknown top-level fields and nested generation settings", () => {
    const request = validRequest({
      futureGeminiField: { preserve: ["all", "of", "this"] },
      generationConfig: { maxOutputTokens: 256, temperature: 0.75 },
    });
    const returnedRequest = checkedRequest(request);

    expect(returnedRequest).toEqual(request);
  });
});

describe("readMaxOutputTokens", () => {
  it.each([
    [validRequest({ generationConfig: { maxOutputTokens: 256 } }), 256],
    [validRequest(), null],
    [validRequest({ generationConfig: { maxOutputTokens: "256" } }), null],
  ])("reads %j as %j", (request, expected) => {
    expect(readMaxOutputTokens(request)).toBe(expected);
  });
});

describe("requestsImageOutput", () => {
  it.each([
    [{ generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }, true],
    [{ generationConfig: { responseModalities: ["image"] } }, true],
    [{ generationConfig: { responseModalities: ["TEXT"] } }, false],
    [{ generationConfig: { temperature: 1 } }, false],
    [{}, false],
  ])("detects an image request in %j", (overrides, expected) => {
    expect(requestsImageOutput(validRequest(overrides))).toBe(expected);
  });
});

describe("withReservedOutputCap", () => {
  it("sets maxOutputTokens to the reserved cap without mutating the client body", () => {
    const body = validRequest({ generationConfig: { temperature: 0.5 } });
    const original = structuredClone(body);

    const sent = withReservedOutputCap(body, 8192);

    expect(sent).toEqual({
      ...original,
      generationConfig: { temperature: 0.5, maxOutputTokens: 8192 },
    });
    expect(sent).not.toBe(body);
    expect(body).toEqual(original);
    if (isRecord(sent.generationConfig)) {
      sent.generationConfig.maxOutputTokens = 1;
    }
    expect(body).toEqual(original);
  });

  it("adds generationConfig when the request has none", () => {
    const body = validRequest();
    const sent = withReservedOutputCap(body, 4096);

    expect(sent.generationConfig).toEqual({ maxOutputTokens: 4096 });
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("keeps a client maxOutputTokens within the hold, and the same object", () => {
    const body = validRequest({ generationConfig: { maxOutputTokens: 100, temperature: 0.2 } });

    expect(withReservedOutputCap(body, 8192)).toBe(body);
  });

  it("lowers a client maxOutputTokens above the hold to the reserved amount", () => {
    const body = validRequest({ generationConfig: { maxOutputTokens: 65536, temperature: 0.2 } });

    const sent = withReservedOutputCap(body, 8192);

    expect(sent.generationConfig).toEqual({ maxOutputTokens: 8192, temperature: 0.2 });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 65536, temperature: 0.2 });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
