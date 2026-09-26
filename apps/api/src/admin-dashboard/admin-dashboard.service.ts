import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ApiKeyStatus } from "@gateway/contracts";
import { ApiKey, Model, Upstream, UsageRecord } from "@gateway/database";
import type { Repository } from "typeorm";

export interface AdminDashboardSummary {
  apiKeys: {
    total: number;
    active: number;
  };
  upstreams: {
    total: number;
    enabled: number;
  };
  models: {
    total: number;
    enabled: number;
  };
  usageToday: {
    requests: number;
    costUsd: string;
  };
}

interface UsageTodayRow {
  requests: number;
  costUsd: string;
}

const usageTodayQuery = `
  SELECT
    COUNT(*)::int AS "requests",
    COALESCE(SUM(calculated_cost) FILTER (WHERE currency = 'USD'), 0)::text AS "costUsd"
  FROM usage_records
  WHERE created_at >= $1
`;

@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
    @InjectRepository(Upstream)
    private readonly upstreams: Repository<Upstream>,
    @InjectRepository(Model)
    private readonly models: Repository<Model>,
    @InjectRepository(UsageRecord)
    private readonly usageRecords: Repository<UsageRecord>,
  ) {}

  async summary(): Promise<AdminDashboardSummary> {
    const [
      apiKeysTotal,
      apiKeysActive,
      upstreamsTotal,
      upstreamsEnabled,
      modelsTotal,
      modelsEnabled,
      usageToday,
    ] = await Promise.all([
      this.apiKeys.count(),
      this.apiKeys.countBy({ status: ApiKeyStatus.ACTIVE }),
      this.upstreams.count(),
      this.upstreams.countBy({ enabled: true }),
      this.models.count(),
      this.models.countBy({ enabled: true }),
      this.usageRecords.query<UsageTodayRow[]>(usageTodayQuery, [startOfTodayUtc()]),
    ]);

    return {
      apiKeys: { total: apiKeysTotal, active: apiKeysActive },
      upstreams: { total: upstreamsTotal, enabled: upstreamsEnabled },
      models: { total: modelsTotal, enabled: modelsEnabled },
      usageToday: usageToday[0],
    };
  }
}

function startOfTodayUtc(now: Date = new Date()): Date {
  // The dashboard's calendar boundary must not move with the API host's timezone.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
