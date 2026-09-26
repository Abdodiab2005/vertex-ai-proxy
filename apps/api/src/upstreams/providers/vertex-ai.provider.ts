import { GoogleAuth } from "google-auth-library";

import { classifyHttpFailure, UPSTREAM_ABORTED_IN_FLIGHT, UpstreamError } from "./upstream-errors.js";
import type {
  AIUpstreamProvider,
  JsonObject,
  ProviderModelInfo,
  UpstreamCallOptions,
  UpstreamConnectionTestResult,
} from "./upstream-provider.js";
import {
  fromVertexCountTokensResponse,
  toVertexCountTokensRequest,
} from "./vertex-count-tokens.js";
import {
  fromVertexEmbedContentResponse,
  fromVertexPredictEmbeddingResponse,
  toVertexEmbedContentRequest,
  toVertexPredictEmbeddingRequest,
  vertexEmbeddingApiFor,
} from "./vertex-embeddings.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;
const DEFAULT_COUNT_TOKENS_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_EMBED_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL_LOOKUP_TIMEOUT_MS = 15_000;
const MAX_PUBLISHER_MODEL_PAGES = 20;
const PUBLISHER_MODELS_PAGE_SIZE = 100;
const PUBLISHER_MODEL_NAME_PREFIX = "publishers/google/models/";
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type VertexAuth =
  | { method: "application-default-credentials" }
  | {
      method: "service-account";
      credentials: {
        client_email: string;
        private_key: string;
        [key: string]: unknown;
      };
    }
  | { method: "api-key"; apiKey: string };

export interface VertexAIProviderConfig {
  projectId: string;
  location: string;
  auth: VertexAuth;
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
}

type GoogleAuthVertexAuth = Exclude<VertexAuth, { method: "api-key" }>;

export class GoogleAuthAccessTokenSource implements AccessTokenSource {
  private readonly auth: GoogleAuth;

  constructor(vertexAuth: GoogleAuthVertexAuth) {
    this.auth = new GoogleAuth(
      vertexAuth.method === "service-account"
        ? { credentials: vertexAuth.credentials, scopes: [CLOUD_PLATFORM_SCOPE] }
        : { scopes: [CLOUD_PLATFORM_SCOPE] },
    );
  }

  async getAccessToken(): Promise<string> {
    const accessToken = await this.auth.getAccessToken();

    if (typeof accessToken !== "string" || accessToken.trim() === "") {
      throw new Error("Google authentication did not return an access token.");
    }

    return accessToken;
  }
}

export function vertexModelUrl(
  config: VertexAIProviderConfig,
  model: string,
  method: string,
  options?: { stream?: boolean },
): URL {
  assertValidModelId(model);

  const url =
    config.auth.method === "api-key"
      ? new URL(
          `v1beta1/publishers/google/models/${model}:${method}`,
          "https://aiplatform.googleapis.com/",
        )
      : new URL(
          `v1beta1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${model}:${method}`,
          projectScopedBaseUrl(config.location),
        );

  if (options?.stream) {
    url.searchParams.set("alt", "sse");
  }

  return url;
}

function vertexPublisherModelsUrl(
  config: VertexAIProviderConfig,
  query: { pageSize: number; pageToken?: string },
): URL {
  const url = new URL("v1beta1/publishers/google/models", publisherBaseUrl(config));
  url.searchParams.set("pageSize", String(query.pageSize));

  if (query.pageToken !== undefined && query.pageToken.length > 0) {
    url.searchParams.set("pageToken", query.pageToken);
  }

  return url;
}

function vertexPublisherModelUrl(config: VertexAIProviderConfig, model: string): URL {
  assertValidModelId(model);

  return new URL(`v1beta1/publishers/google/models/${model}`, publisherBaseUrl(config));
}

export class VertexAIProvider implements AIUpstreamProvider {
  private readonly fetcher: typeof fetch;
  private readonly accessTokens: AccessTokenSource | undefined;

