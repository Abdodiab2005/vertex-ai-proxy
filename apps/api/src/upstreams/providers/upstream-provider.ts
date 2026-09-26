import type { UpstreamFailureKind } from "./upstream-errors.js";

export type JsonObject = Record<string, unknown>;

export interface UpstreamCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UpstreamConnectionTestResult {
  status: "connected" | UpstreamFailureKind;
  httpStatus: number | null;
  message: string;
}

export interface ProviderModelInfo {
  id: string;
  versionId?: string;
  launchStage?: string;
}

/**
 * Keeps gateway routing independent from an upstream's transport and schemas.
 */
export interface AIUpstreamProvider {
  generateContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<JsonObject>;
  streamGenerateContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  countTokens(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<JsonObject>;
  listModels(options?: UpstreamCallOptions): Promise<{ models: ProviderModelInfo[] }>;
  getModel(model: string, options?: UpstreamCallOptions): Promise<ProviderModelInfo>;
  embedContent(
    model: string,
    request: JsonObject,
    options?: UpstreamCallOptions,
  ): Promise<{ response: JsonObject; inputTokens: number | null }>;
  testConnection(model: string): Promise<UpstreamConnectionTestResult>;
}
