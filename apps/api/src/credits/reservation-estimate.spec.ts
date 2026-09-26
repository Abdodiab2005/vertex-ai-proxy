import { describe, expect, it } from "vitest";
import { PricingConfigurationError, type PricingRuleInput } from "../pricing/pricing-engine.js";
import type { JsonObject } from "../upstreams/providers/upstream-provider.js";
import {
  INLINE_MEDIA_BYTES_PER_TOKEN,
  estimateInputTokens,
  estimateOutputTokens,
  estimateReservationMicros, estimateInputOnlyReservationMicros,
  type ReservationPolicy,
} from "./reservation-estimate.js";

const policy: ReservationPolicy = {
  charsPerToken: 3,
  tokensPerMediaPart: 1_000,
  defaultMaxOutputTokens: 8_192,
  fileUriHoldTokens: 1_000,
};

const at = new Date("2025-01-01T00:00:00.000Z");

function rule(overrides: Partial<PricingRuleInput> = {}): PricingRuleInput {
  return {
    id: "rule",
    billingDimension: "input_tokens",
    unitSize: "1000000",
    price: "0.30",
    currency: "USD",
    effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
    effectiveTo: null,
    ...overrides,
  };
}

describe("estimateInputTokens", () => {
  const inputCases: Array<{
    name: string;
    request: JsonObject;
    policy: ReservationPolicy;
    expected: number;
  }> = [
    {
      name: "rounds plain text upward",
      request: { contents: [{ parts: [{ text: "abcdefg" }] }] },
      policy,
      expected: 3,
    },
    {
      name: "counts emoji as code points rather than UTF-16 units",
      request: { contents: [{ parts: [{ text: "😀😀a" }] }] },
      policy,
      expected: 1,
    },
    {
      name: "includes a system instruction",
      request: {
        contents: [{ parts: [{ text: "abc" }] }],
        systemInstruction: { parts: [{ text: "abcd" }] },
      },
      policy,
      expected: 3,
    },
    {
      name: "uses the media allowance for media and unknown parts",
      request: {
        contents: [
          {
            parts: [{ inlineData: {} }, { fileData: {} }, { functionCall: {} }],
          },
        ],
      },
      policy,
      expected: 3_000,
    },
    {
      name: "includes serialized function declarations",
      request: {
        tools: [{ functionDeclarations: [{ name: "f" }] }],
      },
      policy,
      expected: 4,
    },
  ];

  it.each(inputCases)("$name", ({ request, policy: casePolicy, expected }) => {
    expect(estimateInputTokens(request, casePolicy)).toBe(expected);
  });

  it("counts an embed content object only after it is wrapped as contents", () => {
    const raw = { content: { parts: [{ text: "abcdef" }] } };
    expect(estimateInputTokens(raw, policy)).toBe(0);
    expect(estimateInputTokens({ contents: [{ parts: [{ text: "abcdef" }] }] }, policy)).toBe(2);
  });

  it("sizes inline media from decoded bytes and keeps the flat floor", () => {
    expect(INLINE_MEDIA_BYTES_PER_TOKEN).toEqual({
      audio: 500,
      video: 200,
      document: 200,
      image: 1000,
    });

    const audioFloor = Buffer.alloc(499_500).toString("base64");
    const audioOver = Buffer.alloc(500_500).toString("base64");
    const videoOver = Buffer.alloc(200_200).toString("base64");
    const documentOver = Buffer.alloc(200_200).toString("base64");
    const imageOver = Buffer.alloc(1_001_000).toString("base64");

    expect(estimateInputTokens({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: audioFloor } }] }] }, policy)).toBe(1_000);
    expect(estimateInputTokens({ contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: audioOver } }] }] }, policy)).toBe(1_001);
    expect(estimateInputTokens({ contents: [{ parts: [{ inlineData: { mimeType: "video/mp4", data: videoOver } }] }] }, policy)).toBe(1_001);
    expect(estimateInputTokens({ contents: [{ parts: [{ inlineData: { mimeType: "application/pdf", data: documentOver } }] }] }, policy)).toBe(1_001);
    expect(estimateInputTokens({ contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: imageOver } }] }] }, policy)).toBe(1_001);
  });

  it("holds each fileData part at fileUriHoldTokens", () => {
    const filePolicy: ReservationPolicy = { ...policy, fileUriHoldTokens: 50_000 };
    const request = {
      contents: [{ parts: [{ fileData: { fileUri: "gs://bucket/a" } }, { fileData: { fileUri: "gs://bucket/b" } }] }],
    };
    expect(estimateInputTokens(request, filePolicy)).toBe(100_000);
  });

  it("handles malformed request shapes without throwing", () => {
    const circularDeclaration: JsonObject = {};
    circularDeclaration.self = circularDeclaration;
    const request: JsonObject = {
      contents: [null, { parts: [null, "unexpected", {}, { text: 7 }] }],
      systemInstruction: { parts: "not-an-array" },
      tools: [null, { functionDeclarations: [circularDeclaration, undefined] }],
    };

    expect(() => estimateInputTokens(request, policy)).not.toThrow();
    expect(estimateInputTokens(request, policy)).toBe(6_000);
  });
});

