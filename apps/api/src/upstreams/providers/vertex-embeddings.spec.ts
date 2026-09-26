import { describe, expect, it } from "vitest";

import { UpstreamError, UpstreamInputError } from "./upstream-errors.js";
import {
  fromVertexEmbedContentResponse,
  fromVertexPredictEmbeddingResponse,
  toVertexEmbedContentRequest,
  toVertexPredictEmbeddingRequest,
  vertexEmbeddingApiFor,
} from "./vertex-embeddings.js";

const TEXT_MESSAGE = "Embedding input must be text for this model.";

describe("vertexEmbeddingApiFor", () => {
  it.each([
    ["gemini-embedding-001", "predict"],
    ["text-embedding-004", "predict"],
    ["text-embedding-005", "predict"],
    ["text-multilingual-embedding-002", "predict"],
    ["gemini-embedding-2", "embedContent"],
    ["gemini-embedding-2-preview", "embedContent"],
    ["gemini-embedding-001-preview", "embedContent"],
    ["gemini-2.0-flash", "embedContent"],
  ] as const)("selects %s as %s", (model, api) => {
    expect(vertexEmbeddingApiFor(model)).toBe(api);
  });

  it.each(["text-embedding", "text-multilingual-embedding", "my-text-embedding-004", "imagen-3.0"])(
    "rejects %s because it is neither predict-family nor a Gemini model",
    (model) => {
      expect(() => vertexEmbeddingApiFor(model)).toThrow(UpstreamInputError);
      expect(() => vertexEmbeddingApiFor(model)).toThrow(
        "Embeddings are not supported for this model.",
      );
    },
  );
});

describe("toVertexPredictEmbeddingRequest", () => {
  it("joins text parts and maps task, title, and dimensionality", () => {
    expect(
      toVertexPredictEmbeddingRequest({
        model: "ignored",
        content: {
          role: "user",
          parts: [{ text: "hello", thought: true }, { text: "world" }],
        },
        taskType: "RETRIEVAL_DOCUMENT",
        title: "Doc",
        outputDimensionality: 256,
      }),
    ).toEqual({
      instances: [
        {
          content: "hello\nworld",
          task_type: "RETRIEVAL_DOCUMENT",
          title: "Doc",
        },
      ],
      parameters: { outputDimensionality: 256 },
    });
  });

  it("omits optional fields that were not sent", () => {
    expect(
      toVertexPredictEmbeddingRequest({
        content: { parts: [{ text: "only" }] },
      }),
    ).toEqual({ instances: [{ content: "only" }] });
  });

  it.each([
    ["missing content", {}],
    ["parts that are not an array", { content: { parts: "hello" } }],
    ["a non-object part", { content: { parts: ["hello"] } }],
    ["a part without text", { content: { parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }] } }],
    [
      "a text part that also carries media",
      { content: { parts: [{ text: "hello", inlineData: { mimeType: "image/png", data: "abc" } }] } },
    ],
    ["a numeric text part", { content: { parts: [{ text: 1 }] } }],
  ])("rejects %s", (_name, request) => {
    expect(() => toVertexPredictEmbeddingRequest(request)).toThrow(UpstreamInputError);
    expect(() => toVertexPredictEmbeddingRequest(request)).toThrow(TEXT_MESSAGE);
  });

  it("rejects a non-finite outputDimensionality", () => {
    expect(() =>
      toVertexPredictEmbeddingRequest({
        content: { parts: [{ text: "hello" }] },
        outputDimensionality: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(UpstreamInputError);
  });
});

describe("toVertexEmbedContentRequest", () => {
  it("moves config fields and leaves content untouched", () => {
    const content = {
      parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }, { text: "caption" }],
    };

    expect(
      toVertexEmbedContentRequest({
        model: "ignored",
        content,
        taskType: "RETRIEVAL_QUERY",
        title: "Query",
        outputDimensionality: 128,
        extra: true,
      }),
    ).toEqual({
      content,
      embedContentConfig: {
        taskType: "RETRIEVAL_QUERY",
        title: "Query",
        outputDimensionality: 128,
      },
    });
  });

  it("omits embedContentConfig when no config fields are set", () => {
    const content = { parts: [{ text: "hello" }] };

    expect(toVertexEmbedContentRequest({ content, model: "ignored" })).toEqual({ content });
  });

  it("rejects a non-finite outputDimensionality", () => {
    expect(() =>
      toVertexEmbedContentRequest({
        content: { parts: [{ text: "hello" }] },
        outputDimensionality: Number.NaN,
      }),
    ).toThrow("Embedding outputDimensionality must be a finite number.");
  });
});

describe("fromVertexPredictEmbeddingResponse", () => {
  it("reads values and the predict token count", () => {
    expect(
      fromVertexPredictEmbeddingResponse({
        predictions: [
          {
            embeddings: {
              values: [0.1, 0.2],
              statistics: { truncated: true, token_count: 4 },
            },
          },
        ],
        metadata: { billableCharacterCount: 9 },
      }),
    ).toEqual({
      response: { embedding: { values: [0.1, 0.2] } },
      inputTokens: 4,
    });
  });

  it("uses null when the token count is missing or not a finite number", () => {
    expect(
      fromVertexPredictEmbeddingResponse({
        predictions: [{ embeddings: { values: [1], statistics: { token_count: "4" } } }],
      }),
    ).toEqual({ response: { embedding: { values: [1] } }, inputTokens: null });

    expect(
      fromVertexPredictEmbeddingResponse({
        predictions: [{ embeddings: { values: [0] } }],
      }).inputTokens,
    ).toBeNull();
  });

  it("keeps a zero token count", () => {
    expect(
      fromVertexPredictEmbeddingResponse({
        predictions: [{ embeddings: { values: [], statistics: { token_count: 0 } } }],
      }).inputTokens,
    ).toBe(0);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
    ["predictions that are not an array", { predictions: {} }],
    ["no predictions", { predictions: [] }],
    ["a prediction without embeddings", { predictions: [{}] }],
    ["embeddings without values", { predictions: [{ embeddings: {} }] }],
    ["non-numeric values", { predictions: [{ embeddings: { values: ["x"] } }] }],
    ["a non-finite value", { predictions: [{ embeddings: { values: [Number.NaN] } }] }],
  ])("rejects %s", (_name, body) => {
    expect(() => fromVertexPredictEmbeddingResponse(body)).toThrow(UpstreamError);
    try {
      fromVertexPredictEmbeddingResponse(body);
    } catch (error) {
      expect(error).toMatchObject({ kind: "upstream_error", httpStatus: null });
    }
  });
});

describe("fromVertexEmbedContentResponse", () => {
  it("reads values and the embedContent prompt token count", () => {
    expect(
      fromVertexEmbedContentResponse({
        embedding: { values: [0.5, -1] },
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
        truncated: false,
      }),
    ).toEqual({
      response: { embedding: { values: [0.5, -1] } },
      inputTokens: 3,
    });
  });

  it("uses null when usage metadata has no finite prompt token count", () => {
    expect(fromVertexEmbedContentResponse({ embedding: { values: [1] } })).toEqual({
      response: { embedding: { values: [1] } },
      inputTokens: null,
    });
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["an embedding without values", { embedding: {} }],
    ["non-numeric values", { embedding: { values: [true] } }],
  ])("rejects %s", (_name, body) => {
    expect(() => fromVertexEmbedContentResponse(body)).toThrow(UpstreamError);
    try {
      fromVertexEmbedContentResponse(body);
    } catch (error) {
      expect(error).toMatchObject({ kind: "upstream_error", httpStatus: null });
    }
  });
});
