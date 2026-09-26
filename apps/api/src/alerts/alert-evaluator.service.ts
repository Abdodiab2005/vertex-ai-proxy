import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomUUID } from "node:crypto";
import { DataSource, In, Repository } from "typeorm";
import { Alert, ApiKey, RequestLog, Upstream, type AlertStatus } from "@gateway/database";
import { ADMIN_AUDIT_ACTIONS, ApiKeyStatus, type AlertView, type EvaluateAlertsResponse } from "@gateway/contracts";
import { CreditLedgerService } from "../credits/credit-ledger.service.js";
import { SpendGuardService } from "../settings/spend-guard.service.js";
import { AuditService } from "../audit/audit.service.js";
import { RedisService } from "../redis/redis.service.js";
import {
  Credit80Rule,
  Credit100Rule,
  HIGH_ERROR_RATE_WINDOW_MINUTES,
  HighErrorRateRule,
  SpendThresholdRule,
  UpstreamUnavailableRule,
} from "./rules/index.js";
import type { RuleEvaluation } from "./rules/types.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";

const OPEN_STATUSES: AlertStatus[] = ["active", "acknowledged"];
const LOCK_KEY = "alerts:evaluate:lock";
// Longer than any evaluation should take; a crashed holder only delays the next run this long.
const LOCK_TTL_MS = 55_000;
// Only delete the lock if this evaluation still owns it.
const RELEASE_LOCK_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

const credit80 = new Credit80Rule();
const credit100 = new Credit100Rule();
const highErrorRate = new HighErrorRateRule();
const upstreamUnavailable = new UpstreamUnavailableRule();
const spendThreshold = new SpendThresholdRule();

type Condition = RuleEvaluation & { type: string };

@Injectable()
export class AlertEvaluatorService {
  private readonly logger = new Logger(AlertEvaluatorService.name);