describe("estimateOutputTokens", () => {
  const outputCases: Array<{
    name: string;
    request: JsonObject;
    modelOutputTokenLimit: number | null;
    expected: number;
  }> = [
    {
      name: "uses the request limit first",
      request: { generationConfig: { maxOutputTokens: 128 } },
      modelOutputTokenLimit: null,
      expected: 128,
    },
    {
      name: "uses the model limit when the request has none",
      request: {},
      modelOutputTokenLimit: 256,
      expected: 256,
    },
    {
      name: "uses the policy default when no limit is available",
      request: {},
      modelOutputTokenLimit: null,
      expected: 8_192,
    },
    {
      name: "caps a request limit at the model limit",
      request: { generationConfig: { maxOutputTokens: 1_000 } },
      modelOutputTokenLimit: 256,
      expected: 256,
    },
    {
      name: "keeps a smaller request limit",
      request: { generationConfig: { maxOutputTokens: 128 } },
      modelOutputTokenLimit: 256,
      expected: 128,
    },
    {
      name: "ignores an invalid request limit",
      request: { generationConfig: { maxOutputTokens: 0 } },
      modelOutputTokenLimit: 256,
      expected: 256,
    },
  ];

  it.each(outputCases)("$name", ({ request, modelOutputTokenLimit, expected }) => {
    expect(estimateOutputTokens(request, modelOutputTokenLimit, policy)).toBe(expected);
  });
});

