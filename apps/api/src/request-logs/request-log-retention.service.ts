import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RequestLog } from "@gateway/database";
import { RetentionPolicy } from "./retention-policy.js";

@Injectable()
export class RequestLogRetentionService {
  private readonly logger = new Logger(RequestLogRetentionService.name);

  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogs: Repository<RequestLog>,
    private readonly retentionPolicy: RetentionPolicy,
  ) {}

  /**
   * Purges request logs older than the configured retention period.
   *
   * Deletes in batches of 5000 until no more rows are deleted.
   * Returns the total number of deleted rows.
   *
   * If retention is null (keep forever), returns 0 without deleting.
   */
  async purgeOlderThan(): Promise<number> {
    const retentionDays = await this.retentionPolicy.getDays();

    if (retentionDays === null) {
      this.logger.debug("Request log retention is disabled (null = keep forever)");
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const batchSize = 5000;
    let totalDeleted = 0;

    // Delete in batches to avoid long-running transactions and lock contention
    // Use a CTE with LIMIT since PostgreSQL doesn't support LIMIT directly in DELETE
    while (true) {
      const result = await this.requestLogs.query(
        `WITH to_delete AS (
          SELECT id FROM request_logs WHERE created_at < $1 ORDER BY created_at LIMIT $2
        )
        DELETE FROM request_logs WHERE id IN (SELECT id FROM to_delete)`,
        [cutoffDate, batchSize],
      );

      // For PostgreSQL, pg driver may return either:
      // - QueryResult object with rowCount property
      // - Array [rows, rowCount] for queries with CTE
      let deleted = 0;
      if (Array.isArray(result)) {
        // Format: [rows, rowCount]
        deleted = (result[1] as number) ?? 0;
      } else if (result && typeof result === "object" && "rowCount" in result) {
        // Format: QueryResult object
        deleted = (result as { rowCount: number }).rowCount ?? 0;
      }
      totalDeleted += deleted;

      if (deleted < batchSize) {
        break;
      }
    }

    if (totalDeleted > 0) {
      this.logger.log(`Purged ${totalDeleted} request log entries older than ${retentionDays} days`);
    }

    return totalDeleted;
  }
}