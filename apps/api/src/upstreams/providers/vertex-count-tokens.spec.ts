import { describe, expect, it } from "vitest";

import { UpstreamError, UpstreamInputError } from "./upstream-errors.js";
import {
  fromVertexCountTokensResponse,
  toVertexCountTokensRequest,
} from "./vertex-count-tokens.js";

const INPUT_MESSAGE = "Count tokens input must include contents or generateContentRequest.";

describe("toVertexCountTokensRequest", () => {
  it("passes a flat contents request through", () => {
    const request = {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { temperature: 0 },
    };

    expect(toVertexCountTokensRequest(request)).toEqual(request);
    expect(toVertexCountTokensRequest(request)).not.toBe(request);
  });

  it("unwraps generateContentRequest and drops the inner model", () => {
    const request = {
      generateContentRequest: {
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "sys" }] },
        tools: [{ functionDeclarations: [{ name: "ping" }] }],
        generationConfig: { temperature: 0.2 },
      },
    };

    expect(toVertexCountTokensRequest(request)).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      tools: [{ functionDeclarations: [{ name: "ping" }] }],
      generationConfig: { temperature: 0.2 },
    });
    expect(request.generateContentRequest.model).toBe("gemini-2.0-flash");
  });

  it("prefers generateContentRequest when both forms are present", () => {
    expect(
      toVertexCountTokensRequest({
        contents: [{ role: "user", parts: [{ text: "outer" }] }],
        generateContentRequest: {
          model: "gemini-2.0-flash",
          contents: [{ role: "user", parts: [{ text: "inner" }] }],
        },
      }),
    ).toEqual({
      contents: [{ role: "user", parts: [{ text: "inner" }] }],
    });
  });

  it.each([
    ["an empty object", {}],
    ["a non-object generateContentRequest", { generateContentRequest: "nope" }],
    ["a null generateContentRequest and no contents", { generateContentRequest: null }],
  ])("rejects %s", (_name, request) => {
    expect(() => toVertexCountTokensRequest(request)).toThrow(UpstreamInputError);
    expect(() => toVertexCountTokensRequest(request)).toThrow(INPUT_MESSAGE);
  });
});

describe("fromVertexCountTokensResponse", () => {
  it("keeps the Gemini fields and drops totalBillableCharacters", () => {
    expect(
      fromVertexCountTokensResponse({
        totalTokens: 12,
        totalBillableCharacters: 40,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
        cachedContentTokenCount: 0,
        extra: true,
      }),
    ).toEqual({
      totalTokens: 12,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
      cachedContentTokenCount: 0,
    });
  });

  it("returns only totalTokens when the optional fields are absent", () => {
    expect(fromVertexCountTokensResponse({ totalTokens: 1, totalBillableCharacters: 4 })).toEqual({
      totalTokens: 1,
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing total", {}],
    ["a string total", { totalTokens: "1" }],
    ["a non-finite total", { totalTokens: Number.NaN }],
    ["prompt details that are not an array", { totalTokens: 1, promptTokensDetails: { modality: "TEXT" } }],
    ["a non-numeric cached count", { totalTokens: 1, cachedContentTokenCount: "0" }],
  ])("rejects %s", (_name, body) => {
    expect(() => fromVertexCountTokensResponse(body)).toThrow(UpstreamError);
    try {
      fromVertexCountTokensResponse(body);
    } catch (error) {
      expect(error).toMatchObject({ kind: "upstream_error", httpStatus: null });
    }
  });
});
