import type { RequestHandler } from "express";
import type { LogMetadata } from "./json-logger.js";
import { getRequestId } from "./request-id.js";

export type HttpRouteGroup = "public" | "admin" | "health";
export type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

export interface HttpAccessMetricLabels {
  routeGroup: HttpRouteGroup;
  statusClass: HttpStatusClass;
}

export interface HttpAccessMetrics {
  incrementActiveRequests(): void;
  decrementActiveRequests(): void;
  recordHttpRequest(labels: HttpAccessMetricLabels, durationSeconds: number): void;
}

export interface HttpAccessLogger {
  log(message: unknown, ...optionalParams: unknown[]): void;
  logStructured?: (message: string, extra: LogMetadata, context?: string) => void;
}

export interface HttpAccessLogMiddlewareOptions {
  monotonicNow?: () => bigint;
}

export interface HttpAccessLogEvent {
  requestId: string;
  clientRequestId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  apiKeyPrefix?: string;
}

interface ApiKeyPrefixCarrier {
  apiKey?: {
    keyPrefix?: unknown;
  };
}

export interface RequestPath {
  path?: string;
  originalUrl?: string;
  url?: string;
}

export function pathWithoutQuery(request: RequestPath): string {
  const path = request.path || request.originalUrl || request.url || "/";
  const delimiter = path.search(/[?#]/);
  return delimiter === -1 ? path : path.slice(0, delimiter);
}

export function routeGroupForPath(path: string): HttpRouteGroup {
  if (path === "/v1beta" || path.startsWith("/v1beta/")) {
    return "public";
  }

  if (path === "/health" || path.startsWith("/health/")) {
    return "health";
  }

  return "admin";
}

export function statusClassFor(status: number): HttpStatusClass {
  if (status >= 100 && status < 200) {
    return "1xx";
  }

  if (status >= 200 && status < 300) {
    return "2xx";
  }

  if (status >= 300 && status < 400) {
    return "3xx";
  }

  if (status >= 400 && status < 500) {
    return "4xx";
  }

  return "5xx";
}

function apiKeyPrefixFor(request: object): string | undefined {
  const apiKey = (request as ApiKeyPrefixCarrier).apiKey;
  return typeof apiKey?.keyPrefix === "string" ? apiKey.keyPrefix : undefined;
}

function writeAccessLog(logger: HttpAccessLogger, event: HttpAccessLogEvent): void {
  if (typeof logger.logStructured === "function") {
    logger.logStructured("http_request", { ...event }, "HttpAccess");
    return;
  }

  // ConsoleLogger has no structured-event API, so preserve one safe, parsable
  // event per request rather than relying on its object formatting behavior.
  logger.log(JSON.stringify(event), "HttpAccess");
}

export function createHttpAccessLogMiddleware(
  logger: HttpAccessLogger,
  metrics: HttpAccessMetrics,
  options: HttpAccessLogMiddlewareOptions = {},
): RequestHandler {
  const monotonicNow = options.monotonicNow ?? process.hrtime.bigint;

  return (request, response, next): void => {
    const path = pathWithoutQuery(request);
    const routeGroup = routeGroupForPath(path);
    const startedAt = monotonicNow();

    if (routeGroup === "public") {
      metrics.incrementActiveRequests();
    }

    let finalized = false;
    const decrementActiveRequests = (): void => {
      if (routeGroup === "public") {
        metrics.decrementActiveRequests();
      }
    };

    response.once("finish", () => {
      if (finalized) {
        return;
      }
      finalized = true;
      const durationMs = Number(monotonicNow() - startedAt) / 1_000_000;
      const event: HttpAccessLogEvent = {
        requestId: getRequestId(request),
        method: request.method,
        path,
        status: response.statusCode,
        durationMs,
      };
      if (request.clientRequestId !== undefined) {
        event.clientRequestId = request.clientRequestId;
      }
      const apiKeyPrefix = apiKeyPrefixFor(request);
      if (apiKeyPrefix !== undefined) {
        event.apiKeyPrefix = apiKeyPrefix;
      }

      try {
        writeAccessLog(logger, event);
        metrics.recordHttpRequest(
          {
            routeGroup,
            statusClass: statusClassFor(response.statusCode),
          },
          durationMs / 1_000,
        );
      } finally {
        decrementActiveRequests();
      }
    });

    response.once("close", () => {
      if (!finalized) {
        finalized = true;
        decrementActiveRequests();
      }
    });

    next();
  };
}