  constructor(
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    @InjectRepository(ApiKey) private readonly apiKeys: Repository<ApiKey>,
    @InjectRepository(Upstream) private readonly upstreams: Repository<Upstream>,
    @InjectRepository(RequestLog) private readonly requestLogs: Repository<RequestLog>,
    private readonly creditLedger: CreditLedgerService,
    private readonly spendGuard: SpendGuardService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Opens an alert for each new condition (and notifies), keeps continuing ones open, and resolves
   * those whose condition cleared. Every instance runs the timer; the lock lets one evaluate at a
   * time, since two concurrent runs would race to open the same alert.
   */
  async evaluate(): Promise<EvaluateAlertsResponse> {
    const token = randomUUID();
    const acquired = await this.redis.client.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
    if (acquired !== "OK") {
      return { skipped: true, created: 0, resolved: 0 };
    }

    try {
      const conditions = await this.currentConditions();
      const { created, resolved } = await this.apply(conditions);
      // After the commit: a channel must never announce an alert that was rolled back.
      for (const alert of created) {
        await this.dispatcher.dispatch(alert);
      }
      return { skipped: false, created: created.length, resolved };
    } finally {
      await this.redis.client.eval(RELEASE_LOCK_SCRIPT, 1, LOCK_KEY, token).catch(() => undefined);
    }
  }

  private async currentConditions(): Promise<Condition[]> {
    const conditions: Condition[] = [];
    const add = (type: string, evaluation: RuleEvaluation | null) => {
      if (evaluation?.shouldAlert) {
        conditions.push({ ...evaluation, type });
      }
    };

    const keys = await this.apiKeys.find({
      select: { id: true },
      where: { status: In([ApiKeyStatus.ACTIVE, ApiKeyStatus.CREDIT_EXHAUSTED]) },
    });
    const summaries = await this.creditLedger.summaries(
      keys.map((key) => key.id),
      this.dataSource.manager,
    );
    for (const [apiKeyId, creditSummary] of summaries) {
      add(credit80.type, credit80.evaluate({ creditSummary, apiKeyId }));
      add(credit100.type, credit100.evaluate({ creditSummary, apiKeyId }));
    }

    const counts = await this.requestLogs
      .createQueryBuilder("log")
      .select("COUNT(*)::int", "total")
      .addSelect("(COUNT(*) FILTER (WHERE log.status = 'error'))::int", "errors")
      .where("log.created_at >= now() - make_interval(mins => :minutes)", { minutes: HIGH_ERROR_RATE_WINDOW_MINUTES })
      .getRawOne<{ total: number; errors: number }>();
    add(highErrorRate.type, highErrorRate.evaluate({ requestCounts: counts ?? { total: 0, errors: 0 } }));

    for (const upstream of await this.upstreams.find({ where: { enabled: true } })) {
      add(upstreamUnavailable.type, upstreamUnavailable.evaluate({ upstream }));
    }

    add(spendThreshold.type, spendThreshold.evaluate({ spendStatus: await this.spendGuard.status() }));
    return conditions;
  }

  private async apply(conditions: Condition[]): Promise<{ created: AlertView[]; resolved: number }> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const open = await manager.find(Alert, { where: { status: In(OPEN_STATUSES) } });
      const openByKey = new Map(open.map((alert) => [alert.dedupeKey, alert]));
      const currentKeys = new Set(conditions.map((condition) => condition.dedupeKey));

      const created: AlertView[] = [];
      for (const condition of conditions) {
        if (openByKey.has(condition.dedupeKey)) {
          continue;
        }
        const alert = await manager.save(
          manager.create(Alert, {
            type: condition.type,
            severity: condition.severity,
            dedupeKey: condition.dedupeKey,
            title: condition.title,
            message: condition.message,
            data: condition.data,
            status: "active",
            lastSeenAt: now,
          }),
        );
        created.push(toAlertView(alert, null));
      }

      // Acknowledged alerts stay acknowledged while their condition persists, but still record it.
      const continuing = open.filter((alert) => currentKeys.has(alert.dedupeKey)).map((alert) => alert.id);
      if (continuing.length > 0) {
        await manager.update(Alert, { id: In(continuing) }, { lastSeenAt: now });
      }

      const cleared = open.filter((alert) => !currentKeys.has(alert.dedupeKey)).map((alert) => alert.id);
      if (cleared.length > 0) {
        await manager.update(Alert, { id: In(cleared) }, { status: "resolved", resolvedAt: now });
      }

      return { created, resolved: cleared.length };
    });
  }

  async acknowledge(alertId: string, actor: { adminUserId: string; ipAddress: string | null }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const alert = await manager.findOne(Alert, { where: { id: alertId }, lock: { mode: "pessimistic_write" } });
      if (alert === null) {
        throw new NotFoundException("Alert not found.");
      }
      if (alert.status !== "active") {
        throw new ConflictException(`Only an active alert can be acknowledged; this one is ${alert.status}.`);
      }

      await manager.update(
        Alert,
        { id: alertId },
        { status: "acknowledged", acknowledgedAt: new Date(), acknowledgedByAdminId: actor.adminUserId },
      );
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.ALERT_ACKNOWLEDGED,
          adminUserId: actor.adminUserId,
          entityType: "alert",
          entityId: alertId,
          ipAddress: actor.ipAddress,
          before: { status: alert.status, type: alert.type, dedupeKey: alert.dedupeKey },
          after: { status: "acknowledged" },
        },
        manager,
      );
    });
  }

  async listAlerts(
    status: "active" | "acknowledged" | "resolved" | "open",
    limit: number,
  ): Promise<{ alerts: AlertView[]; counts: { active: number; acknowledged: number } }> {
    const qb = this.alerts
      .createQueryBuilder("alert")
      .leftJoin("alert.acknowledgedByAdmin", "admin")
      .addSelect("admin.email", "acknowledged_by_email")
      .orderBy("alert.last_seen_at", "DESC")
      .addOrderBy("alert.id", "DESC")
      .limit(limit);
    if (status === "open") {
      qb.where("alert.status IN (:...statuses)", { statuses: OPEN_STATUSES });
    } else {
      qb.where("alert.status = :status", { status });
    }

    const { entities, raw } = await qb.getRawAndEntities<{ acknowledged_by_email: string | null }>();
    const [active, acknowledged] = await Promise.all([
      this.alerts.count({ where: { status: "active" } }),
      this.alerts.count({ where: { status: "acknowledged" } }),
    ]);
    return {
      alerts: entities.map((alert, index) => toAlertView(alert, raw[index]?.acknowledged_by_email ?? null)),
      counts: { active, acknowledged },
    };
  }
}

function toAlertView(alert: Alert, acknowledgedByAdminEmail: string | null): AlertView {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    dedupeKey: alert.dedupeKey,
    title: alert.title,
    message: alert.message,
    data: alert.data,
    status: alert.status,
    firstSeenAt: alert.firstSeenAt.toISOString(),
    lastSeenAt: alert.lastSeenAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    acknowledgedByAdminId: alert.acknowledgedByAdminId,
    acknowledgedByAdminEmail,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
  };
}
