import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { AnalyticsClock } from "./analytics-clock.js";
import {
  exportExceedsRowLimit,
  stableDimensionJson,
  toCsv,
  USAGE_EXPORT_MAX_ROWS,
} from "./analytics-format.js";
import { DEFAULT_USAGE_RANGE_MS, rangeSpanIssue } from "./analytics-range.js";
import type { UsageQuery } from "./analytics.schemas.js";
import { asRows, readInt, readIntOrNull, readString } from "./sql-rows.js";

export interface UsageReport {
  range: { from: string; to: string };
  totals: {
    requestCount: number;
    successCount: number;
    errorCount: number;
    partialCount: number;
    inputTokens: string;
    outputTokens: string;
    otherUsage: Record<string, string>;
    cost: string;
    costUndeterminedCount: number;
    avgLatencyMs: number | null;
  };
  byDay: { day: string; requests: number; cost: string }[];
  byModel: { modelId: string; publicName: string; requests: number; cost: string }[];
  byKey: { apiKeyId: string; name: string; keyPrefix: string; requests: number; cost: string }[];
}

interface ResolvedUsageFilter {
  from: Date;
  to: Date;
  apiKeyId?: string;
  modelId?: string;
  upstreamId?: string;
  status?: "success" | "error" | "partial";
  endpoint?: string;
}

interface SqlFilter {
  sql: string;
  params: unknown[];
}

const NUMERIC_DIMENSION = String.raw`e.value ~ '^-?[0-9]+(\.[0-9]+)?$'`;

const TOTALS_SQL = `
  SELECT
    COUNT(*)::int AS "requestCount",
    COUNT(*) FILTER (WHERE u.status = 'success')::int AS "successCount",
    COUNT(*) FILTER (WHERE u.status = 'error')::int AS "errorCount",
    COUNT(*) FILTER (WHERE u.status = 'partial')::int AS "partialCount",
    COALESCE(SUM(u.input_tokens), 0)::bigint::text AS "inputTokens",
    COALESCE(SUM(u.output_tokens), 0)::bigint::text AS "outputTokens",
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost,
    COUNT(*) FILTER (WHERE u.cost_undetermined)::int AS "costUndeterminedCount",
    ROUND(AVG(u.latency_ms))::int AS "avgLatencyMs"
  FROM usage_records u
  WHERE
`;

// The database session is not UTC. Take the calendar day from the UTC wall
// time, or a host offset in another timezone moves the bucket.
const BY_DAY_SQL = `
  SELECT
    to_char((u.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
    COUNT(*)::int AS requests,
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost
  FROM usage_records u
  WHERE
`;

const BY_MODEL_SQL = `
  SELECT
    u.model_id AS "modelId",
    m.public_name AS "publicName",
    COUNT(*)::int AS requests,
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost
  FROM usage_records u
  INNER JOIN models m ON m.id = u.model_id
  WHERE
`;

const BY_KEY_SQL = `
  SELECT
    u.api_key_id AS "apiKeyId",
    k.name AS name,
    k.key_prefix AS "keyPrefix",
    COUNT(*)::int AS requests,
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost
  FROM usage_records u
  INNER JOIN api_keys k ON k.id = u.api_key_id
  WHERE
`;

const OTHER_USAGE_SQL = `
  SELECT e.key AS dimension, SUM(e.value::numeric)::text AS total
  FROM usage_records u
  CROSS JOIN LATERAL jsonb_each_text(u.other_usage_dimensions) AS e(key, value)
  WHERE
`;

const CSV_GROUPS_SQL = `
  SELECT
    to_char((u.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
    u.api_key_id AS "apiKeyId",
    k.name AS "keyName",
    k.key_prefix AS "keyPrefix",
    u.model_id AS "modelId",
    m.public_name AS "modelPublicName",
    COUNT(*)::int AS "requestCount",
    COUNT(*) FILTER (WHERE u.status = 'success')::int AS "successCount",
    COUNT(*) FILTER (WHERE u.status = 'error')::int AS "errorCount",
    COUNT(*) FILTER (WHERE u.status = 'partial')::int AS "partialCount",
    COALESCE(SUM(u.input_tokens), 0)::bigint::text AS "inputTokens",
    COALESCE(SUM(u.output_tokens), 0)::bigint::text AS "outputTokens",
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost,
    COUNT(*) FILTER (WHERE u.cost_undetermined)::int AS "costUndeterminedCount",
    ROUND(AVG(u.latency_ms))::int AS "avgLatencyMs"
  FROM usage_records u
  INNER JOIN api_keys k ON k.id = u.api_key_id
  INNER JOIN models m ON m.id = u.model_id
  WHERE
`;

