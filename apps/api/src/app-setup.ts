import { createRequire } from "node:module";
import { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { ErrorRequestHandler } from "express";
import type { ApiEnv } from "./config/env.js";
import {
  createHttpAccessLogMiddleware,
  type HttpAccessLogger,
  type HttpAccessMetrics,
} from "./observability/http-access-log.middleware.js";
import { requestIdMiddleware } from "./observability/request-id.js";
import { mapBodyParserErrorToGeminiError } from "./public-api/gemini-errors.js";

// Express is provided by Nest's platform adapter. Resolve it from that package
// so pnpm's isolated dependency layout cannot select an unrelated copy.
const requirePlatformExpress = createRequire(import.meta.resolve("@nestjs/platform-express"));
const express = requirePlatformExpress("express") as typeof import("express");

export const PUBLIC_API_PATH_PREFIX = "/v1beta";

export interface AppObservability {
  readonly accessLogger: HttpAccessLogger;
  readonly metrics: HttpAccessMetrics;
}

export function isPublicApiPath(pathname: string): boolean {
  return pathname === PUBLIC_API_PATH_PREFIX || pathname.startsWith(`${PUBLIC_API_PATH_PREFIX}/`);
}

function pathnameFromUrl(url: string): string {
  const delimiter = url.search(/[?#]/);
  return delimiter === -1 ? url : url.slice(0, delimiter);
}

export function requestBodyLimitForPath(
  pathname: string,
  limits: Pick<ApiEnv, "PUBLIC_MAX_REQUEST_BODY_BYTES" | "ADMIN_MAX_REQUEST_BODY_BYTES">,
): number {
  if (isPublicApiPath(pathname)) {
    return limits.PUBLIC_MAX_REQUEST_BODY_BYTES;
  }

  return limits.ADMIN_MAX_REQUEST_BODY_BYTES;
}

export const publicApiBodyParserErrorMiddleware: ErrorRequestHandler = (
  error,
  request,
  response,
  next,
): void => {
  if (!isPublicApiPath(pathnameFromUrl(request.originalUrl))) {
    next(error);
    return;
  }

  const mapped = mapBodyParserErrorToGeminiError(error);
  if (mapped === undefined) {
    next(error);
    return;
  }

  response.status(mapped.httpStatus).json(mapped.body);
};

export function configureApp(
  app: NestExpressApplication,
  env: ApiEnv,
  observability?: AppObservability,
): void {
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(requestIdMiddleware);

  if (observability !== undefined) {
    app.use(createHttpAccessLogMiddleware(observability.accessLogger, observability.metrics));
  }

  app.use(helmet());
  app.use(cookieParser());

  // This parser must run before the catch-all parser so public requests use
  // the public API's larger limit instead of the administrative default.
  app.use(
    PUBLIC_API_PATH_PREFIX,
    express.json({ limit: requestBodyLimitForPath(PUBLIC_API_PATH_PREFIX, env) }),
  );
  app.use(express.json({ limit: requestBodyLimitForPath("/", env) }));
  app.use(publicApiBodyParserErrorMiddleware);
}
