import { describe, expect, it, vi } from "vitest";
import {
  GeminiApiException,
  GeminiExceptionFilter,
  mapBodyParserErrorToGeminiError,
} from "./gemini-errors.js";
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";

describe("mapBodyParserErrorToGeminiError", () => {
  it.each([
    [
      "entity.too.large",
      {
        httpStatus: 413,
        body: {
          error: {
            code: 413,
            message: "Request payload size exceeds the limit.",
            status: "INVALID_ARGUMENT",
          },
        },
      },
    ],
    [
      "entity.parse.failed",
      {
        httpStatus: 400,
        body: {
          error: {
            code: 400,
            message: "Invalid JSON payload received.",
            status: "INVALID_ARGUMENT",
          },
        },
      },
    ],
    [
      "charset.unsupported",
      {
        httpStatus: 415,
        body: {
          error: {
            code: 415,
            message: "Unsupported request encoding or charset.",
            status: "INVALID_ARGUMENT",
          },
        },
      },
    ],
    [
      "encoding.unsupported",
      {
        httpStatus: 415,
        body: {
          error: {
            code: 415,
            message: "Unsupported request encoding or charset.",
            status: "INVALID_ARGUMENT",
          },
        },
      },
    ],
  ])("maps %s to a Gemini error body", (type, expected) => {
    expect(mapBodyParserErrorToGeminiError({ type })).toEqual(expected);
  });

  it("leaves unrelated errors for the downstream Express error handler", () => {
    expect(mapBodyParserErrorToGeminiError({ type: "request.aborted" })).toBeUndefined();
    expect(mapBodyParserErrorToGeminiError(new Error("unrelated"))).toBeUndefined();
    expect(mapBodyParserErrorToGeminiError(null)).toBeUndefined();
  });
});

describe("GeminiExceptionFilter", () => {
  it("serializes GeminiApiException as-is", () => {
    const filter = new GeminiExceptionFilter();
    const exception = new GeminiApiException(403, "PERMISSION_DENIED", "Custom message");
    
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 403,
        message: "Custom message",
        status: "PERMISSION_DENIED",
      },
    });
  });

  describe("maps HttpExceptions", () => {
    const testCases = [
      { httpCode: HttpStatus.BAD_REQUEST, expectedStatus: "INVALID_ARGUMENT" },
      { httpCode: HttpStatus.UNAUTHORIZED, expectedStatus: "UNAUTHENTICATED" },
      { httpCode: HttpStatus.FORBIDDEN, expectedStatus: "PERMISSION_DENIED" },
      { httpCode: HttpStatus.NOT_FOUND, expectedStatus: "NOT_FOUND" },
      { httpCode: HttpStatus.TOO_MANY_REQUESTS, expectedStatus: "RESOURCE_EXHAUSTED" },
      { httpCode: HttpStatus.SERVICE_UNAVAILABLE, expectedStatus: "UNAVAILABLE" },
      { httpCode: HttpStatus.I_AM_A_TEAPOT, expectedStatus: "INTERNAL" },
    ];

    testCases.forEach(({ httpCode, expectedStatus }) => {
      it(`maps ${httpCode} to ${expectedStatus}`, () => {
        const filter = new GeminiExceptionFilter();
        const exception = new HttpException("Some generic error", httpCode);
        
        const response = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        } as unknown as Response;
        
        const host = {
          switchToHttp: () => ({
            getResponse: () => response,
          }),
        } as ArgumentsHost;

        filter.catch(exception, host);

        expect(response.status).toHaveBeenCalledWith(httpCode);
        expect(response.json).toHaveBeenCalledWith({
          error: {
            code: httpCode,
            message: "Some generic error",
            status: expectedStatus,
          },
        });
      });
    });

    it("extracts message from HttpException response object", () => {
      const filter = new GeminiExceptionFilter();
      const exception = new HttpException({ message: "Detailed object error" }, HttpStatus.BAD_REQUEST);
      
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
      const host = { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost;

      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith({
        error: {
          code: 400,
          message: "Detailed object error",
          status: "INVALID_ARGUMENT",
        },
      });
    });

    it("joins message array from ZodValidationPipe 400s", () => {
      const filter = new GeminiExceptionFilter();
      const exception = new HttpException({ message: ["name: Invalid", "email: Required"] }, HttpStatus.BAD_REQUEST);
      
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
      const host = { switchToHttp: () => ({ getResponse: () => response }) } as ArgumentsHost;

      filter.catch(exception, host);

      expect(response.json).toHaveBeenCalledWith({
        error: {
          code: 400,
          message: "name: Invalid; email: Required",
          status: "INVALID_ARGUMENT",
        },
      });
    });
  });

  it("masks generic unhandled errors as 500 INTERNAL", () => {
    const filter = new GeminiExceptionFilter();
    const exception = new Error("Database explosion");
    
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 500,
        message: "Internal error.",
        status: "INTERNAL",
      },
    });
  });
});
