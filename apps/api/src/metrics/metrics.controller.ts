import { createHash, timingSafeEqual } from "node:crypto";
import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";
import { MetricsRegistry } from "./metrics.registry.js";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface MetricsResponse {
  setHeader(name: string, value: string): void;
}

@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly config: ConfigService,
  ) {}

  @Get()
  getMetrics(
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: MetricsResponse,
  ): string {
    const token = this.config.env.METRICS_TOKEN;

    if (token === undefined || token.length === 0) {
      throw new NotFoundException();
    }

    if (!metricsAuthorizationMatches(authorization, token)) {
      throw new UnauthorizedException();
    }

    response.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
    return this.metrics.renderPrometheus();
  }
}

export function metricsAuthorizationMatches(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const candidate = authorization ?? "";
  const expected = `Bearer ${expectedToken}`;

  // Hashing gives timingSafeEqual fixed-size inputs even when a caller sends a
  // malformed Authorization value with a different length from the secret.
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(candidateDigest, expectedDigest);
}
