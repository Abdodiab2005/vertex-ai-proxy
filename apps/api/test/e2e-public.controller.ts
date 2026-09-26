import { Controller, Get, Param, UseGuards, UseFilters, Req } from "@nestjs/common";
import { ApiKeyAuthGuard, ApiKeyAuthenticatedRequest, assertModelAllowed } from "../src/api-keys/api-key-auth.guard.js";
import { GeminiExceptionFilter } from "../src/public-api/gemini-errors.js";

@Controller("v1beta/__e2e")
@UseFilters(GeminiExceptionFilter)
@UseGuards(ApiKeyAuthGuard)
export class E2ePublicController {
  @Get("models/:model")
  testModelAccess(@Param("model") model: string, @Req() req: ApiKeyAuthenticatedRequest) {
    assertModelAllowed(req.apiKey, model);
    return { ok: true };
  }
}