  constructor(
    private readonly config: VertexAIProviderConfig,
    dependencies: { fetch?: typeof fetch; accessTokens?: AccessTokenSource } = {},
  ) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
    this.accessTokens =
      config.auth.method === "api-key"
        ? undefined
        : (dependencies.accessTokens ?? new GoogleAuthAccessTokenSource(config.auth));
  }

  generateContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<JsonObject> {
    return this.postJson(
      model,
      "generateContent",
      request,
      options,
      DEFAULT_GENERATE_TIMEOUT_MS,
    );
  }

  async streamGenerateContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = vertexModelUrl(this.config, model, "streamGenerateContent", { stream: true });
    const timeout = createRequestTimeout(options, DEFAULT_STREAM_TIMEOUT_MS);

    let response: Response;
    try {
      const init = await this.postInit(request, timeout.signal);
      response = await this.fetchWithSignal(url, init, timeout.signal);
    } finally {
      timeout.clear();
    }

    if (!response.ok) {
      const body = await parseErrorBody(response, timeout.signal);
      throw classifyHttpFailure(response.status, body);
    }

    if (response.body === null) {
      throw new UpstreamError("Upstream returned an empty streaming response.", {
        kind: "upstream_error",
        httpStatus: response.status,
      });
    }

    return response.body;
  }

  async countTokens(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<JsonObject> {
    assertValidModelId(model);
    const vertexRequest = toVertexCountTokensRequest(request);
    const body = await this.postJson(
      model,
      "countTokens",
      vertexRequest,
      options,
      DEFAULT_COUNT_TOKENS_TIMEOUT_MS,
    );

    return fromVertexCountTokensResponse(body);
  }

  async listModels(options?: UpstreamCallOptions): Promise<{ models: ProviderModelInfo[] }> {
    const models: ProviderModelInfo[] = [];
    let pageToken: string | undefined;

    // A nextPageToken that never clears would otherwise page forever.
    for (let page = 0; page < MAX_PUBLISHER_MODEL_PAGES; page += 1) {
      const url = vertexPublisherModelsUrl(this.config, {
        pageSize: PUBLISHER_MODELS_PAGE_SIZE,
        pageToken,
      });
      const body = await this.getJson(url, options, DEFAULT_MODEL_LOOKUP_TIMEOUT_MS);
      const pageResult = parsePublisherModelPage(body);
      models.push(...pageResult.models);

      if (pageResult.nextPageToken === null) {
        return { models };
      }

      pageToken = pageResult.nextPageToken;
    }

    return { models };
  }

  async getModel(model: string, options?: UpstreamCallOptions): Promise<ProviderModelInfo> {
    const url = vertexPublisherModelUrl(this.config, model);
    const body = await this.getJson(url, options, DEFAULT_MODEL_LOOKUP_TIMEOUT_MS);

    return parsePublisherModel(body);
  }

  async embedContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<{ response: JsonObject; inputTokens: number | null }> {
    assertValidModelId(model);
    const api = vertexEmbeddingApiFor(model);
    const vertexRequest =
      api === "predict"
        ? toVertexPredictEmbeddingRequest(request)
        : toVertexEmbedContentRequest(request);
    const body = await this.postJson(model, api, vertexRequest, options, DEFAULT_EMBED_TIMEOUT_MS);

    return api === "predict"
      ? fromVertexPredictEmbeddingResponse(body)
      : fromVertexEmbedContentResponse(body);
  }

  async testConnection(model: string): Promise<UpstreamConnectionTestResult> {
    try {
      await this.countTokens(
        model,
        {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
        },
        { timeoutMs: DEFAULT_COUNT_TOKENS_TIMEOUT_MS },
      );

      return { status: "connected", httpStatus: 200, message: "Connected." };
    } catch (error) {
      if (error instanceof UpstreamError) {
        return {
          status: error.kind,
          httpStatus: error.httpStatus,
          message: error.message,
        };
      }

      throw error;
    }
  }

  private async postJson(
    model: string,
    method: string,
    request: JsonObject,
    options: UpstreamCallOptions | undefined,
    defaultTimeoutMs: number,
  ): Promise<JsonObject> {
    const url = vertexModelUrl(this.config, model, method);
    const timeout = createRequestTimeout(options, defaultTimeoutMs);

    try {
      const init = await this.postInit(request, timeout.signal);
      const response = await this.fetchWithSignal(url, init, timeout.signal);

      if (!response.ok) {
        const body = await parseErrorBody(response, timeout.signal);
        throw classifyHttpFailure(response.status, body);
      }

      try {
        return (await awaitWithAbort(response.json(), timeout.signal)) as JsonObject;
      } catch {
        if (timeout.signal.aborted) {
          throw abortedInFlightError();
        }

        throw new UpstreamError("Upstream returned an invalid JSON response.", {
          kind: "upstream_error",
          httpStatus: response.status,
        });
      }
    } finally {
      timeout.clear();
    }
  }

  private async getJson(
    url: URL,
    options: UpstreamCallOptions | undefined,
    defaultTimeoutMs: number,
  ): Promise<unknown> {
    const timeout = createRequestTimeout(options, defaultTimeoutMs);

    try {
      const response = await this.fetchWithSignal(
        url,
        {
          method: "GET",
          headers: await this.authenticationHeaders(timeout.signal),
        },
        timeout.signal,
      );

      if (!response.ok) {
        const body = await parseErrorBody(response, timeout.signal);
        throw classifyHttpFailure(response.status, body);
      }

      try {
        return await awaitWithAbort(response.json(), timeout.signal);
      } catch {
        if (timeout.signal.aborted) {
          throw networkError();
        }

        throw new UpstreamError("Upstream returned an invalid JSON response.", {
          kind: "upstream_error",
          httpStatus: response.status,
        });
      }
    } finally {
      timeout.clear();
    }
  }

  private async postInit(request: JsonObject, signal: AbortSignal): Promise<RequestInit> {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await this.authenticationHeaders(signal)),
      },
      body: JSON.stringify(request),
    };
  }

  private async authenticationHeaders(signal: AbortSignal): Promise<Record<string, string>> {
    if (this.config.auth.method === "api-key") {
      return { "x-goog-api-key": this.config.auth.apiKey };
    }

    if (signal.aborted) {
      throw networkError();
    }

    const accessTokens = this.accessTokens;
    if (!accessTokens) {
      throw authenticationError();
    }

    try {
      const accessToken = await awaitWithAbort(accessTokens.getAccessToken(), signal);

      if (typeof accessToken !== "string" || accessToken.trim() === "") {
        throw new Error("Access token source did not return an access token.");
      }

      return { Authorization: `Bearer ${accessToken}` };
    } catch {
      if (signal.aborted) {
        throw networkError();
      }

      throw authenticationError();
    }
  }

  private async fetchWithSignal(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) {
      throw networkError();
    }

    try {
      return await awaitWithAbort(this.fetcher(url.toString(), { ...init, signal }), signal);
    } catch (error) {
      if (signal.aborted) {
        throw abortedInFlightError();
      }
      // Only a failure to connect proves Vertex never saw the request. A reset or closed socket
      // later on may follow a request it accepted and will bill, so that one must not be retried.
      const code = socketErrorCode(error);
      throw failedBeforeSending(error) ? networkError(code) : lostInFlightError(code);
    }
  }
}

