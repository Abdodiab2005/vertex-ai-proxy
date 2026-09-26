import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RequestLog } from "@gateway/database";
import { ApiKey } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { RequestLogsAdminService } from "./request-logs-admin.service.js";
import { RequestLogsAdminController } from "./request-logs-admin.controller.js";

@Module({
  imports: [TypeOrmModule.forFeature([RequestLog, ApiKey]), AdminAuthModule],
  providers: [RequestLogsAdminService],
  controllers: [RequestLogsAdminController],
  exports: [RequestLogsAdminService],
})
export class RequestLogsAdminModule {}