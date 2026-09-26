import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import type {
  HttpAccessLogger,
  HttpAccessMetrics,
  HttpAccessMetricLabels,
} from "./http-access-log.middleware.js";
import { createHttpAccessLogMiddleware } from "./http-access-log.middleware.js";

class RecordedMetrics implements HttpAccessMetrics {
  activeIncrements = 0;
  activeDecrements = 0;
  readonly requests: Array<{
    labels: HttpAccessMetricLabels;
    durationSeconds: number;
  }> = [];

  incrementActiveRequests(): void {
    this.activeIncrements += 1;
  }

  decrementActiveRequests(): void {
    this.activeDecrements += 1;
  }

  recordHttpRequest(labels: HttpAccessMetricLabels, durationSeconds: number): void {
    this.requests.push({ labels, durationSeconds });
  }
}

function responseWithStatus(statusCode: number): Response {
  return Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
}

describe("HTTP access logging", () => {
  it("logs only the path, never a query string", () => {
    const lines: string[] = [];
    const logger: HttpAccessLogger = {
      log: (message: unknown): void => {
        lines.push(String(message));
      },
    };
    const metrics = new RecordedMetrics();
    const request = {
      method: "GET",
      originalUrl: "/v1beta/models?key=private-api-key&debug=true",
      url: "/v1beta/models?key=private-api-key&debug=true",
      requestId: "request-789",
      apiKey: { keyPrefix: "lvg_safe" },
    } as unknown as Request;
    const response = responseWithStatus(200);
    let currentTime = 0n;
    const middleware = createHttpAccessLogMiddleware(logger, metrics, {
      monotonicNow: () => {
        currentTime += 25_000_000n;
        return currentTime;
      },
    });

    let nextCalls = 0;
    middleware(request, response, () => {
      nextCalls += 1;
    });
    response.emit("finish");

    expect(nextCalls).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private-api-key");
    expect(JSON.parse(lines[0]!)).toEqual({
      requestId: "request-789",
      method: "GET",
      path: "/v1beta/models",
      status: 200,
      durationMs: 25,
      apiKeyPrefix: "lvg_safe",
    });
    expect(metrics.activeIncrements).toBe(1);
    expect(metrics.activeDecrements).toBe(1);
    expect(metrics.requests).toEqual([
      {
        labels: { routeGroup: "public", statusClass: "2xx" },
        durationSeconds: 0.025,
      },
    ]);
  });
});
