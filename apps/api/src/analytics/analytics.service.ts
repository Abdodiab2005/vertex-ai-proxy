import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { CreditTransactionType } from "@gateway/contracts";
import { DataSource } from "typeorm";
import { AnalyticsClock } from "./analytics-clock.js";
import { formatErrorRate } from "./analytics-format.js";
import {
  enumerateBuckets,
  nextUtcDay,
  nextUtcMonth,
  resolveRange,
  startOfUtcDay,
  startOfUtcMonth,
  zeroFillPoints,
  type AnalyticsBucket,
} from "./analytics-range.js";
import type { OverviewQuery, TimeseriesQuery } from "./analytics.schemas.js";
import {
  asRows,
  readBoolean,
  readInt,
  readIsoTimestamp,
  readIsoTimestampOrNull,
  readString,
} from "./sql-rows.js";
import { RedisService } from "../redis/redis.service.js";

export interface AnalyticsOverview {
  range: { from: string; to: string };
  requestsToday: number;
  requestsThisMonth: number;
  requestsInRange: number;
  inputTokensInRange: string;
  outputTokensInRange: string;
  costToday: string;
  costThisMonth: string;
  costInRange: string;
  credit: {
    totalAllocated: string;
    totalConsumed: string;
    totalRemaining: string;
  };
  keys: {
    active: number;
    suspended: number;
    revoked: number;
    expired: number;
    creditExhausted: number;
  };
  topKeys: { apiKeyId: string; name: string; keyPrefix: string; requests: number; cost: string }[];
  topModels: { modelId: string; publicName: string; requests: number; cost: string }[];
  currentRpm: number;
  errorRate: string;
  activeStreams: number;
  upstreams: {
    id: string;
    name: string;
    enabled: boolean;
    status: string;
    lastCheckedAt: string | null;
  }[];
}

export interface AnalyticsTimeseries {
  bucket: AnalyticsBucket;
  points: { t: string; value: string }[];
}

const KEY_COUNT_FIELDS = {
  active: "active",
  suspended: "suspended",
  revoked: "revoked",
  expired: "expired",
  credit_exhausted: "creditExhausted",
} as const;

// The dev session timezone is not UTC. date_trunc(timestamptz) follows that
// zone, so buckets are truncated on the UTC wall clock and converted back.
const TIMESERIES_SQL = `
  WITH series AS (
    SELECT generate_series($1::timestamptz, $2::timestamptz, $3::interval) AS bucket
  ),
  agg AS (
    SELECT
      (date_trunc($4::text, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS bucket,
      COUNT(*)::bigint AS requests,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::bigint AS tokens,
      COALESCE(SUM(calculated_cost), 0)::numeric(18, 6) AS cost,
      COUNT(*) FILTER (WHERE status = 'error')::bigint AS errors
    FROM usage_records
    WHERE created_at >= $5::timestamptz AND created_at < $6::timestamptz
    GROUP BY 1
  )
  SELECT
    series.bucket AS t,
    CASE $7::text
      WHEN 'requests' THEN COALESCE(agg.requests, 0)::text
      WHEN 'tokens' THEN COALESCE(agg.tokens, 0)::text
      WHEN 'cost' THEN COALESCE(agg.cost, 0)::numeric(18, 6)::text
      WHEN 'errors' THEN COALESCE(agg.errors, 0)::text
    END AS value
  FROM series
  LEFT JOIN agg ON agg.bucket = series.bucket
  ORDER BY series.bucket
`;

const USAGE_WINDOWS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS "requestsInRange",
    COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= $1 AND created_at < $2), 0)::bigint::text AS "inputTokensInRange",
    COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= $1 AND created_at < $2), 0)::bigint::text AS "outputTokensInRange",
    COALESCE(SUM(calculated_cost) FILTER (WHERE created_at >= $1 AND created_at < $2), 0)::numeric(18, 6)::text AS "costInRange",
    COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND status = 'error')::int AS "errorsInRange",
    COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS "requestsToday",
    COALESCE(SUM(calculated_cost) FILTER (WHERE created_at >= $3 AND created_at < $4), 0)::numeric(18, 6)::text AS "costToday",
    COUNT(*) FILTER (WHERE created_at >= $5 AND created_at < $6)::int AS "requestsThisMonth",
    COALESCE(SUM(calculated_cost) FILTER (WHERE created_at >= $5 AND created_at < $6), 0)::numeric(18, 6)::text AS "costThisMonth",
    COUNT(*) FILTER (WHERE created_at >= $7 AND created_at <= $8)::int AS "currentRpm"
  FROM usage_records
`;

const CREDIT_SQL = `
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type::text IN ($1, $2, $3, $4)), 0)::numeric(18, 6)::text AS "totalAllocated",
    COALESCE(-SUM(amount) FILTER (WHERE type::text = $5), 0)::numeric(18, 6)::text AS "totalConsumed",
    COALESCE(SUM(amount), 0)::numeric(18, 6)::text AS "totalRemaining"
  FROM credit_transactions
