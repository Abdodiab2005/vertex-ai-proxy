import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ConfigService } from "../config/config.service.js";
import {
  MetricsController,
  PROMETHEUS_CONTENT_TYPE,
  metricsAuthorizationMatches,
} from "./metrics.controller.js";
import { MetricsRegistry } from "./metrics.registry.js";

class ResponseRecorder {
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(",") : String(value));
    return this;
  }
}

async function controllerFor(token: string | undefined): Promise<MetricsController> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [MetricsController],
    providers: [
      MetricsRegistry,
      {
        provide: ConfigService,
        useValue: { env: { METRICS_TOKEN: token } },
      },
    ],
  }).compile();

  return moduleRef.get(MetricsController);
}

describe("MetricsController", () => {
  it.each([undefined, ""])(
    "returns 404 when metrics have not been configured",
    async (token) => {
      const controller = await controllerFor(token);

      expect(() => controller.getMetrics(undefined, new ResponseRecorder())).toThrow(
        NotFoundException,
      );
    },
  );

  it("returns 401 for an incorrect bearer token", async () => {
    const controller = await controllerFor("metrics-token-1234");

    expect(() =>
      controller.getMetrics("Bearer incorrect-token", new ResponseRecorder()),
    ).toThrow(UnauthorizedException);
  });

  it("returns the Prometheus document for a valid bearer token", async () => {
    const controller = await controllerFor("metrics-token-1234");
    const response = new ResponseRecorder();

    const body = controller.getMetrics("Bearer metrics-token-1234", response);

    expect(body).toContain("# TYPE gateway_http_requests_total counter");
    expect(response.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
  });
});

describe("metricsAuthorizationMatches", () => {
  it.each([
    ["Bearer metrics-token-1234", true],
    ["bearer metrics-token-1234", false],
    ["Bearer metrics-token-12345", false],
    [undefined, false],
  ])("accepts only the exact Bearer value", (authorization, expected) => {
    expect(metricsAuthorizationMatches(authorization, "metrics-token-1234")).toBe(expected);
  });
});
