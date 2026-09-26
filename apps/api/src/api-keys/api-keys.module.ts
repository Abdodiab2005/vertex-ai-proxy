import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ApiKey, CreditTransaction, KeyPreset, UsageRecord } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ApiKeysAdminController } from "./api-keys-admin.controller.js";
import { ApiKeysAdminService } from "./api-keys-admin.service.js";
import { KeyPresetsAdminController } from "./key-presets-admin.controller.js";
import { KeyPresetsAdminService } from "./key-presets-admin.service.js";
import { CreditsModule } from "../credits/credits.module.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey, CreditTransaction, UsageRecord, KeyPreset]),
    AdminAuthModule,
    AuditModule,
    SettingsModule,
    CreditsModule,
  ],
  controllers: [ApiKeysAdminController, KeyPresetsAdminController],
  providers: [ApiKeysAdminService, KeyPresetsAdminService],
  exports: [TypeOrmModule],
})
export class ApiKeysModule {}
