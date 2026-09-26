import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Req, HttpCode, HttpStatus } from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import { AdminAuthentication, AdminAuthenticatedRequest } from "../admin-auth/admin-authentication.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { ApiKeysAdminService } from "./api-keys-admin.service.js";
import { 
  CreateApiKeySchema, CreateApiKeyDto, 
  UpdateApiKeySchema, UpdateApiKeyDto, 
  ListApiKeysQuerySchema, ListApiKeysQueryDto,
  AddCreditSchema, AddCreditDto,
  ListCreditsQuerySchema, ListCreditsQueryDto,
  UsageSummaryQuerySchema, UsageSummaryQueryDto,
  BulkCreateApiKeysSchema, BulkCreateApiKeysDto,
} from "./api-keys.schemas.js";

@Controller("admin/api-keys")
@UseGuards(AdminSessionGuard)
export class ApiKeysAdminController {
  constructor(private readonly apiKeysAdminService: ApiKeysAdminService) {}

  @Post()
  createApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateApiKeySchema)) body: CreateApiKeyDto
  ) {
    return this.apiKeysAdminService.createApiKey(admin.user.id, body, req.ip ?? null);
  }

  @Post("bulk")
  bulkCreateApiKeys(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Body(new ZodValidationPipe(BulkCreateApiKeysSchema)) body: BulkCreateApiKeysDto,
  ) {
    return this.apiKeysAdminService.bulkCreateApiKeys(admin.user.id, body, req.ip ?? null);
  }

  @Get()
  listApiKeys(
    @Query(new ZodValidationPipe(ListApiKeysQuerySchema)) query: ListApiKeysQueryDto
  ) {
    return this.apiKeysAdminService.listApiKeys(query);
  }

  @Get(":id")
  getApiKey(@Param("id") id: string) {
    return this.apiKeysAdminService.getApiKey(id);
  }

  @Patch(":id")
  updateApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateApiKeySchema)) body: UpdateApiKeyDto
  ) {
    return this.apiKeysAdminService.updateApiKey(admin.user.id, id, body, req.ip ?? null);
  }

  @Post(":id/suspend")
  suspendApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string
  ) {
    return this.apiKeysAdminService.changeStatus(admin.user.id, id, "suspend", req.ip ?? null);
  }

  @Post(":id/reactivate")
  reactivateApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string
  ) {
    return this.apiKeysAdminService.changeStatus(admin.user.id, id, "reactivate", req.ip ?? null);
  }

  @Post(":id/revoke")
  revokeApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string
  ) {
    return this.apiKeysAdminService.changeStatus(admin.user.id, id, "revoke", req.ip ?? null);
  }

  @Post(":id/regenerate")
  @HttpCode(HttpStatus.OK)
  regenerateApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return this.apiKeysAdminService.regenerateApiKey(admin.user.id, id, req.ip ?? null);
  }

  @Post(":id/reset-counters")
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetCounters(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
  ) {
    await this.apiKeysAdminService.resetCounters(admin.user.id, id, req.ip ?? null);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteApiKey(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
  ) {
    await this.apiKeysAdminService.deleteApiKey(admin.user.id, id, req.ip ?? null);
  }

  @Get(":id/limits-usage")
  getLimitsUsage(@Param("id") id: string) {
    return this.apiKeysAdminService.getLimitsUsage(id);
  }

  @Post(":id/credits")
  addCredit(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AddCreditSchema)) body: AddCreditDto
  ) {
    return this.apiKeysAdminService.addCredit(admin.user.id, id, body, req.ip ?? null);
  }

  @Get(":id/credits")
  listCredits(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(ListCreditsQuerySchema)) query: ListCreditsQueryDto
  ) {
    return this.apiKeysAdminService.listCredits(id, query);
  }

  @Get(":id/usage-summary")
  getUsageSummary(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(UsageSummaryQuerySchema)) query: UsageSummaryQueryDto
  ) {
    return this.apiKeysAdminService.getUsageSummary(id, query);
  }
}