`;

const KEY_COUNTS_SQL = `
  SELECT status::text AS status, COUNT(*)::int AS count
  FROM api_keys
  GROUP BY status
`;

const TOP_KEYS_SQL = `
  SELECT
    u.api_key_id AS "apiKeyId",
    k.name AS name,
    k.key_prefix AS "keyPrefix",
    COUNT(*)::int AS requests,
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost
  FROM usage_records u
  INNER JOIN api_keys k ON k.id = u.api_key_id
  WHERE u.created_at >= $1 AND u.created_at < $2
  GROUP BY u.api_key_id, k.name, k.key_prefix
  ORDER BY COALESCE(SUM(u.calculated_cost), 0) DESC, k.name ASC, u.api_key_id ASC
  LIMIT 10
`;

const TOP_MODELS_SQL = `
  SELECT
    u.model_id AS "modelId",
    m.public_name AS "publicName",
    COUNT(*)::int AS requests,
    COALESCE(SUM(u.calculated_cost), 0)::numeric(18, 6)::text AS cost
  FROM usage_records u
  INNER JOIN models m ON m.id = u.model_id
  WHERE u.created_at >= $1 AND u.created_at < $2
  GROUP BY u.model_id, m.public_name
  ORDER BY COALESCE(SUM(u.calculated_cost), 0) DESC, m.public_name ASC, u.model_id ASC
  LIMIT 10
`;

const UPSTREAMS_SQL = `
  SELECT
    id,
    name,
    enabled,
    status,
    last_checked_at AS "lastCheckedAt"
  FROM upstreams
  ORDER BY name ASC, id ASC
`;

// Matches ConcurrencyLimiter keys `ratelimit:{<apiKeyId>}:concurrency`. SCAN is
// capped so a polluted keyspace cannot turn a dashboard read into an unbounded walk.
const COUNT_LIVE_LEASES = `
  local cursor = "0"
  local total = 0
  local iterations = 0
  local max_iterations = 50
  local time = redis.call("TIME")
  local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  repeat
    local result = redis.call("SCAN", cursor, "MATCH", "ratelimit:{*}:concurrency", "COUNT", 200)
    cursor = result[1]
    iterations = iterations + 1
    for _, key in ipairs(result[2]) do
      total = total + tonumber(redis.call("ZCOUNT", key, "(" .. tostring(now_ms), "+inf"))
    end
  until cursor == "0" or iterations >= max_iterations
  local truncated = 0
  if cursor ~= "0" then
    truncated = 1
  end
  return {total, truncated}