const CSV_DIMENSIONS_SQL = `
  SELECT
    to_char((u.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
    u.api_key_id AS "apiKeyId",
    u.model_id AS "modelId",
    e.key AS dimension,
    SUM(e.value::numeric)::text AS total
  FROM usage_records u
  CROSS JOIN LATERAL jsonb_each_text(u.other_usage_dimensions) AS e(key, value)
  WHERE
`;

const CSV_HEADER = [
  "day",
  "apiKeyId",
  "keyName",
  "keyPrefix",
  "modelId",
  "modelPublicName",
  "requestCount",
  "successCount",
  "errorCount",
  "partialCount",
  "inputTokens",
  "outputTokens",
  "otherUsage",
  "cost",
  "costUndeterminedCount",
  "avgLatencyMs",
] as const;

@Injectable()
export class UsageService {
  constructor(
    private readonly clock: AnalyticsClock,
    private readonly dataSource: DataSource,
  ) {}

  async report(query: UsageQuery): Promise<UsageReport> {
    const filter = resolveUsageFilter(query, this.clock.now());
    const where = usageWhere(filter);
    const [totals, byDay, byModel, byKey, otherUsage] = await Promise.all([
      this.totals(where),
      this.byDay(where),
      this.byModel(where),
      this.byKey(where),
      this.otherUsage(where),
    ]);
    return {
      range: { from: filter.from.toISOString(), to: filter.to.toISOString() },
      totals: { ...totals, otherUsage },
      byDay,
      byModel,
      byKey,
    };
  }

  async exportCsv(query: UsageQuery): Promise<string> {
    const filter = resolveUsageFilter(query, this.clock.now());
    const where = usageWhere(filter);
    const limitParams = [...where.params, USAGE_EXPORT_MAX_ROWS + 1];
    const limitPlaceholder = `$${limitParams.length}`;
    const groupedSql = `
      ${CSV_GROUPS_SQL} ${where.sql}
      GROUP BY 1, u.api_key_id, k.name, k.key_prefix, u.model_id, m.public_name
      ORDER BY 1 ASC, k.name ASC, m.public_name ASC, u.api_key_id ASC, u.model_id ASC
      LIMIT ${limitPlaceholder}
    `;
    const grouped: unknown = await this.dataSource.query(groupedSql, limitParams);
    const rows = asRows(grouped);
    if (exportExceedsRowLimit(rows.length)) {
      throw new BadRequestException(
        `Export exceeds ${USAGE_EXPORT_MAX_ROWS} rows. Narrow the filters.`,
      );
    }

    const dimensions = await this.csvDimensions(where);
    const body = rows.map((row) => {
      const day = readString(row, "day");
      const apiKeyId = readString(row, "apiKeyId");
      const modelId = readString(row, "modelId");
      const latency = readIntOrNull(row, "avgLatencyMs");
      return [
        day,
        apiKeyId,
        readString(row, "keyName"),
        readString(row, "keyPrefix"),
        modelId,
        readString(row, "modelPublicName"),
        String(readInt(row, "requestCount")),
        String(readInt(row, "successCount")),
        String(readInt(row, "errorCount")),
        String(readInt(row, "partialCount")),
        readString(row, "inputTokens"),
        readString(row, "outputTokens"),
        stableDimensionJson(dimensions.get(groupKey(day, apiKeyId, modelId)) ?? {}),
        readString(row, "cost"),
        String(readInt(row, "costUndeterminedCount")),
        latency === null ? "" : String(latency),
      ];
    });
    return toCsv([CSV_HEADER, ...body]);
  }

  private async totals(where: SqlFilter): Promise<Omit<UsageReport["totals"], "otherUsage">> {
    const rows: unknown = await this.dataSource.query(`${TOTALS_SQL} ${where.sql}`, where.params);
    const row = onlyRow(rows);
    return {
      requestCount: readInt(row, "requestCount"),
      successCount: readInt(row, "successCount"),
      errorCount: readInt(row, "errorCount"),
      partialCount: readInt(row, "partialCount"),
      inputTokens: readString(row, "inputTokens"),
      outputTokens: readString(row, "outputTokens"),
      cost: readString(row, "cost"),
      costUndeterminedCount: readInt(row, "costUndeterminedCount"),
      avgLatencyMs: readIntOrNull(row, "avgLatencyMs"),
    };
  }

