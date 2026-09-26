import { describe, expect, it, vi } from "vitest";

import { UPSTREAM_ABORTED_IN_FLIGHT, UpstreamError, UpstreamInputError } from "./upstream-errors.js";
import type { AccessTokenSource, VertexAIProviderConfig, VertexAuth } from "./vertex-ai.provider.js";
import {
  GoogleAuthAccessTokenSource,
  VertexAIProvider,
  vertexModelUrl,
} from "./vertex-ai.provider.js";

const MODEL = "gemini-2.0-flash";
const TOKEN = "tok-SECRET-123";
const API_KEY = "key-SECRET-456";

const adcConfig: VertexAIProviderConfig = {
  projectId: "project-123",
  location: "us-central1",
  auth: { method: "application-default-credentials" },
};

const serviceAccountConfig: VertexAIProviderConfig = {
  projectId: "project-123",
  location: "us-central1",
  auth: {
    method: "service-account",
    credentials: {
      client_email: "gateway@example.iam.gserviceaccount.com",
      private_key: "unused-in-tests",
    },
  },
};

const apiKeyConfig: VertexAIProviderConfig = {
  projectId: "project-123",
  location: "us-central1",
  auth: { method: "api-key", apiKey: API_KEY },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function accessTokenSource(token = TOKEN): {
  source: AccessTokenSource;
  getAccessToken: ReturnType<typeof vi.fn<AccessTokenSource["getAccessToken"]>>;
} {
  const getAccessToken = vi.fn<AccessTokenSource["getAccessToken"]>().mockResolvedValue(token);

  return { source: { getAccessToken }, getAccessToken };
}

async function caughtError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the operation to reject.");
}

function errorValues(value: unknown, seen = new Set<object>()): string {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);

  return Object.getOwnPropertyNames(value)
    .map((key) => {
      return errorValues((value as Record<string, unknown>)[key], seen);
    })
    .join("\n");
}

const vertexEndpointCases: Array<{
  name: string;
  config: VertexAIProviderConfig;
  pathPrefix: string;
}> = [
  {
    name: "regional",
    config: adcConfig,
    pathPrefix:
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/project-123/locations/us-central1/publishers/google/models/",
  },
  {
    name: "global",
    config: { ...adcConfig, location: "global" },
    pathPrefix:
      "https://aiplatform.googleapis.com/v1beta1/projects/project-123/locations/global/publishers/google/models/",
  },
  {
    name: "us multi-region",
    config: { ...adcConfig, location: "us" },
    pathPrefix:
      "https://aiplatform.us.rep.googleapis.com/v1beta1/projects/project-123/locations/us/publishers/google/models/",
  },
  {
    name: "eu multi-region",
    config: { ...adcConfig, location: "eu" },
    pathPrefix:
      "https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/project-123/locations/eu/publishers/google/models/",
  },
  {
    name: "express mode",
    config: apiKeyConfig,
    pathPrefix: "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/",
  },
];

const modelMethods = ["generateContent", "countTokens", "streamGenerateContent"] as const;
const vertexUrlCases = vertexEndpointCases.flatMap(({ name, config, pathPrefix }) =>
  modelMethods.map((method) => ({
    name,
    config,
    method,
    stream: method === "streamGenerateContent",
    expected: `${pathPrefix}${MODEL}:${method}${method === "streamGenerateContent" ? "?alt=sse" : ""}`,
  })),
);

describe("vertexModelUrl", () => {
  it.each(vertexUrlCases)(
    "uses the $name endpoint for $method",
    ({ config, method, stream, expected }) => {
      const url = vertexModelUrl(config, MODEL, method, { stream });

      expect(url.toString()).toBe(expected);
      expect(url.toString()).not.toContain(API_KEY);
    },
  );

  it.each(["evil.example/", "us-central1@evil.example", ""])(
    "rejects an unsafe project-scoped location %j",
    (location) => {
      expect(() =>
        vertexModelUrl({ ...adcConfig, location }, MODEL, "generateContent"),
      ).toThrow("Invalid Vertex AI location");
    },
  );
});

