import { Controller, Get, Query, UseGuards, BadRequestException } from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AuditLogsAdminService } from "./audit-logs-admin.service.js";
import {
  ListAuditLogsQuerySchema,
  type ListAuditLogsQueryDto,
  type ListAuditLogsResponse,
  type AuditActionsResponse,
} from "./audit-logs.schemas.js";

@Controller("admin/audit-logs")
@UseGuards(AdminSessionGuard)
export class AuditLogsAdminController {
  constructor(private readonly auditLogsAdminService: AuditLogsAdminService) {}

  @Get()
  async listAuditLogs(
    @Query(new ZodValidationPipe(ListAuditLogsQuerySchema)) query: ListAuditLogsQueryDto,
  ): Promise<ListAuditLogsResponse> {
    try {
      return await this.auditLogsAdminService.listAuditLogs(query);
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid cursor") {
        throw new BadRequestException("Invalid cursor");
      }
      throw err;
    }
  }

  @Get("actions")
  async getActions(): Promise<AuditActionsResponse> {
    return this.auditLogsAdminService.getDistinctActions();
  }
}