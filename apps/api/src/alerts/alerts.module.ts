import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Alert, ApiKey, RequestLog, Upstream } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { CreditsModule } from "../credits/credits.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { AuditModule } from "../audit/audit.module.js";
import { AlertEvaluatorService } from "./alert-evaluator.service.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { NOTIFICATION_CHANNELS_TOKEN } from "./notification-dispatcher.js";
import { AlertScheduler } from "./alert-scheduler.service.js";
import { AlertsAdminController } from "./alerts-admin.controller.js";

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert, ApiKey, Upstream, RequestLog]),
    AdminAuthModule,
    CreditsModule,
    SettingsModule,
    AuditModule,
  ],
  providers: [
    AlertEvaluatorService,
    NotificationDispatcher,
    AlertScheduler,
    {
      provide: NOTIFICATION_CHANNELS_TOKEN,
      // Each new channel (email, Telegram, a webhook) is one more entry here; the rules never change.
      useValue: [],
    },
  ],
  controllers: [AlertsAdminController],
  exports: [AlertEvaluatorService, NotificationDispatcher, AlertScheduler],
})
export class AlertsModule {}