describe("VertexAIProvider", () => {
  it.each([
    ["application default credentials", adcConfig, "authorization", `Bearer ${TOKEN}`],
    ["service account credentials", serviceAccountConfig, "authorization", `Bearer ${TOKEN}`],
    ["API key", apiKeyConfig, "x-goog-api-key", API_KEY],
  ] as const)("uses only the expected auth header for %s", async (_name, config, header, value) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ candidates: [] }));
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(config, { fetch: fetchMock, accessTokens: source });
    const request = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.25 },
    };
    const serializedRequest = JSON.stringify(request);

    await expect(provider.generateContent(MODEL, request)).resolves.toEqual({ candidates: [] });

    const [input, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);

    expect(headers.get(header)).toBe(value);
    expect(headers.get(header === "authorization" ? "x-goog-api-key" : "authorization")).toBeNull();
    expect(init?.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.body).toBe(serializedRequest);
    expect(request).toEqual(JSON.parse(serializedRequest));
    expect(String(input)).not.toContain(API_KEY);

    if (config.auth.method === "api-key") {
      expect(getAccessToken).not.toHaveBeenCalled();
    } else {
      expect(getAccessToken).toHaveBeenCalledOnce();
    }
  });

  it("maps a rejected fetch to a safe network error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(API_KEY));
    const provider = new VertexAIProvider(apiKeyConfig, { fetch: fetchMock });
    const error = await caughtError(provider.generateContent(MODEL, { contents: [] }));

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
    expect(errorValues(error)).not.toContain(API_KEY);
  });

  it.each([
    ["a refused connection", Object.assign(new Error("connect"), { code: "ECONNREFUSED" }), null],
    ["a DNS failure", Object.assign(new Error("dns"), { code: "ENOTFOUND" }), null],
    ["a TCP connect timeout", Object.assign(new Error("connect"), { code: "ETIMEDOUT" }), null],
    [
      "every address refusing",
      new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" }), Object.assign(new Error("b"), { code: "EHOSTUNREACH" })]),
      null,
    ],
    ["a reset after sending", Object.assign(new Error("reset"), { code: "ECONNRESET" }), UPSTREAM_ABORTED_IN_FLIGHT],
    ["a closed socket", Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }), UPSTREAM_ABORTED_IN_FLIGHT],
    ["an error without a code", new Error("?"), UPSTREAM_ABORTED_IN_FLIGHT],
  ])("classifies %s (retryable only when the request never left)", async (_name, cause, reason) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause }));
    const provider = new VertexAIProvider(apiKeyConfig, { fetch: fetchMock });
    const error = await caughtError(provider.generateContent(MODEL, { contents: [] }));

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null, reason });
  });

  it("maps a timed-out fetch to a network error", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error("request was already aborted"));
          return;
        }

        init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
          once: true,
        });
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(
      provider.generateContent(MODEL, { contents: [] }, { timeoutMs: 5 }),
    );

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
  });

  it("times out a hung access-token lookup before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const getAccessToken = vi.fn<AccessTokenSource["getAccessToken"]>(
      () => new Promise<string>(() => {}),
    );
    const provider = new VertexAIProvider(adcConfig, {
      fetch: fetchMock,
      accessTokens: { getAccessToken },
    });
    const error = await caughtError(
      provider.generateContent(MODEL, { contents: [] }, { timeoutMs: 5 }),
    );

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors an already-aborted caller signal before looking up a token", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn<typeof fetch>();
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(
      provider.generateContent(MODEL, { contents: [] }, { signal: controller.signal }),
    );

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps access-token failures to a safe authentication error", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const getAccessToken = vi
      .fn<AccessTokenSource["getAccessToken"]>()
      .mockRejectedValue(new Error(TOKEN));
    const provider = new VertexAIProvider(adcConfig, {
      fetch: fetchMock,
      accessTokens: { getAccessToken },
    });
    const error = await caughtError(provider.generateContent(MODEL, { contents: [] }));

    expect(error).toMatchObject({ kind: "authentication_failed", httpStatus: null });
    expect(errorValues(error)).not.toContain(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty token", ""],
    ["a missing token", undefined],
  ] as const)("treats %s as an authentication failure", async (_name, token) => {
    const fetchMock = vi.fn<typeof fetch>();
    const getAccessToken = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValue(token);
    const provider = new VertexAIProvider(adcConfig, {
      fetch: fetchMock,
      accessTokens: { getAccessToken: getAccessToken as AccessTokenSource["getAccessToken"] },
    });
    const error = await caughtError(provider.generateContent(MODEL, { contents: [] }));

    expect(error).toMatchObject({ kind: "authentication_failed", httpStatus: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const invalidModelCalls = [
    [
      "generateContent",
      (provider: VertexAIProvider, model: string) => provider.generateContent(model, { contents: [] }),
    ],
    [
      "countTokens",
      (provider: VertexAIProvider, model: string) => provider.countTokens(model, { contents: [] }),
    ],
    [
      "streamGenerateContent",
      (provider: VertexAIProvider, model: string) =>
        provider.streamGenerateContent(model, { contents: [] }),
    ],
    [
      "embedContent",
      (provider: VertexAIProvider, model: string) => provider.embedContent(model, {}),
    ],
    [
      "getModel",
      (provider: VertexAIProvider, model: string) => provider.getModel(model),
    ],
  ] as const;
  const invalidModelCases = invalidModelCalls.flatMap(([operation, call]) =>
    ["../x", "a/b", ""].map((model) => ({ operation, call, model })),
  );

  it.each(invalidModelCases)(
    "rejects the invalid model id $model before $operation fetches",
    async ({ call, model }) => {
      const fetchMock = vi.fn<typeof fetch>();
      const { source, getAccessToken } = accessTokenSource();
      const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
      const error = await caughtError(call(provider, model));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UpstreamError);
      expect((error as Error).message).toBe("Invalid model id");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    },
  );

  it("returns a streaming response without consuming it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first event\n\n"));
        controller.close();
      },
    });
    const response = new Response(stream);
    const originalBody = response.body;

    if (originalBody === null) {
      throw new Error("Expected the response to expose its stream.");
    }

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const returnedStream = await provider.streamGenerateContent(MODEL, { contents: [] });

    expect(returnedStream).toBe(originalBody);
    expect(response.bodyUsed).toBe(false);
    expect(returnedStream.locked).toBe(false);

    const reader = returnedStream.getReader();
    const firstChunk = await reader.read();
    reader.releaseLock();

    expect(new TextDecoder().decode(firstChunk.value)).toBe("data: first event\n\n");
  });

  it("classifies a failed streaming response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 403,
            message: "Vertex AI is disabled.",
            status: "PERMISSION_DENIED",
            details: [{ reason: "SERVICE_DISABLED" }],
          },
        },
        403,
      ),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.streamGenerateContent(MODEL, { contents: [] })).rejects.toMatchObject({
      kind: "permission_denied",
      httpStatus: 403,
      reason: "SERVICE_DISABLED",
    });
  });

  it("maps a streaming response-header timeout to a network error", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
          once: true,
        });
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(
      provider.streamGenerateContent(MODEL, { contents: [] }, { timeoutMs: 5 }),
    );

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
  });

  it("does not let the response-header timeout abort a started stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: still running\n\n"));
        controller.close();
      },
    });
    const response = new Response(stream);
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal;
      return Promise.resolve(response);
    });
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const returnedStream = await provider.streamGenerateContent(
      MODEL,
      { contents: [] },
      { timeoutMs: 5 },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(requestSignal?.aborted).toBe(false);
    expect(returnedStream.locked).toBe(false);
  });

});

