import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import type { AdminAuthenticatedRequest, AdminAuthentication } from "../admin-auth/admin-authentication.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import {
  settingDefinitionViews,
  type SettingDefinitionView,
  type SettingsSnapshot,
} from "./settings.definitions.js";
import { SettingsService } from "./settings.service.js";
import { SpendGuardService, type SpendStatus } from "./spend-guard.service.js";

@Controller("admin/settings")
@UseGuards(AdminSessionGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly spend: SpendGuardService,
  ) {}

  @Get()
  async getAll(): Promise<{ settings: SettingsSnapshot; definitions: SettingDefinitionView[] }> {
    return {
      settings: await this.settings.getAll(),
      definitions: settingDefinitionViews(),
    };
  }

  @Get("spend")
  async spendStatus(): Promise<SpendStatus> {
    return this.spend.status();
  }

  @Put()
  async update(
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() request: AdminAuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ settings: SettingsSnapshot }> {
    const settings = await this.settings.update(body, {
      adminUserId: admin.user.id,
      ipAddress: request.ip ?? null,
    });
    return { settings };
  }
}
