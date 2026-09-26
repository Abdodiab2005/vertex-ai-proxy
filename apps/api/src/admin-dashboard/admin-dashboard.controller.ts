import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { AdminDashboardService, type AdminDashboardSummary } from "./admin-dashboard.service.js";

@Controller("admin/dashboard")
@UseGuards(AdminSessionGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get("summary")
  getSummary(): Promise<AdminDashboardSummary> {
    return this.dashboard.summary();
  }
}
