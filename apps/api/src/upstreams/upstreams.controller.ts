import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import type { AdminAuthentication } from "../admin-auth/admin-authentication.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import type { UpstreamView } from "./upstream-view.js";
import {
  createUpstreamSchema,
  patchUpstreamSchema,
  testUpstreamSchema,
  type CreateUpstreamInput,
  type PatchUpstreamInput,
  type TestUpstreamInput,
} from "./upstreams.schemas.js";
import {
  UpstreamsService,
  type AuditActor,
  type UpstreamTestResult,
} from "./upstreams.service.js";

@Controller("admin/upstreams")
@UseGuards(AdminSessionGuard)
export class UpstreamsController {
  constructor(private readonly upstreams: UpstreamsService) {}

  @Get()
  async list(): Promise<{ upstreams: UpstreamView[] }> {
    return { upstreams: await this.upstreams.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ upstream: UpstreamView }> {
    return { upstream: await this.upstreams.get(id) };
  }

  @Post()
  async create(
    @CurrentAdmin() admin: AdminAuthentication,
    @Body(new ZodValidationPipe(createUpstreamSchema)) body: CreateUpstreamInput,
    @Req() request: Request,
  ): Promise<{ upstream: UpstreamView }> {
    return { upstream: await this.upstreams.create(body, actor(admin, request)) };
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @CurrentAdmin() admin: AdminAuthentication,
    @Body(new ZodValidationPipe(patchUpstreamSchema)) body: PatchUpstreamInput,
    @Req() request: Request,
  ): Promise<{ upstream: UpstreamView }> {
    return { upstream: await this.upstreams.update(id, body, actor(admin, request)) };
  }

  @Post(":id/test")
  @HttpCode(HttpStatus.OK)
  async test(
    @Param("id") id: string,
    @CurrentAdmin() admin: AdminAuthentication,
    @Body(new ZodValidationPipe(testUpstreamSchema)) body: TestUpstreamInput,
    @Req() request: Request,
  ): Promise<UpstreamTestResult> {
    return this.upstreams.test(id, body.model, actor(admin, request));
  }
}

function actor(admin: AdminAuthentication, request: Request): AuditActor {
  return {
    adminUserId: admin.user.id,
    ipAddress: request.ip || null,
  };
}
