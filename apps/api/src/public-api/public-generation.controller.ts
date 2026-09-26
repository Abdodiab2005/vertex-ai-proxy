import { Controller, Post, Param, Body, UseGuards, UseFilters, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiKeyAuthGuard, ApiKeyAuthenticatedRequest, assertEndpointAllowed } from "../api-keys/api-key-auth.guard.js";
import { GatewayAvailabilityGuard } from "../settings/gateway-availability.guard.js";
import { GeminiExceptionFilter, GeminiApiException } from "./gemini-errors.js";
import { PublicGenerationService } from "./public-generation.service.js";
import { getRequestId } from "../observability/request-id.js";
import { parseModelAction } from "./gemini/model-path.js";
import { UpstreamInputError } from "../upstreams/providers/upstream-errors.js";
import { InFlightRequests } from "../lifecycle/in-flight-requests.js";

@Controller("v1beta/models")
@UseFilters(GeminiExceptionFilter)
@UseGuards(GatewayAvailabilityGuard, ApiKeyAuthGuard)
export class PublicGenerationController {
  constructor(
    private readonly generation: PublicGenerationService,
    private readonly inFlight: InFlightRequests
  ) {}

  @Post(":modelAction")
  async handleModelAction(
    @Req() req: ApiKeyAuthenticatedRequest,
    @Param("modelAction") modelAction: string,
    @Body() body: unknown,
    @Res() res: Response
  ) {
    const parsed = parseModelAction(modelAction);
    if (!parsed) {
      throw new GeminiApiException(404, "NOT_FOUND", "Not found.");
    }

    // Without alt=sse the Gemini API streams a JSON array instead; answering that differently than
    // asked would break clients silently, so it's rejected outright.
    if (parsed.action === "streamGenerateContent" && req.query.alt !== "sse") {
      throw new GeminiApiException(400, "INVALID_ARGUMENT", "Only alt=sse streaming is supported.");
    }

    assertEndpointAllowed(req.apiKey, parsed.action);

    if (this.inFlight.draining) {
      throw new GeminiApiException(503, "UNAVAILABLE", "The gateway is restarting. Please retry.");
    }

    // The same id the request-id middleware returns as x-request-id, so a client-reported
    // id finds the usage record and request log.
    const requestId = getRequestId(req);
    
    const ac = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) {
        ac.abort();
      }
    };
    res.on("close", onResClose);
    const untrack = this.inFlight.track(ac);

    try {
      if (parsed.action === "streamGenerateContent") {
        await this.generation.processStream(req.apiKey, parsed.model, body, req, res, ac.signal, requestId);
        return;
      }
      const responseBody = await this.generation.process(
        req.apiKey,
        parsed.model,
        parsed.action,
        body,
        req,
        ac.signal,
        requestId
      );
      return res.status(200).json(responseBody);
    } catch (error) {
      if (error instanceof UpstreamInputError) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", error.message);
      }
      throw error;
    } finally {
      res.off("close", onResClose);
      untrack();
    }
  }
}
