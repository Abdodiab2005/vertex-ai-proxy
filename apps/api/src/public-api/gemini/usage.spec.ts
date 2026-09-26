import { describe, expect, it } from "vitest";

import { usageQuantitiesFromMetadata } from "./usage.js";

describe("usageQuantitiesFromMetadata", () => {
  it.each([
    {
      name: "maps text-only usage",
      metadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 8,
        totalTokenCount: 20,
      },
      expected: {
        quantities: { input_tokens: 12, output_tokens: 8 },
        complete: true,
      },
    },
    {
      name: "separates cached input from the prompt total",
      metadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 6,
      },
      expected: {
        quantities: { cached_input_tokens: 6, input_tokens: 14, output_tokens: 4 },
        complete: true,
      },
    },
    {
      name: "maps thoughts to reasoning usage",
      metadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
      },
      expected: {
        quantities: { reasoning_tokens: 3, input_tokens: 10, output_tokens: 5 },
        complete: true,
      },
    },
    {
      name: "includes tool-use prompt tokens in input usage",
      metadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        toolUsePromptTokenCount: 4,
      },
      expected: {
        quantities: { input_tokens: 14, output_tokens: 5 },
        complete: true,
      },
    },
    {
      name: "carves audio out of input and output totals",
      metadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 16,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 20 },
          { modality: "AUDIO", tokenCount: 10 },
        ],
        candidatesTokensDetails: [
          { modality: "TEXT", tokenCount: 12 },
          { modality: "AUDIO", tokenCount: 4 },
        ],
      },
      expected: {
        quantities: {
          audio_input_tokens: 10,
          audio_output_tokens: 4,
          input_tokens: 20,
          output_tokens: 12,
        },
        complete: true,
      },
    },
    {
      // As Vertex reported a Nano Banana 2 Lite image (checked live): the image sits inside
      // candidatesTokenCount and is split out by the IMAGE detail.
      name: "carves generated images out of output, leaving input images in input",
      metadata: {
        promptTokenCount: 1129,
        candidatesTokenCount: 1130,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 9 },
          { modality: "IMAGE", tokenCount: 1120 },
        ],
        candidatesTokensDetails: [
          { modality: "TEXT", tokenCount: 10 },
          { modality: "IMAGE", tokenCount: 1120 },
        ],
      },
      expected: {
        quantities: {
          image_output_tokens: 1120,
          input_tokens: 1129,
          output_tokens: 10,
        },
        complete: true,
      },
    },
    {
      name: "marks absent usage as incomplete",
      metadata: undefined,
      expected: { quantities: {}, complete: false },
    },
    {
      name: "treats an omitted candidates count as zero output (proto3 omits zeros)",
      metadata: { promptTokenCount: 10 },
      expected: { quantities: { input_tokens: 10 }, complete: true },
    },
    {
      name: "treats a missing prompt count as zero while retaining tool usage",
      metadata: { candidatesTokenCount: 5, toolUsePromptTokenCount: 3 },
      expected: { quantities: { input_tokens: 3, output_tokens: 5 }, complete: false },
    },
    {
      name: "marks cached usage larger than the prompt as inconsistent",
      metadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        cachedContentTokenCount: 11,
      },
      expected: {
        quantities: { cached_input_tokens: 11, output_tokens: 5 },
        complete: false,
      },
    },
    {
      name: "rejects non-integer counts while retaining independent valid usage",
      metadata: { promptTokenCount: 10.5, candidatesTokenCount: 5 },
      expected: { quantities: { output_tokens: 5 }, complete: false },
    },
  ])("$name", ({ metadata, expected }) => {
    expect(usageQuantitiesFromMetadata(metadata)).toEqual(expected);
  });
});
