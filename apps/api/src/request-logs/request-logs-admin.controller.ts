import { Controller, Get, Query, UseGuards, BadRequestException, Res } from "@nestjs/common";
import type { Response } from "express";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RequestLogsAdminService } from "./request-logs-admin.service.js";
import {
  ListRequestLogsQuerySchema,
  type ListRequestLogsQueryDto,
  type ListRequestLogsResponse,
} from "./request-logs.schemas.js";

@Controller("admin/request-logs")
@UseGuards(AdminSessionGuard)
export class RequestLogsAdminController {
  constructor(private readonly requestLogsAdminService: RequestLogsAdminService) {}

  @Get()
  async listRequestLogs(
    @Query(new ZodValidationPipe(ListRequestLogsQuerySchema)) query: ListRequestLogsQueryDto,
  ): Promise<ListRequestLogsResponse> {
    try {
      return await this.requestLogsAdminService.listRequestLogs(query);
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid cursor") {
        throw new BadRequestException("Invalid cursor");
      }
      throw err;
    }
  }

  @Get("export.csv")
  async exportRequestLogs(
    @Query(new ZodValidationPipe(ListRequestLogsQuerySchema)) query: ListRequestLogsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const csv = await this.requestLogsAdminService.exportRequestLogsCsv(query);

      const date = new Date().toISOString().slice(0, 10);
      const filename = `request-logs-${date}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid cursor") {
        throw new BadRequestException("Invalid cursor");
      }
      throw err;
    }
  }
}