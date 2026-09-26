import { Controller, Get, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { usageQuerySchema, type UsageQuery } from "./analytics.schemas.js";
import { UsageService, type UsageReport } from "./usage.service.js";

@Controller("admin/usage")
@UseGuards(AdminSessionGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get("export.csv")
  async exportCsv(
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
  ): Promise<StreamableFile> {
    const csv = await this.usage.exportCsv(query);
    return new StreamableFile(Buffer.from(csv, "utf8"), {
      type: "text/csv; charset=utf-8",
      disposition: 'attachment; filename="usage.csv"',
    });
  }

  @Get()
  report(@Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery): Promise<UsageReport> {
    return this.usage.report(query);
  }
}
