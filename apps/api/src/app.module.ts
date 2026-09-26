import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { AlertsModule } from "./alerts/alerts.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuditLogsModule } from "./audit/audit-logs.module.js";
import { AdminAuthModule } from "./admin-auth/admin-auth.module.js";
import { AdminDashboardModule } from "./admin-dashboard/admin-dashboard.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { ApiKeysModule } from "./api-keys/api-keys.module.js";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { ModelsModule } from "./models/models.module.js";
import { PublicApiModule } from "./public-api/public-api.module.js";
import { RateLimitsModule } from "./rate-limits/rate-limits.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { RequestLogsModule } from "./request-logs/request-logs.module.js";
import { RequestLogsAdminModule } from "./request-logs/request-logs-admin.module.js";
import { SecurityModule } from "./security/security.module.js";
import { UpstreamsModule } from "./upstreams/upstreams.module.js";
import { CreditsModule } from "./credits/credits.module.js";
import { MetricsModule } from "./metrics/metrics.module.js";
import { LifecycleModule } from "./lifecycle/lifecycle.module.js";

@Module({
  imports: [
    ConfigModule,
    LifecycleModule,
    MetricsModule,
    DatabaseModule,
    RedisModule,
    SecurityModule,
    AuditModule,
    AuditLogsModule,
    AdminAuthModule,
    AdminDashboardModule,
    AnalyticsModule,
    ApiKeysModule,
    ModelsModule,
    SettingsModule,
    PublicApiModule,
    UpstreamsModule,
    RateLimitsModule,
    CreditsModule,
    RequestLogsModule,
    RequestLogsAdminModule,
    AlertsModule,
  ],


  controllers: [AppController],
})
export class AppModule {}
