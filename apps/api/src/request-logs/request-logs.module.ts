import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RequestLog } from "@gateway/database";
import { RequestLogService } from "./request-log.service.js";
import { RequestLogRetentionService } from "./request-log-retention.service.js";
import { RetentionPolicy } from "./retention-policy.js";
import { RequestLogRetentionScheduler } from "./request-log-retention.scheduler.js";
import { SettingsModule } from "../settings/settings.module.js";

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([RequestLog]), SettingsModule],
  providers: [
    RequestLogService,
    RequestLogRetentionService,
    RetentionPolicy,
    RequestLogRetentionScheduler,
  ],
  exports: [
    RequestLogService,
    RequestLogRetentionService,
    RetentionPolicy,
  ],
})
export class RequestLogsModule {}