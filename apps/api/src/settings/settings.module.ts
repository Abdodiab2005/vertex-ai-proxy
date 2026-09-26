import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CreditTransaction, SystemSetting } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { GatewayAvailabilityGuard } from "./gateway-availability.guard.js";
import { SettingsController } from "./settings.controller.js";
import { SettingsService } from "./settings.service.js";
import { SpendGuardService } from "./spend-guard.service.js";

@Module({
  imports: [AdminAuthModule, TypeOrmModule.forFeature([SystemSetting, CreditTransaction])],
  controllers: [SettingsController],
  providers: [SettingsService, SpendGuardService, GatewayAvailabilityGuard],
  exports: [SettingsService, SpendGuardService, GatewayAvailabilityGuard],
})
export class SettingsModule {}
