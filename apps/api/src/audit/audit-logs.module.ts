import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLog } from "@gateway/database";
import { AdminUser } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AuditLogsAdminService } from "./audit-logs-admin.service.js";
import { AuditLogsAdminController } from "./audit-logs-admin.controller.js";

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AdminUser]), AdminAuthModule],
  providers: [AuditLogsAdminService],
  controllers: [AuditLogsAdminController],
  exports: [AuditLogsAdminService],
})
export class AuditLogsModule {}