`;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly clock: AnalyticsClock,
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  async overview(query: OverviewQuery): Promise<AnalyticsOverview> {
    const now = this.clock.now();
    const range = this.resolvedRange(query, now);
    const todayStart = startOfUtcDay(now);
    const todayEnd = nextUtcDay(todayStart);
    const monthStart = startOfUtcMonth(now);
    const monthEnd = nextUtcMonth(monthStart);
    const rpmFrom = new Date(now.getTime() - 60_000);

    const [usage, credit, keys, topKeys, topModels, upstreams, activeStreams] = await Promise.all([
      this.usageWindows(range.from, range.to, todayStart, todayEnd, monthStart, monthEnd, rpmFrom, now),
      this.creditTotals(),
      this.keyCounts(),
      this.topKeys(range.from, range.to),
      this.topModels(range.from, range.to),
      this.upstreams(),
      this.countActiveStreams(),
    ]);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      requestsToday: usage.requestsToday,
      requestsThisMonth: usage.requestsThisMonth,
      requestsInRange: usage.requestsInRange,
      inputTokensInRange: usage.inputTokensInRange,
      outputTokensInRange: usage.outputTokensInRange,
      costToday: usage.costToday,
      costThisMonth: usage.costThisMonth,
      costInRange: usage.costInRange,
      credit,
      keys,
      topKeys,
      topModels,
      currentRpm: usage.currentRpm,
      errorRate: formatErrorRate(BigInt(usage.errorsInRange), BigInt(usage.requestsInRange)),
      activeStreams,
      upstreams,
    };
  }

  async timeseries(query: TimeseriesQuery): Promise<AnalyticsTimeseries> {
    const range = this.resolvedRange(query, this.clock.now());
    const buckets = enumerateBuckets(range.from, range.to, range.bucket);
    const zero = query.metric === "cost" ? "0.000000" : "0";
    if (buckets.length === 0) {
      return { bucket: range.bucket, points: [] };
    }

    const first = buckets[0];
    const last = buckets[buckets.length - 1];
    if (first === undefined || last === undefined) {
      return { bucket: range.bucket, points: [] };
    }

    const rows: unknown = await this.dataSource.query(TIMESERIES_SQL, [
      first,
      last,
      range.bucket === "hour" ? "1 hour" : "1 day",
      range.bucket,
      range.from,
      range.to,
      query.metric,
    ]);
    const actual = asRows(rows).map((row) => ({
      t: readIsoTimestamp(row.t),
      value: readString(row, "value"),
    }));

    return {
      bucket: range.bucket,
      points: zeroFillPoints(buckets, actual, zero),
    };
  }

  private resolvedRange(query: OverviewQuery, now: Date) {
    try {
      return resolveRange(query, now);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async usageWindows(
    rangeFrom: Date,
    rangeTo: Date,
    todayStart: Date,
    todayEnd: Date,
    monthStart: Date,
    monthEnd: Date,
    rpmFrom: Date,
    now: Date,
  ) {
    const rows: unknown = await this.dataSource.query(USAGE_WINDOWS_SQL, [
      rangeFrom,
      rangeTo,
      todayStart,
      todayEnd,
      monthStart,
      monthEnd,
      rpmFrom,
      now,
    ]);
    const row = oneRow(rows);
    return {
      requestsInRange: readInt(row, "requestsInRange"),
      inputTokensInRange: readString(row, "inputTokensInRange"),
      outputTokensInRange: readString(row, "outputTokensInRange"),
      costInRange: readString(row, "costInRange"),
      errorsInRange: readInt(row, "errorsInRange"),
      requestsToday: readInt(row, "requestsToday"),
      costToday: readString(row, "costToday"),
      requestsThisMonth: readInt(row, "requestsThisMonth"),
      costThisMonth: readString(row, "costThisMonth"),
      currentRpm: readInt(row, "currentRpm"),
    };
  }

  private async creditTotals(): Promise<AnalyticsOverview["credit"]> {
    const rows: unknown = await this.dataSource.query(CREDIT_SQL, [
      CreditTransactionType.CREDIT_ADDED,
      CreditTransactionType.CREDIT_REMOVED,
      CreditTransactionType.REFUND,
      CreditTransactionType.MANUAL_ADJUSTMENT,
      CreditTransactionType.COST_CONSUMED,
    ]);
    const row = oneRow(rows);
    return {
      totalAllocated: readString(row, "totalAllocated"),
      totalConsumed: readString(row, "totalConsumed"),
      totalRemaining: readString(row, "totalRemaining"),
    };
  }

  private async keyCounts(): Promise<AnalyticsOverview["keys"]> {
    const counts: AnalyticsOverview["keys"] = {
      active: 0,
      suspended: 0,
      revoked: 0,
      expired: 0,
      creditExhausted: 0,
    };
    const rows: unknown = await this.dataSource.query(KEY_COUNTS_SQL);
    for (const row of asRows(rows)) {
      const status = readString(row, "status");
      const field = KEY_COUNT_FIELDS[status as keyof typeof KEY_COUNT_FIELDS];
      if (field !== undefined) {
        counts[field] = readInt(row, "count");
      }
    }
    return counts;
  }

  private async topKeys(from: Date, to: Date): Promise<AnalyticsOverview["topKeys"]> {
    const rows: unknown = await this.dataSource.query(TOP_KEYS_SQL, [from, to]);
    return asRows(rows).map((row) => ({
      apiKeyId: readString(row, "apiKeyId"),
      name: readString(row, "name"),
      keyPrefix: readString(row, "keyPrefix"),
      requests: readInt(row, "requests"),
      cost: readString(row, "cost"),
    }));
  }

  private async topModels(from: Date, to: Date): Promise<AnalyticsOverview["topModels"]> {
    const rows: unknown = await this.dataSource.query(TOP_MODELS_SQL, [from, to]);
    return asRows(rows).map((row) => ({
      modelId: readString(row, "modelId"),
      publicName: readString(row, "publicName"),
      requests: readInt(row, "requests"),
      cost: readString(row, "cost"),
    }));
  }

  private async upstreams(): Promise<AnalyticsOverview["upstreams"]> {
    const rows: unknown = await this.dataSource.query(UPSTREAMS_SQL);
    return asRows(rows).map((row) => ({
      id: readString(row, "id"),
      name: readString(row, "name"),
      enabled: readBoolean(row, "enabled"),
      status: readString(row, "status"),
      lastCheckedAt: readIsoTimestampOrNull(row.lastCheckedAt),
    }));
  }

  private async countActiveStreams(): Promise<number> {
    const raw: unknown = await this.redis.client.eval(COUNT_LIVE_LEASES, 0);
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new InternalServerErrorException("Active stream count could not be read.");
    }
    const total = readRedisCount(raw[0]);
    const truncated = readRedisCount(raw[1]);
    if (truncated === 1) {
      this.logger.warn(
        "Concurrency lease scan hit its iteration cap; the active stream count may be low.",
      );
    }
    return total;
  }
}

function oneRow(value: unknown): Record<string, unknown> {
  const rows = asRows(value);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new InternalServerErrorException("Analytics query returned an unexpected result.");
  }
  return row;
}

function readRedisCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new InternalServerErrorException("Active stream count could not be read.");
}
