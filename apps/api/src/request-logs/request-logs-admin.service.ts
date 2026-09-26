import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { RequestLog } from "@gateway/database";
import { ApiKey } from "@gateway/database";
import type { ListRequestLogsQueryDto, RequestLogView, ListRequestLogsResponse } from "./request-logs.schemas.js";

@Injectable()
export class RequestLogsAdminService {
  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogs: Repository<RequestLog>,
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
  ) {}

  async listRequestLogs(query: ListRequestLogsQueryDto): Promise<ListRequestLogsResponse> {
    const limit = query.limit;
    const qb = this.requestLogs
      .createQueryBuilder("requestLog")
      .leftJoin(ApiKey, "apiKey", "apiKey.id = requestLog.api_key_id")
      .addSelect("apiKey.name", "apiKeyName")
      .addSelect("apiKey.keyPrefix", "apiKeyPrefix")
      .orderBy("requestLog.createdAt", "DESC")
      .addOrderBy("requestLog.id", "DESC")
      .take(limit + 1); // Take one extra to detect if there's a next page

    if (query.apiKeyId) {
      qb.andWhere("requestLog.api_key_id = :apiKeyId", { apiKeyId: query.apiKeyId });
    }

    if (query.model) {
      qb.andWhere("requestLog.model = :model", { model: query.model });
    }

    if (query.endpoint) {
      qb.andWhere("requestLog.endpoint = :endpoint", { endpoint: query.endpoint });
    }

    if (query.status) {
      qb.andWhere("requestLog.status = :status", { status: query.status });
    }

    if (query.upstream) {
      qb.andWhere("requestLog.upstream = :upstream", { upstream: query.upstream });
    }

    if (query.errorCode) {
      qb.andWhere("requestLog.error_code = :errorCode", { errorCode: query.errorCode });
    }

    if (query.from) {
      const fromDate = new Date(query.from);
      qb.andWhere("requestLog.created_at >= :from", { from: fromDate });
    }

    if (query.to) {
      const toDate = new Date(query.to);
      qb.andWhere("requestLog.created_at < :to", { to: toDate });
    }

    if (query.before) {
      const decoded = this.decodeCursor(query.before);
      if (!decoded) {
        throw new Error("Invalid cursor");
      }
      // Keyset pagination: (createdAt, id) < (cursorCreatedAt, cursorId)
      // Since we order by createdAt DESC, id DESC, we need:
      // createdAt < cursorCreatedAt OR (createdAt = cursorCreatedAt AND id < cursorId)
      qb.andWhere(
        "(requestLog.created_at < :cursorCreatedAt OR (requestLog.created_at = :cursorCreatedAt AND requestLog.id < :cursorId))",
        { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
      );
    }

    const rows = await qb.getRawAndEntities();

    const hasMore = rows.entities.length > limit;
    const entities = hasMore ? rows.entities.slice(0, limit) : rows.entities;
    const raws = hasMore ? rows.raw.slice(0, limit) : rows.raw;

    const mappedEntries: RequestLogView[] = entities.map((row, index) => ({
      id: row.id,
      requestId: row.requestId,
      apiKeyId: row.apiKeyId,
      apiKeyName: raws[index]?.apiKeyName ?? null,
      apiKeyPrefix: raws[index]?.apiKeyPrefix ?? null,
      model: row.model,
      endpoint: row.endpoint,
      status: row.status,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      otherUsageDimensions: row.otherUsageDimensions,
      calculatedCost: row.calculatedCost,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      upstream: row.upstream,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore) {
      const lastEntry = entities[entities.length - 1];
      nextCursor = this.encodeCursor(lastEntry.createdAt, lastEntry.id);
    }

    return { entries: mappedEntries, nextCursor };
  }

  /**
   * Exports request logs as CSV (up to 50,000 rows).
   * Uses the same filters as listRequestLogs but without pagination.
   */
  async exportRequestLogsCsv(query: ListRequestLogsQueryDto): Promise<string> {
    const qb = this.requestLogs
      .createQueryBuilder("requestLog")
      .leftJoin(ApiKey, "apiKey", "apiKey.id = requestLog.api_key_id")
      .addSelect("apiKey.name", "apiKeyName")
      .addSelect("apiKey.keyPrefix", "apiKeyPrefix")
      .orderBy("requestLog.createdAt", "DESC")
      .addOrderBy("requestLog.id", "DESC")
      .limit(50000);

    if (query.apiKeyId) {
      qb.andWhere("requestLog.api_key_id = :apiKeyId", { apiKeyId: query.apiKeyId });
    }

    if (query.model) {
      qb.andWhere("requestLog.model = :model", { model: query.model });
    }

    if (query.endpoint) {
      qb.andWhere("requestLog.endpoint = :endpoint", { endpoint: query.endpoint });
    }

    if (query.status) {
      qb.andWhere("requestLog.status = :status", { status: query.status });
    }

    if (query.upstream) {
      qb.andWhere("requestLog.upstream = :upstream", { upstream: query.upstream });
    }

    if (query.errorCode) {
      qb.andWhere("requestLog.error_code = :errorCode", { errorCode: query.errorCode });
    }

    if (query.from) {
      const fromDate = new Date(query.from);
      qb.andWhere("requestLog.created_at >= :from", { from: fromDate });
    }

    if (query.to) {
      const toDate = new Date(query.to);
      qb.andWhere("requestLog.created_at < :to", { to: toDate });
    }

    // Note: we don't apply cursor for export

    const rows = await qb.getRawAndEntities();

    // Build CSV header
    const headers = [
      "id",
      "requestId",
      "apiKeyId",
      "apiKeyName",
      "apiKeyPrefix",
      "model",
      "endpoint",
      "status",
      "latencyMs",
      "inputTokens",
      "outputTokens",
      "otherUsageDimensions",
      "calculatedCost",
      "clientIp",
      "userAgent",
      "upstream",
      "errorCode",
      "createdAt",
    ];

    const escapeCsv = (value: unknown): string => {
      if (value === null || value === undefined) {
        return "";
      }
      const str = typeof value === "object" ? JSON.stringify(value) : String(value);
      // RFC 4180: fields containing commas, double quotes, or newlines must be quoted
      // Double quotes inside a field are escaped by doubling them
      if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csvRows = [headers.join(",")];
    for (const [entity, raw] of rows.entities.map((e, i) => [e, rows.raw[i]])) {
      const row = [
        entity.id,
        entity.requestId,
        entity.apiKeyId,
        raw.apiKeyName ?? "",
        raw.apiKeyPrefix ?? "",
        entity.model ?? "",
        entity.endpoint,
        entity.status,
        entity.latencyMs ?? "",
        entity.inputTokens ?? "",
        entity.outputTokens ?? "",
        entity.otherUsageDimensions ?? "",
        entity.calculatedCost ?? "",
        entity.clientIp ?? "",
        entity.userAgent ?? "",
        entity.upstream ?? "",
        entity.errorCode ?? "",
        entity.createdAt.toISOString(),
      ];
      csvRows.push(row.map(escapeCsv).join(","));
    }

    return csvRows.join("\n");
  }

  private encodeCursor(createdAt: Date, id: string): string {
    const iso = createdAt.toISOString();
    const payload = `${iso}|${id}`;
    return Buffer.from(payload, "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      const [iso, id] = decoded.split("|");
      if (!iso || !id) return null;
      const createdAt = new Date(iso);
      if (Number.isNaN(createdAt.getTime())) return null;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return null;
      }
      return { createdAt, id };
    } catch {
      return null;
    }
  }
}