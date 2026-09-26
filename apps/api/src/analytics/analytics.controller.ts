import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AnalyticsService, type AnalyticsOverview, type AnalyticsTimeseries } from "./analytics.service.js";
import {
  overviewQuerySchema,
  timeseriesQuerySchema,
  type OverviewQuery,
  type TimeseriesQuery,
} from "./analytics.schemas.js";

@Controller("admin/analytics")
@UseGuards(AdminSessionGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  overview(
    @Query(new ZodValidationPipe(overviewQuerySchema)) query: OverviewQuery,
  ): Promise<AnalyticsOverview> {
    return this.analytics.overview(query);
  }

  @Get("timeseries")
  timeseries(
    @Query(new ZodValidationPipe(timeseriesQuerySchema)) query: TimeseriesQuery,
  ): Promise<AnalyticsTimeseries> {
    return this.analytics.timeseries(query);
  }
}