// Errors that can only happen while establishing the connection (DNS, TCP connect, TLS). ETIMEDOUT is
// the TCP connect timing out (seen in bursts to Vertex); fetch reports a stalled request after sending
// as UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT instead.
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

function codeOf(value: unknown): string | undefined {
  const code = typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The first socket error code under a failed fetch, for the log line. */
function socketErrorCode(error: unknown): string | null {
  const cause = error instanceof Error ? error.cause : undefined;
  const causes = cause instanceof AggregateError ? cause.errors : [cause];
  return causes.map(codeOf).find((code) => code !== undefined) ?? null;
}

/** fetch wraps the socket error as `cause`, and several failed addresses as an AggregateError. */
function failedBeforeSending(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const causes = cause instanceof AggregateError ? cause.errors : [cause];
  return (
    causes.length > 0 &&
    causes.every((item) => {
      const code = codeOf(item);
      return code !== undefined && CONNECT_FAILURE_CODES.has(code);
    })
  );
}

function assertValidModelId(model: string): void {
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error("Invalid model id");
  }
}

function publisherBaseUrl(config: VertexAIProviderConfig): string {
  if (config.auth.method === "api-key") {
    return "https://aiplatform.googleapis.com/";
  }

  return projectScopedBaseUrl(config.location);
}

