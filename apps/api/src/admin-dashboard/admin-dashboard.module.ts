import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ApiKey, Model, Upstream, UsageRecord } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { AdminDashboardController } from "./admin-dashboard.controller.js";
import { AdminDashboardService } from "./admin-dashboard.service.js";

@Module({
  imports: [AdminAuthModule, TypeOrmModule.forFeature([ApiKey, Upstream, Model, UsageRecord])],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService],
})
export class AdminDashboardModule {}
