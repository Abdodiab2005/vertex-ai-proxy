import { Module } from "@nestjs/common";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AnalyticsClock } from "./analytics-clock.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { UsageController } from "./usage.controller.js";
import { UsageService } from "./usage.service.js";

@Module({
  imports: [AdminAuthModule],
  controllers: [AnalyticsController, UsageController],
  providers: [AnalyticsClock, AnalyticsService, UsageService],
})
export class AnalyticsModule {}