describe("estimateReservationMicros", () => {
  const reservationPolicy: ReservationPolicy = {
    ...policy,
    charsPerToken: 1,
  };

  // 1,234,567 × $0.30 / 1,000,000 is 370,370.1 micro-units, so input reserves 370,371.
  // 89,000 × $2.50 / 1,000,000 is 222,500 micro-units, for a 592,871 micro-unit total.
  // At eight fractional price digits, $0.00000001 is 0.01 micro-units per token and rounds up.
  const reservationCases: Array<{
    name: string;
    request: JsonObject;
    rules: PricingRuleInput[];
    expected: bigint;
  }> = [
    {
      name: "rounds each per-million line upward",
      request: {
        contents: [{ parts: [{ text: "x".repeat(1_234_567) }] }],
        generationConfig: { maxOutputTokens: 89_000 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", price: "0.30" }),
        rule({ id: "output", billingDimension: "output_tokens", price: "2.50" }),
      ],
      expected: 592_871n,
    },
    {
      name: "keeps eight fractional price digits until upward rounding",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 1 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", unitSize: "1", price: "0.00000001" }),
        rule({ id: "output", billingDimension: "output_tokens", unitSize: "1", price: "0.00000001" }),
      ],
      expected: 2n,
    },
    {
      name: "uses the higher reasoning-token rate for output reservation",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 2 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", price: "1.00" }),
        rule({ id: "output", billingDimension: "output_tokens", price: "2.00" }),
        rule({ id: "reasoning", billingDimension: "reasoning_tokens", price: "3.00" }),
      ],
      expected: 7n,
    },
    {
      name: "keeps the output rate when reasoning is cheaper",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 2 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", price: "1.00" }),
        rule({ id: "output", billingDimension: "output_tokens", price: "3.00" }),
        rule({ id: "reasoning", billingDimension: "reasoning_tokens", price: "2.00" }),
      ],
      expected: 7n,
    },
    {
      name: "holds output at the image rate for a model that prices generated images",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 2 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", price: "1.00" }),
        rule({ id: "output", billingDimension: "output_tokens", price: "2.00" }),
        rule({ id: "image", billingDimension: "image_output_tokens", price: "30.00" }),
      ],
      expected: 61n,
    },
    {
      name: "prices output at the output rate when reasoning is unpriced",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 2 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", price: "1.00" }),
        rule({ id: "output", billingDimension: "output_tokens", price: "2.00" }),
      ],
      expected: 5n,
    },
    {
      name: "compares output and reasoning rates across different unit sizes",
      request: {
        contents: [{ parts: [{ text: "x" }] }],
        generationConfig: { maxOutputTokens: 1 },
      },
      rules: [
        rule({ id: "input", billingDimension: "input_tokens", unitSize: "1", price: "0" }),
        rule({ id: "output", billingDimension: "output_tokens", unitSize: "1", price: "1" }),
        rule({ id: "reasoning", billingDimension: "reasoning_tokens", unitSize: "1000000", price: "100" }),
      ],
      expected: 1_000_000n,
    },
  ];

  it.each(reservationCases)("$name", ({ request, rules, expected }) => {
    expect(
      estimateReservationMicros({
        request,
        rules,
        at,
        modelOutputTokenLimit: null,
        policy: reservationPolicy,
      }),
    ).toEqual({ micros: expected, priced: true });
  });

  it.each([
    ["input_tokens", [rule({ billingDimension: "output_tokens" })]],
    ["output_tokens", [rule({ billingDimension: "input_tokens" })]],
  ])("returns unpriced when %s has no effective rule", (_missingDimension, rules) => {
    expect(
      estimateReservationMicros({
        request: { contents: [{ parts: [{ text: "x" }] }] },
        rules,
        at,
        modelOutputTokenLimit: null,
        policy: reservationPolicy,
      }),
    ).toEqual({ micros: 0n, priced: false });
  });

  it("rejects active pricing rules with mixed currencies", () => {
    const rules = [
      rule({ id: "input", billingDimension: "input_tokens", currency: "USD" }),
      rule({ id: "output", billingDimension: "output_tokens", currency: "EUR" }),
    ];

    expect(() =>
      estimateReservationMicros({
        request: { contents: [{ parts: [{ text: "x" }] }] },
        rules,
        at,
        modelOutputTokenLimit: null,
        policy: reservationPolicy,
      }),
    ).toThrow(PricingConfigurationError);
  });
});

describe("estimateInputOnlyReservationMicros", () => {
  const reservationPolicy: ReservationPolicy = {
    ...policy,
    charsPerToken: 1,
  };

  it("calculates cost using only input tokens", () => {
    // 1,234,567 chars -> 1,234,567 tokens
    // 1,234,567 × $0.30 / 1,000,000 = $0.3703701 = 370371 micros (ceiling)
    const request = {
      contents: [{ parts: [{ text: "x".repeat(1_234_567) }] }],
    };
    const inputRule = rule({ id: "input", billingDimension: "input_tokens", price: "0.30" });
    
    const micros = estimateInputOnlyReservationMicros(request, inputRule, reservationPolicy);
    expect(micros).toBe(370_371n);
  });
});