const publisherModelHosts: Array<{
  name: string;
  config: VertexAIProviderConfig;
  origin: string;
}> = [
  {
    name: "regional",
    config: adcConfig,
    origin: "https://us-central1-aiplatform.googleapis.com",
  },
  {
    name: "global",
    config: { ...adcConfig, location: "global" },
    origin: "https://aiplatform.googleapis.com",
  },
  {
    name: "us multi-region",
    config: { ...adcConfig, location: "us" },
    origin: "https://aiplatform.us.rep.googleapis.com",
  },
  {
    name: "eu multi-region",
    config: { ...adcConfig, location: "eu" },
    origin: "https://aiplatform.eu.rep.googleapis.com",
  },
  {
    name: "express mode",
    config: apiKeyConfig,
    origin: "https://aiplatform.googleapis.com",
  },
];

describe("VertexAIProvider.countTokens", () => {
  it("unwraps generateContentRequest and drops the inner model", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        totalTokens: 12,
        totalBillableCharacters: 40,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
        cachedContentTokenCount: 2,
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(
      provider.countTokens(MODEL, {
        generateContentRequest: {
          model: "other-model",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          systemInstruction: { parts: [{ text: "sys" }] },
          tools: [{ functionDeclarations: [{ name: "ping" }] }],
          generationConfig: { temperature: 0.2 },
        },
      }),
    ).resolves.toEqual({
      totalTokens: 12,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
      cachedContentTokenCount: 2,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/project-123/locations/us-central1/publishers/google/models/gemini-2.0-flash:countTokens",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      tools: [{ functionDeclarations: [{ name: "ping" }] }],
      generationConfig: { temperature: 0.2 },
    });
    expect(String(init?.body)).not.toContain("other-model");
  });

  it("uses the express-mode countTokens URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ totalTokens: 1 }));
    const provider = new VertexAIProvider(apiKeyConfig, { fetch: fetchMock });

    await expect(provider.countTokens(MODEL, { contents: [{ parts: [{ text: "hi" }] }] })).resolves.toEqual({
      totalTokens: 1,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-2.0-flash:countTokens",
    );
    expect(String(input)).not.toContain(API_KEY);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
  });

  it("rejects a body with neither contents nor generateContentRequest before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(provider.countTokens(MODEL, {}));

    expect(error).toBeInstanceOf(UpstreamInputError);
    expect((error as Error).message).toBe(
      "Count tokens input must include contents or generateContentRequest.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});

describe("VertexAIProvider.embedContent", () => {
  it("posts the predict API for text-embedding models", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        predictions: [
          {
            embeddings: {
              values: [0.1, 0.2],
              statistics: { truncated: false, token_count: 4 },
            },
          },
        ],
        metadata: { billableCharacterCount: 9 },
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(
      provider.embedContent("text-embedding-004", {
        model: "text-embedding-004",
        content: { parts: [{ text: "hello" }, { text: "world" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        title: "Doc",
        outputDimensionality: 256,
      }),
    ).resolves.toEqual({
      response: { embedding: { values: [0.1, 0.2] } },
      inputTokens: 4,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/project-123/locations/us-central1/publishers/google/models/text-embedding-004:predict",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      instances: [{ content: "hello\nworld", task_type: "RETRIEVAL_DOCUMENT", title: "Doc" }],
      parameters: { outputDimensionality: 256 },
    });
    expect(String(input)).not.toContain(TOKEN);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("posts the embedContent API for later Gemini embedding models", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        embedding: { values: [0.5] },
        usageMetadata: { promptTokenCount: 3 },
        truncated: false,
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const content = { parts: [{ text: "query" }] };

    await expect(
      provider.embedContent("gemini-embedding-2", {
        model: "gemini-embedding-2",
        content,
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 128,
      }),
    ).resolves.toEqual({
      response: { embedding: { values: [0.5] } },
      inputTokens: 3,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/project-123/locations/us-central1/publishers/google/models/gemini-embedding-2:embedContent",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      content,
      embedContentConfig: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 128 },
    });
  });

  it.each([
    ["gemini-embedding-001", "gemini-embedding-001:predict"],
    ["text-embedding-004", "text-embedding-004:predict"],
    ["gemini-embedding-2", "gemini-embedding-2:embedContent"],
  ] as const)("uses the express-mode URL for %s", async (model, suffix) => {
    const predict = suffix.endsWith(":predict");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        predict
          ? { predictions: [{ embeddings: { values: [1], statistics: { token_count: 1 } } }] }
          : { embedding: { values: [1] }, usageMetadata: { promptTokenCount: 1 } },
      ),
    );
    const provider = new VertexAIProvider(apiKeyConfig, { fetch: fetchMock });

    await expect(
      provider.embedContent(model, { content: { parts: [{ text: "hi" }] } }),
    ).resolves.toMatchObject({ inputTokens: 1 });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/${suffix}`,
    );
    expect(String(input)).not.toContain("projects");
    expect(String(input)).not.toContain(API_KEY);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(headers.get("authorization")).toBeNull();
  });

  it("rejects non-text predict input before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(
      provider.embedContent("text-embedding-004", {
        content: { parts: [{ inlineData: { mimeType: "image/png", data: "abc" } }] },
      }),
    );

    expect(error).toBeInstanceOf(UpstreamInputError);
    expect((error as Error).message).toBe("Embedding input must be text for this model.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("rejects an unsupported embedding model before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(
      provider.embedContent("imagen-3.0-generate-001", {
        content: { parts: [{ text: "hi" }] },
      }),
    );

    expect(error).toBeInstanceOf(UpstreamInputError);
    expect((error as Error).message).toBe("Embeddings are not supported for this model.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("classifies a failed embedding response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { message: "Not found.", status: "NOT_FOUND" } }, 404),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(
      provider.embedContent("gemini-embedding-001", { content: { parts: [{ text: "hi" }] } }),
    ).rejects.toMatchObject({
      kind: "model_unavailable",
      httpStatus: 404,
      message: "Not found.",
    });
  });

  it("rejects a malformed embedding body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ predictions: [] }));
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(
      provider.embedContent("gemini-embedding-001", { content: { parts: [{ text: "hi" }] } }),
    ).rejects.toMatchObject({
      kind: "upstream_error",
      httpStatus: null,
      message: "Upstream returned an invalid embedding response.",
    });
  });
});

describe("VertexAIProvider.listModels", () => {
  it.each(publisherModelHosts)("uses the $name host without a project prefix", async ({ config, origin }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ publisherModels: [] }));
    const { source, getAccessToken } = accessTokenSource();
    const provider = new VertexAIProvider(config, { fetch: fetchMock, accessTokens: source });

    await expect(provider.listModels()).resolves.toEqual({ models: [] });

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/v1beta1/publishers/google/models");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(url.searchParams.has("pageToken")).toBe(false);
    expect(String(input)).not.toContain("/projects/");
    expect(String(input)).not.toContain(API_KEY);
    expect(init?.method).toBe("GET");

    const headers = new Headers(init?.headers);
    if (config.auth.method === "api-key") {
      expect(headers.get("x-goog-api-key")).toBe(API_KEY);
      expect(headers.get("authorization")).toBeNull();
      expect(getAccessToken).not.toHaveBeenCalled();
    } else {
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("x-goog-api-key")).toBeNull();
    }
  });

  it("follows nextPageToken for two pages and then stops", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          publisherModels: [
            {
              name: "publishers/google/models/gemini-2.0-flash",
              versionId: "2.0",
              launchStage: "GA",
            },
          ],
          nextPageToken: "page-2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          publisherModels: [{ name: "publishers/google/models/text-embedding-004", launchStage: "GA" }],
          nextPageToken: "",
        }),
      );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.listModels()).resolves.toEqual({
      models: [
        { id: "gemini-2.0-flash", versionId: "2.0", launchStage: "GA" },
        { id: "text-embedding-004", launchStage: "GA" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(second.searchParams.get("pageToken")).toBe("page-2");
    expect(second.pathname).not.toContain("/projects/");
  });

  it("stops after 20 pages when nextPageToken never clears", async () => {
    let page = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      page += 1;

      return Promise.resolve(
        jsonResponse({
          publisherModels: [{ name: `publishers/google/models/model-${page}` }],
          nextPageToken: `token-${page}`,
        }),
      );
    });
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    const result = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(result.models.map((model) => model.id)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `model-${index + 1}`),
    );
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has("pageToken")).toBe(false);
    expect(new URL(String(fetchMock.mock.calls[19]![0])).searchParams.get("pageToken")).toBe(
      "token-19",
    );
  });

  it("uses the global express host even when location is not a Vertex location", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ publisherModels: [] }));
    const provider = new VertexAIProvider(
      { ...apiKeyConfig, location: "evil.example/" },
      { fetch: fetchMock },
    );

    await provider.listModels();

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.origin).toBe("https://aiplatform.googleapis.com");
    expect(url.pathname).toBe("/v1beta1/publishers/google/models");
    expect(url.toString()).not.toContain(API_KEY);
  });

  it("rejects an unsafe project-scoped location before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new VertexAIProvider(
      { ...adcConfig, location: "evil.example/" },
      { fetch: fetchMock },
    );

    await expect(provider.listModels()).rejects.toThrow("Invalid Vertex AI location");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a publisher model entry whose name is not a publisher model", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ publisherModels: [{ name: "models/gemini-2.0-flash" }] }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.listModels()).rejects.toMatchObject({
      kind: "upstream_error",
      httpStatus: null,
      message: "Upstream returned an invalid publisher model response.",
    });
  });

  it("maps a rejected listModels fetch to a safe network error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(API_KEY));
    const provider = new VertexAIProvider(apiKeyConfig, { fetch: fetchMock });
    const error = await caughtError(provider.listModels());

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
    expect(errorValues(error)).not.toContain(API_KEY);
  });

  it("maps a timed-out listModels fetch to a network error", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
            once: true,
          });
        }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });
    const error = await caughtError(provider.listModels({ timeoutMs: 5 }));

    expect(error).toMatchObject({ kind: "network_error", httpStatus: null });
  });
});

describe("VertexAIProvider.getModel", () => {
  it.each(publisherModelHosts)("uses the $name host without a project prefix", async ({ config, origin }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        name: "publishers/google/models/gemini-2.0-flash",
        versionId: "2.0",
        launchStage: "PREVIEW",
      }),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(config, { fetch: fetchMock, accessTokens: source });

    await expect(provider.getModel("gemini-2.0-flash")).resolves.toEqual({
      id: "gemini-2.0-flash",
      versionId: "2.0",
      launchStage: "PREVIEW",
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(`${origin}/v1beta1/publishers/google/models/gemini-2.0-flash`);
    expect(String(input)).not.toContain("/projects/");
    expect(String(input)).not.toContain(API_KEY);
    expect(init?.method).toBe("GET");

    const headers = new Headers(init?.headers);
    if (config.auth.method === "api-key") {
      expect(headers.get("x-goog-api-key")).toBe(API_KEY);
      expect(headers.get("authorization")).toBeNull();
    } else {
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("classifies a missing model as model_unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: { code: 404, message: "Model was not found.", status: "NOT_FOUND" } },
        404,
      ),
    );
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.getModel(MODEL)).rejects.toMatchObject({
      kind: "model_unavailable",
      httpStatus: 404,
      message: "Model was not found.",
    });
  });

  it("rejects a malformed publisher model", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ name: "gemini-2.0-flash" }));
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.getModel(MODEL)).rejects.toMatchObject({
      kind: "upstream_error",
      httpStatus: null,
    });
  });
});

describe("VertexAIProvider.testConnection", () => {
  it("uses countTokens as a successful connection probe", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ totalTokens: 1 }));
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.testConnection(MODEL)).resolves.toEqual({
      status: "connected",
      httpStatus: 200,
      message: "Connected.",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
    });
  });

  it("returns an upstream failure when the probe body is not a countTokens response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ totalBillableCharacters: 4 }));
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.testConnection(MODEL)).resolves.toEqual({
      status: "upstream_error",
      httpStatus: null,
      message: "Upstream returned an invalid count tokens response.",
    });
  });

  it.each([
    [
      "an authentication failure",
      jsonResponse({ error: { message: "Unauthenticated." } }, 401),
      "authentication_failed",
      401,
      "Unauthenticated.",
    ],
    [
      "a permission failure",
      jsonResponse({ error: { message: "Forbidden." } }, 403),
      "permission_denied",
      403,
      "Forbidden.",
    ],
    [
      "a missing model",
      jsonResponse({ error: { message: "Not found." } }, 404),
      "model_unavailable",
      404,
      "Not found.",
    ],
    [
      "quota exhaustion",
      jsonResponse({ error: { message: "Quota exhausted." } }, 429),
      "quota_exhausted",
      429,
      "Quota exhausted.",
    ],
    [
      "an upstream failure",
      textResponse("not JSON", 500),
      "upstream_error",
      500,
      "Upstream returned HTTP 500.",
    ],
  ] as const)("returns %s", async (_name, response, status, httpStatus, message) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.testConnection(MODEL)).resolves.toEqual({ status, httpStatus, message });
  });

  it("returns a network failure when the probe fetch rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const { source } = accessTokenSource();
    const provider = new VertexAIProvider(adcConfig, { fetch: fetchMock, accessTokens: source });

    await expect(provider.testConnection(MODEL)).resolves.toEqual({
      status: "network_error",
      httpStatus: null,
      message: "Unable to reach the upstream.",
    });
  });
});

describe("GoogleAuthAccessTokenSource", () => {
  const invalidServiceAccountAuth = {
    method: "service-account",
    credentials: {
      type: "service_account",
      project_id: "test-project",
      private_key_id: "test-key-id",
      private_key: "not a valid PEM private key",
      client_email: "gateway@test-project.iam.gserviceaccount.com",
      client_id: "1234567890",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        "https://www.googleapis.com/robot/v1/metadata/x509/gateway%40test-project.iam.gserviceaccount.com",
    },
  } satisfies VertexAuth;

  it("rejects a garbage service-account private key locally and the provider normalizes it", async () => {
    const source = new GoogleAuthAccessTokenSource(invalidServiceAccountAuth);
    await expect(source.getAccessToken()).rejects.toThrow();

    const fetchMock = vi.fn<typeof fetch>();
    const provider = new VertexAIProvider(
      { ...serviceAccountConfig, auth: invalidServiceAccountAuth },
      { fetch: fetchMock },
    );
    const error = await caughtError(provider.countTokens(MODEL, { contents: [] }));

    expect(error).toMatchObject({ kind: "authentication_failed", httpStatus: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
