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
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import {
  AdminAuthentication,
  AdminAuthenticatedRequest,
} from "../admin-auth/admin-authentication.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { KeyPresetsAdminService, type KeyPresetView } from "./key-presets-admin.service.js";
import {
  CreateKeyPresetSchema,
  UpdateKeyPresetSchema,
  type CreateKeyPresetDto,
  type UpdateKeyPresetDto,
} from "./key-presets.schemas.js";

@Controller("admin/key-presets")
@UseGuards(AdminSessionGuard)
export class KeyPresetsAdminController {
  constructor(private readonly presets: KeyPresetsAdminService) {}

  @Get()
  list(): Promise<{ presets: KeyPresetView[] }> {
    return this.presets.list().then((presets) => ({ presets }));
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ preset: KeyPresetView }> {
    return { preset: await this.presets.get(id) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Body(new ZodValidationPipe(CreateKeyPresetSchema)) body: CreateKeyPresetDto,
  ): Promise<{ preset: KeyPresetView }> {
    return { preset: await this.presets.create(admin.user.id, body, req.ip ?? null) };
  }

  @Patch(":id")
  async update(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateKeyPresetSchema)) body: UpdateKeyPresetDto,
  ): Promise<{ preset: KeyPresetView }> {
    return { preset: await this.presets.update(admin.user.id, id, body, req.ip ?? null) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() req: AdminAuthenticatedRequest,
    @Param("id") id: string,
  ): Promise<void> {
    await this.presets.delete(admin.user.id, id, req.ip ?? null);
  }
}