  private async byDay(where: SqlFilter): Promise<UsageReport["byDay"]> {
    const sql = `
      ${BY_DAY_SQL} ${where.sql}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const rows: unknown = await this.dataSource.query(sql, where.params);
    return asRows(rows).map((row) => ({
      day: readString(row, "day"),
      requests: readInt(row, "requests"),
      cost: readString(row, "cost"),
    }));
  }

  private async byModel(where: SqlFilter): Promise<UsageReport["byModel"]> {
    const sql = `
      ${BY_MODEL_SQL} ${where.sql}
      GROUP BY u.model_id, m.public_name
      ORDER BY COALESCE(SUM(u.calculated_cost), 0) DESC, m.public_name ASC, u.model_id ASC
    `;
    const rows: unknown = await this.dataSource.query(sql, where.params);
    return asRows(rows).map((row) => ({
      modelId: readString(row, "modelId"),
      publicName: readString(row, "publicName"),
      requests: readInt(row, "requests"),
      cost: readString(row, "cost"),
    }));
  }

  private async byKey(where: SqlFilter): Promise<UsageReport["byKey"]> {
    const sql = `
      ${BY_KEY_SQL} ${where.sql}
      GROUP BY u.api_key_id, k.name, k.key_prefix
      ORDER BY COALESCE(SUM(u.calculated_cost), 0) DESC, k.name ASC, u.api_key_id ASC
    `;
    const rows: unknown = await this.dataSource.query(sql, where.params);
    return asRows(rows).map((row) => ({
      apiKeyId: readString(row, "apiKeyId"),
      name: readString(row, "name"),
      keyPrefix: readString(row, "keyPrefix"),
      requests: readInt(row, "requests"),
      cost: readString(row, "cost"),
    }));
  }

  private async otherUsage(where: SqlFilter): Promise<Record<string, string>> {
    const sql = `
      ${OTHER_USAGE_SQL} ${where.sql}
        AND jsonb_typeof(u.other_usage_dimensions) = 'object'
        AND ${NUMERIC_DIMENSION}
      GROUP BY e.key
      ORDER BY e.key ASC
    `;
    const rows: unknown = await this.dataSource.query(sql, where.params);
    const dimensions: Record<string, string> = {};
    for (const row of asRows(rows)) {
      dimensions[readString(row, "dimension")] = readString(row, "total");
    }
    return dimensions;
  }

  private async csvDimensions(where: SqlFilter): Promise<Map<string, Record<string, string>>> {
    const sql = `
      ${CSV_DIMENSIONS_SQL} ${where.sql}
        AND jsonb_typeof(u.other_usage_dimensions) = 'object'
        AND ${NUMERIC_DIMENSION}
      GROUP BY 1, u.api_key_id, u.model_id, e.key
    `;
    const rows: unknown = await this.dataSource.query(sql, where.params);
    const grouped = new Map<string, Record<string, string>>();
    for (const row of asRows(rows)) {
      const key = groupKey(readString(row, "day"), readString(row, "apiKeyId"), readString(row, "modelId"));
      const current = grouped.get(key) ?? {};
      current[readString(row, "dimension")] = readString(row, "total");
      grouped.set(key, current);
    }
    return grouped;
  }
}

function resolveUsageFilter(query: UsageQuery, now: Date): ResolvedUsageFilter {
  let from: Date;
  let to: Date;
  if (query.from !== undefined && query.to !== undefined) {
    const issue = rangeSpanIssue(query.from, query.to);
    if (issue !== null) {
      throw new BadRequestException(issue);
    }
    from = new Date(query.from);
    to = new Date(query.to);
  } else if (query.from !== undefined || query.to !== undefined) {
    throw new BadRequestException("from and to must be provided together");
  } else {
    to = now;
    from = new Date(now.getTime() - DEFAULT_USAGE_RANGE_MS);
  }
  return {
    from,
    to,
    apiKeyId: query.apiKeyId,
    modelId: query.modelId,
    upstreamId: query.upstreamId,
    status: query.status,
    endpoint: query.endpoint,
  };
}

function usageWhere(filter: ResolvedUsageFilter): SqlFilter {
  const clauses = ["u.created_at >= $1", "u.created_at < $2"];
  const params: unknown[] = [filter.from, filter.to];
  const add = (column: string, value: string) => {
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  };
  if (filter.apiKeyId !== undefined) {
    add("u.api_key_id", filter.apiKeyId);
  }
  if (filter.modelId !== undefined) {
    add("u.model_id", filter.modelId);
  }
  if (filter.upstreamId !== undefined) {
    add("u.upstream_id", filter.upstreamId);
  }
  if (filter.status !== undefined) {
    add("u.status", filter.status);
  }
  if (filter.endpoint !== undefined) {
    add("u.endpoint", filter.endpoint);
  }
  return { sql: clauses.join(" AND "), params };
}

function onlyRow(value: unknown): Record<string, unknown> {
  const rows = asRows(value);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new InternalServerErrorException("Usage query returned an unexpected result.");
  }
  return row;
}

function groupKey(day: string, apiKeyId: string, modelId: string): string {
  return `${day}\n${apiKeyId}\n${modelId}`;
}
