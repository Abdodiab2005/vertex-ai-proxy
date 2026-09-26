import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import type { AdminAuthentication } from "../admin-auth/admin-authentication.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import {
  addAliasSchema,
  addPricingRuleSchema,
  createModelSchema,
  listModelsQuerySchema,
  syncModelsSchema,
  updateModelRoutesSchema,
  updateModelSchema,
  type AddAliasInput,
  type AddPricingRuleInput,
  type CreateModelInput,
  type ListModelsQuery,
  type SyncModelsInput,
  type UpdateModelInput,
  type UpdateModelRoutesInput,
} from "./models.schemas.js";
import { ModelsService, type ModelMutationActor } from "./models.service.js";
import type { ModelSyncSummary } from "./model-sync-plan.js";
import type { ModelRoutesView, ModelView, PricingRuleView } from "./model-view.js";

@Controller("admin/models")
@UseGuards(AdminSessionGuard)
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listModelsQuerySchema)) query: ListModelsQuery,
  ): Promise<{ models: ModelView[] }> {
    return { models: await this.models.list(query) };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ model: ModelView }> {
    return { model: await this.models.get(id) };
  }

  @Post("sync")
  @HttpCode(HttpStatus.OK)
  async sync(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Body(new ZodValidationPipe(syncModelsSchema)) body: SyncModelsInput,
    @Req() request: Request,
  ): Promise<{ summary: ModelSyncSummary }> {
    return { summary: await this.models.sync(body.upstreamId, actorFrom(authentication, request)) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Body(new ZodValidationPipe(createModelSchema)) body: CreateModelInput,
    @Req() request: Request,
  ): Promise<{ model: ModelView }> {
    return { model: await this.models.create(body, actorFrom(authentication, request)) };
  }

  @Patch(":id")
  async update(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateModelSchema)) body: UpdateModelInput,
    @Req() request: Request,
  ): Promise<{ model: ModelView }> {
    return { model: await this.models.update(id, body, actorFrom(authentication, request)) };
  }

  @Post(":id/aliases")
  @HttpCode(HttpStatus.CREATED)
  async addAlias(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(addAliasSchema)) body: AddAliasInput,
    @Req() request: Request,
  ): Promise<{ model: ModelView }> {
    return { model: await this.models.addAlias(id, body.alias, actorFrom(authentication, request)) };
  }

  @Delete(":id/aliases/:alias")
  async removeAlias(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Param("alias") alias: string,
    @Req() request: Request,
  ): Promise<{ model: ModelView }> {
    return { model: await this.models.removeAlias(id, alias, actorFrom(authentication, request)) };
  }

  @Get(":id/pricing")
  async listPricing(@Param("id") id: string): Promise<{ rules: PricingRuleView[] }> {
    return { rules: await this.models.listPricing(id) };
  }

  @Post(":id/pricing")
  @HttpCode(HttpStatus.CREATED)
  async addPricingRule(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(addPricingRuleSchema)) body: AddPricingRuleInput,
    @Req() request: Request,
  ): Promise<{ rules: PricingRuleView[] }> {
    return { rules: await this.models.addPricingRule(id, body, actorFrom(authentication, request)) };
  }

  @Delete(":id/pricing/:ruleId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePricingRule(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Param("ruleId") ruleId: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.models.deletePricingRule(id, ruleId, actorFrom(authentication, request));
  }

  @Get(":id/routes")
  async getRoutes(@Param("id") id: string): Promise<ModelRoutesView> {
    return this.models.getRoutes(id);
  }

  @Put(":id/routes")
  @HttpCode(HttpStatus.OK)
  async updateRoutes(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateModelRoutesSchema)) body: UpdateModelRoutesInput,
    @Req() request: Request,
  ): Promise<ModelRoutesView> {
    return this.models.updateRoutes(id, body, actorFrom(authentication, request));
  }
}

function actorFrom(authentication: AdminAuthentication, request: Request): ModelMutationActor {
  return {
    adminUserId: authentication.user.id,
    ipAddress: request.ip || null,
  };
}
