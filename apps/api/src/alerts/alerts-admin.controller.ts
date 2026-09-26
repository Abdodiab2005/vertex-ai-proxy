import { Controller, Get, Post, Param, Query, Req, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { CurrentAdmin } from "../admin-auth/current-admin.decorator.js";
import { AdminAuthentication } from "../admin-auth/admin-authentication.js";
import { AlertEvaluatorService } from "./alert-evaluator.service.js";
import { AlertScheduler } from "./alert-scheduler.service.js";
import {
  ListAlertsQuerySchema,
  type ListAlertsQueryDto,
  AcknowledgeAlertParamsSchema,
  type AcknowledgeAlertParamsDto,
  type AlertsListResponse,
  type EvaluateAlertsResponse,
} from "./alerts.schemas.js";

@Controller("admin/alerts")
@UseGuards(AdminSessionGuard)
export class AlertsAdminController {
  constructor(
    private readonly evaluator: AlertEvaluatorService,
    private readonly scheduler: AlertScheduler,
  ) {}

  @Get()
  async listAlerts(
    @Query(new ZodValidationPipe(ListAlertsQuerySchema)) query: ListAlertsQueryDto,
  ): Promise<AlertsListResponse> {
    return this.evaluator.listAlerts(query.status, query.limit);
  }

  @Post(":id/acknowledge")
  @HttpCode(HttpStatus.NO_CONTENT)
  async acknowledgeAlert(
    @Param(new ZodValidationPipe(AcknowledgeAlertParamsSchema)) params: AcknowledgeAlertParamsDto,
    @CurrentAdmin() admin: AdminAuthentication,
    @Req() request: Request,
  ): Promise<void> {
    await this.evaluator.acknowledge(params.id, { adminUserId: admin.user.id, ipAddress: request.ip ?? null });
  }

  @Post("evaluate")
  async evaluateAlerts(): Promise<EvaluateAlertsResponse> {
    return this.scheduler.runNow();
  }
}