function projectScopedBaseUrl(location: string): string {
  if (!LOCATION_PATTERN.test(location)) {
    throw new Error("Invalid Vertex AI location");
  }

  if (location === "global") {
    return "https://aiplatform.googleapis.com/";
  }

  if (location === "us" || location === "eu") {
    return `https://aiplatform.${location}.rep.googleapis.com/`;
  }

  return `https://${location}-aiplatform.googleapis.com/`;
}

function createRequestTimeout(
  options: UpstreamCallOptions | undefined,
  defaultTimeoutMs: number,
): { signal: AbortSignal; clear(): void } {
  const timeoutController = new AbortController();
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  return {
    signal,
    clear: () => clearTimeout(timer),
  };
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Error("Request aborted.");
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("Request aborted."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function parseErrorBody(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await awaitWithAbort(response.json(), signal);
  } catch {
    if (signal.aborted) {
      throw networkError();
    }

    return undefined;
  }
}

function authenticationError(): UpstreamError {
  return new UpstreamError("Authentication failed.", {
    kind: "authentication_failed",
    httpStatus: null,
  });
}

function networkError(causeCode: string | null = null): UpstreamError {
  return new UpstreamError("Unable to reach the upstream.", {
    kind: "network_error",
    httpStatus: null,
    causeCode,
  });
}

// Same message as a connect failure; only the reason differs, and it decides retryability.
function lostInFlightError(causeCode: string | null = null): UpstreamError {
  return new UpstreamError("Unable to reach the upstream.", {
    kind: "network_error",
    httpStatus: null,
    reason: UPSTREAM_ABORTED_IN_FLIGHT,
    causeCode,
  });
}

function abortedInFlightError(): UpstreamError {
  return new UpstreamError("The upstream request was cancelled before it completed.", {
    kind: "network_error",
    httpStatus: null,
    reason: UPSTREAM_ABORTED_IN_FLIGHT,
  });
}

function invalidPublisherModelResponse(): UpstreamError {
  return new UpstreamError("Upstream returned an invalid publisher model response.", {
    kind: "upstream_error",
    httpStatus: null,
  });
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublisherModelPage(body: unknown): {
  models: ProviderModelInfo[];
  nextPageToken: string | null;
} {
  if (!isRecord(body)) {
    throw invalidPublisherModelResponse();
  }

  const publisherModels = Object.hasOwn(body, "publisherModels") ? body.publisherModels : [];
  if (!Array.isArray(publisherModels)) {
    throw invalidPublisherModelResponse();
  }

  let nextPageToken: string | null = null;
  if (body.nextPageToken !== undefined) {
    if (typeof body.nextPageToken !== "string") {
      throw invalidPublisherModelResponse();
    }

    nextPageToken = body.nextPageToken.length > 0 ? body.nextPageToken : null;
  }

  return {
    models: publisherModels.map((entry) => parsePublisherModel(entry)),
    nextPageToken,
  };
}

function parsePublisherModel(body: unknown): ProviderModelInfo {
  if (
    !isRecord(body) ||
    typeof body.name !== "string" ||
    !body.name.startsWith(PUBLISHER_MODEL_NAME_PREFIX)
  ) {
    throw invalidPublisherModelResponse();
  }

  const id = body.name.slice(PUBLISHER_MODEL_NAME_PREFIX.length);
  if (id.length === 0 || id.includes("/")) {
    throw invalidPublisherModelResponse();
  }

  const model: ProviderModelInfo = { id };
  if (typeof body.versionId === "string" && body.versionId.length > 0) {
    model.versionId = body.versionId;
  }
  if (typeof body.launchStage === "string" && body.launchStage.length > 0) {
    model.launchStage = body.launchStage;
  }

  return model;
}
