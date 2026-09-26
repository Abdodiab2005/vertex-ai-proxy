import type { LoggerService } from "@nestjs/common";
import { ConsoleLogger } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  createApplicationLogger,
  JsonLogger,
  type LogDestination,
} from "./json-logger.js";

class CapturedDestination implements LogDestination {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  eventAt(index: number): Record<string, unknown> {
    return JSON.parse(this.chunks[index]!) as Record<string, unknown>;
  }
}

describe("JsonLogger", () => {
  it("writes one structured JSON line and omits sensitive metadata", () => {
    const stdout = new CapturedDestination();
    const stderr = new CapturedDestination();
    const logger = new JsonLogger({
      stdout,
      stderr,
      clock: () => new Date("2026-09-25T10:00:00.000Z"),
    });

    logger.logStructured(
      "request completed",
      {
        requestId: "request-123",
        route: "/v1beta/models",
        headers: { authorization: "secret" },
        body: { prompt: "private" },
      },
      "Gateway",
    );

    expect(stdout.chunks).toHaveLength(1);
    expect(stderr.chunks).toHaveLength(0);
    expect(stdout.chunks[0]).toMatch(/\n$/);
    expect(stdout.eventAt(0)).toEqual({
      time: "2026-09-25T10:00:00.000Z",
      level: "log",
      context: "Gateway",
      message: "request completed",
      requestId: "request-123",
      route: "/v1beta/models",
    });
  });

  it("logs errors to stderr without a stack unless explicitly enabled", () => {
    const stdout = new CapturedDestination();
    const stderr = new CapturedDestination();
    const error = new Error("upstream failed");
    const logger = new JsonLogger({ stdout, stderr });

    logger.error(error, { requestId: "request-456" }, "Upstream");

    expect(stdout.chunks).toHaveLength(0);
    expect(stderr.eventAt(0)).toMatchObject({
      level: "error",
      context: "Upstream",
      message: "upstream failed",
      requestId: "request-456",
      error: {
        name: "Error",
        message: "upstream failed",
      },
    });
    expect(stderr.eventAt(0)).not.toHaveProperty("stack");
  });

  it("gives string error calls an error shape without retaining their stack", () => {
    const stderr = new CapturedDestination();
    const logger = new JsonLogger({ stderr });

    logger.error("cache failed", "stack details", "Cache");

    expect(stderr.eventAt(0)).toMatchObject({
      level: "error",
      context: "Cache",
      message: "cache failed",
      error: {
        name: "Error",
        message: "cache failed",
      },
    });
    expect(stderr.eventAt(0)).not.toHaveProperty("stack");
  });

  it("does not mistake a Nest-style error stack for a logging context", () => {
    const stderr = new CapturedDestination();
    const logger = new JsonLogger({ stderr, defaultContext: "Default" });
    const stack = "Error: cache failed\n    at cache.ts:12:4";

    logger.error("cache failed", stack);

    expect(stderr.eventAt(0)).toMatchObject({
      context: "Default",
      message: "cache failed",
      error: {
        name: "Error",
        message: "cache failed",
      },
    });
    expect(stderr.eventAt(0)).not.toHaveProperty("stack");
    expect(JSON.stringify(stderr.eventAt(0))).not.toContain(stack);
  });

  it("uses Nest's ConsoleLogger for pretty output", () => {
    const logger: LoggerService = createApplicationLogger({
      LOG_FORMAT: "pretty",
      LOG_INCLUDE_STACK: false,
    });

    expect(logger).toBeInstanceOf(ConsoleLogger);
  });
});
