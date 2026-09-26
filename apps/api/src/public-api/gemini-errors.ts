import { HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, Logger } from "@nestjs/common";
import type { Response } from "express";

export interface GeminiErrorBody {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

export interface PublicBodyParserErrorMapping {
  httpStatus: 400 | 413 | 415;
  body: GeminiErrorBody;
}

function createGeminiErrorBody(
  httpCode: number,
  googleStatus: string,
  message: string,
): GeminiErrorBody {
  return {
    error: {
      code: httpCode,
      message,
      status: googleStatus,
    },
  };
}

/**
 * Express invokes error middleware outside Nest's exception-filter pipeline,
 * so parser failures need a small, framework-independent translation first.
 */
export function mapBodyParserErrorToGeminiError(
  error: unknown,
): PublicBodyParserErrorMapping | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return undefined;
  }

  const { type } = error;
  if (typeof type !== "string") {
    return undefined;
  }

  switch (type) {
    case "entity.too.large":
      return {
        httpStatus: 413,
        body: createGeminiErrorBody(
          413,
          "INVALID_ARGUMENT",
          "Request payload size exceeds the limit.",
        ),
      };
    case "entity.parse.failed":
      return {
        httpStatus: 400,
        body: createGeminiErrorBody(400, "INVALID_ARGUMENT", "Invalid JSON payload received."),
      };
    case "charset.unsupported":
    case "encoding.unsupported":
      return {
        httpStatus: 415,
        body: createGeminiErrorBody(
          415,
          "INVALID_ARGUMENT",
          "Unsupported request encoding or charset.",
        ),
      };
    default:
      return undefined;
  }
}

export class GeminiApiException extends HttpException {
  constructor(
    httpCode: number,
    googleStatus: string,
    message: string,
    /** Sent as Retry-After so clients back off for as long as the limit actually lasts. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(
      createGeminiErrorBody(httpCode, googleStatus, message),
      httpCode,
    );
  }
}

@Catch()
export class GeminiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GeminiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof GeminiApiException) {
      if (exception.retryAfterSeconds !== null) {
        response.setHeader("Retry-After", String(exception.retryAfterSeconds));
      }
      response
        .status(exception.getStatus())
        .json(exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const googleStatus = this.mapHttpStatusToGoogleStatus(status);
      
      let finalMessage = exception.message;
      const nestResponse = exception.getResponse();
      if (typeof nestResponse === "object" && nestResponse !== null && "message" in nestResponse) {
        const msg = (nestResponse as Record<string, unknown>).message;
        if (typeof msg === "string") {
          finalMessage = msg;
        } else if (Array.isArray(msg) && msg.every((m) => typeof m === "string")) {
          finalMessage = msg.join("; ");
        }
      }
      
      const mappedException = new GeminiApiException(
        status,
        googleStatus,
        finalMessage,
      );
      
      response
        .status(status)
        .json(mappedException.getResponse());
      return;
    }

    this.logger.error(
      `Unhandled exception in public API: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    const internalError = new GeminiApiException(
      HttpStatus.INTERNAL_SERVER_ERROR,
      "INTERNAL",
      "Internal error.",
    );

    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(internalError.getResponse());
  }

  private mapHttpStatusToGoogleStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return "INVALID_ARGUMENT";
      case HttpStatus.UNAUTHORIZED:
        return "UNAUTHENTICATED";
      case HttpStatus.FORBIDDEN:
        return "PERMISSION_DENIED";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.TOO_MANY_REQUESTS:
        return "RESOURCE_EXHAUSTED";
      case HttpStatus.SERVICE_UNAVAILABLE:
        return "UNAVAILABLE";
      default:
        return "INTERNAL";
    }
  }
}
