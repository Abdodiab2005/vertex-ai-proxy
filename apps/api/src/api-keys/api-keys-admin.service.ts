import { Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, QueryFailedError, Repository } from "typeorm";
import { ApiKey, CreditTransaction, UsageRecord } from "@gateway/database";
import { ApiKeyStatus, CreditTransactionType } from "@gateway/contracts";
import { generateApiKey, hashApiKey } from "./api-key-material.js";
import { AuditService } from "../audit/audit.service.js";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { SettingsService } from "../settings/settings.service.js";
import type { CreateApiKeyDto, UpdateApiKeyDto, ListApiKeysQueryDto, AddCreditDto, ListCreditsQueryDto, UsageSummaryQueryDto, BulkCreateApiKeysDto, BulkTesterDto } from "./api-keys.schemas.js";
import { CreditLedgerService } from "../credits/credit-ledger.service.js";
import { toMicros } from "../credits/money.js";
import { RequestLimiter } from "../rate-limits/request-limiter.js";
import { startOfUtcDay, startOfUtcMonth } from "../analytics/analytics-range.js";
import { mapUsageAggregateRows, usageAggregateStatement } from "./api-key-usage-aggregate.js";
import {
  buildBulkKeysCsv,
  bulkKeyName,
  grantableCredit,
  presetPolicySource,
  resolveKeyPolicy,
} from "./key-policy.js";
import { KeyPresetsAdminService } from "./key-presets-admin.service.js";

const KEY_DELETE_HAS_HISTORY =
  "Keys with usage or credit history can't be deleted. Revoke the key instead.";

const KEY_REGENERATE_REVOKED = "Revoked keys can't be regenerated.";

function getEffectiveStatus(key: ApiKey): ApiKeyStatus {
  if (key.status === ApiKeyStatus.ACTIVE && key.expiresAt && key.expiresAt <= new Date()) {
    return ApiKeyStatus.EXPIRED;
  }
  return key.status as ApiKeyStatus;
}

export function toApiKeyView(key: ApiKey, credit?: { remaining: string; consumed: string }) {
  const result: Record<string, unknown> = {
    ...key,
    status: getEffectiveStatus(key),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
    updatedAt: key.updatedAt.toISOString(),
  };
  delete result["keyHash"];
  if (credit) {
    result.credit = credit;
  }
  return result;
}

@Injectable()
export class ApiKeysAdminService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
    @InjectRepository(CreditTransaction)
    private readonly creditTransactions: Repository<CreditTransaction>,
    @InjectRepository(UsageRecord)
    private readonly usageRecords: Repository<UsageRecord>,
    private readonly auditService: AuditService,
    private readonly settings: SettingsService,
    private readonly creditLedgerService: CreditLedgerService,
    private readonly dataSource: DataSource,
    private readonly keyPresets: KeyPresetsAdminService,
    private readonly requestLimiter: RequestLimiter,
  ) {}

  async createApiKey(adminUserId: string, dto: CreateApiKeyDto, ipAddress: string | null) {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12); // "lvg_" + 8

    const defaults = await this.settings.getAll();
    const lifetimeDays = defaults["keys.defaultLifetimeDays"];
    const expiresAt =
      dto.expiresAt !== undefined
        ? new Date(dto.expiresAt)
        : lifetimeDays === null
          ? null
          : new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);
    const requestedCredit = dto.initialCredit ?? defaults["keys.defaultInitialCredit"];
    // The ledger only accepts positive credit_added rows, so a "0" default grants nothing.
    const initialCredit =
      requestedCredit !== null && requestedCredit !== undefined && toMicros(requestedCredit) > 0n
        ? requestedCredit
        : null;

    let savedKey: ApiKey;

    await this.dataSource.transaction(async (manager) => {
      const key = manager.create(ApiKey, {
        ...dto,
        allowedModels: dto.allowedModels ?? defaults["keys.defaultAllowedModels"],
        requestsPerMinute:
          dto.requestsPerMinute !== undefined
            ? dto.requestsPerMinute
            : defaults["keys.defaultRequestsPerMinute"],
        requestsPerDay:
          dto.requestsPerDay !== undefined
            ? dto.requestsPerDay
            : defaults["keys.defaultRequestsPerDay"],
        maxConcurrentRequests:
          dto.maxConcurrentRequests !== undefined
            ? dto.maxConcurrentRequests
            : defaults["keys.defaultMaxConcurrentRequests"],
        keyHash,
        keyPrefix,
        status: ApiKeyStatus.ACTIVE,
        expiresAt,
      });

      savedKey = await manager.save(key);

      if (initialCredit !== null) {
        await this.creditLedgerService.append(
          {
            apiKeyId: savedKey.id,
            type: CreditTransactionType.CREDIT_ADDED,
            amount: initialCredit,
            description: "Initial credit",
            createdByAdminId: adminUserId,
          },
          manager
        );

        const updatedKey = await manager.findOne(ApiKey, { where: { id: savedKey.id } });
        if (updatedKey) savedKey = updatedKey;
      }
    });

    const view = toApiKeyView(savedKey!, { remaining: initialCredit ?? "0", consumed: "0" });

    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_CREATED,
      adminUserId,
      entityType: "api_key",
      entityId: savedKey!.id,
      ipAddress,
      after: view,
    });

    return { apiKey: view, rawKey };
  }

  async bulkCreateApiKeys(adminUserId: string, dto: BulkCreateApiKeysDto, ipAddress: string | null) {
    const defaults = await this.settings.getAll();
    const preset = dto.presetId === undefined ? undefined : await this.keyPresets.get(dto.presetId);
    const now = new Date();
    const policy = resolveKeyPolicy({
      preset: preset === undefined ? undefined : presetPolicySource(preset),
      overrides: dto.overrides,
      defaults: {
        allowedModels: defaults["keys.defaultAllowedModels"],
        requestsPerMinute: defaults["keys.defaultRequestsPerMinute"],
        requestsPerDay: defaults["keys.defaultRequestsPerDay"],
        maxConcurrentRequests: defaults["keys.defaultMaxConcurrentRequests"],
        initialCredit: defaults["keys.defaultInitialCredit"],
        lifetimeDays: defaults["keys.defaultLifetimeDays"],
      },
      now,
    });
    const credit = grantableCredit(policy.initialCredit);

    const created: Array<{ key: ApiKey; rawKey: string }> = [];

    // One transaction so a failure after the first key rolls back every key and
    // its credit rows. Raw keys stay in this result and are not written to the
    // audit row or the database.
    await this.dataSource.transaction(async (manager) => {
      for (let index = 1; index <= dto.quantity; index += 1) {
        const rawKey = generateApiKey();
        const expiresAt = policy.expiresAt === null ? null : new Date(policy.expiresAt.getTime());
        const key = manager.create(ApiKey, {
          name: bulkKeyName(dto.namePrefix, index, dto.quantity),
          description: policy.description,
          allowedModels: [...policy.allowedModels],
          blockedModels: [...policy.blockedModels],
          allowedEndpoints: [...policy.allowedEndpoints],
          requestsPerMinute: policy.requestsPerMinute,
          requestsPerDay: policy.requestsPerDay,
          tokensPerMinute: policy.tokensPerMinute,
          tokensPerDay: policy.tokensPerDay,
          tokensPerMonth: policy.tokensPerMonth,
          maxConcurrentRequests: policy.maxConcurrentRequests,
          tags: [...policy.tags],
          metadata: metadataForTester(dto.testers, index - 1),
          keyHash: hashApiKey(rawKey),
          keyPrefix: rawKey.substring(0, 12),
          status: ApiKeyStatus.ACTIVE,
          expiresAt,
        });
        const saved = await manager.save(key);
        if (credit !== null) {
          await this.creditLedgerService.append(
            {
              apiKeyId: saved.id,
              type: CreditTransactionType.CREDIT_ADDED,
              amount: credit,
              description: "Initial credit",
              createdByAdminId: adminUserId,
            },
            manager,
          );
        }
        created.push({ key: saved, rawKey });
      }
    });

    const keys = created.map(({ key, rawKey }) => ({
      apiKey: toApiKeyView(key, { remaining: credit ?? "0", consumed: "0" }),
      rawKey,
    }));

    const after: Record<string, unknown> = {
      count: dto.quantity,
      presetId: dto.presetId ?? null,
      namePrefix: dto.namePrefix,
      keyIds: created.map(({ key }) => key.id),
    };
    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_BULK_CREATED,
      adminUserId,
      entityType: "api_key",
      entityId: null,
      ipAddress,
      after,
    });

    const csv = buildBulkKeysCsv(
      created.map(({ key, rawKey }) => ({
        name: key.name,
        key: rawKey,
        credit: credit ?? "",
        expiresAt: key.expiresAt === null ? "" : key.expiresAt.toISOString(),
      })),
    );

    return { keys, csv };
  }

  async listApiKeys(query: ListApiKeysQueryDto) {
    const qb = this.apiKeys.createQueryBuilder("apiKey");
    
    // Join credit summary
    qb.leftJoin(
      subQuery => subQuery
        .select("tx.api_key_id", "apiKeyId")
        .addSelect("COALESCE(SUM(tx.amount), 0)::text", "remaining")
        .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'cost_consumed'), 0)::text", "consumed")
        .from(CreditTransaction, "tx")
        .groupBy("tx.api_key_id"),
      "credits",
      "credits.\"apiKeyId\" = apiKey.id"
    );
    qb.addSelect("COALESCE(credits.remaining, '0')", "credit_remaining");
    qb.addSelect("COALESCE(credits.consumed, '0')", "credit_consumed");

    if (query.search) {
      const escapedSearch = query.search.replace(/([%_\\])/g, "\\$1");
      qb.andWhere(
        "(apiKey.name ILIKE :search OR apiKey.keyPrefix ILIKE :search)",
        { search: `%${escapedSearch}%` }
      );
    }

    if (query.status) {
      if (query.status === ApiKeyStatus.ACTIVE) {
        qb.andWhere(
          "apiKey.status = :status AND (apiKey.expiresAt IS NULL OR apiKey.expiresAt > :now)",
          { status: ApiKeyStatus.ACTIVE, now: new Date() }
        );
      } else if (query.status === ApiKeyStatus.EXPIRED) {
        qb.andWhere(
          "(apiKey.status = :status OR (apiKey.status = :activeStatus AND apiKey.expiresAt <= :now))",
          { status: ApiKeyStatus.EXPIRED, activeStatus: ApiKeyStatus.ACTIVE, now: new Date() }
        );
      } else {
        qb.andWhere("apiKey.status = :status", { status: query.status });
      }
    }

    qb.orderBy("apiKey.createdAt", "DESC");
    qb.take(query.limit);
    qb.skip(query.offset);

    // Because of addSelect from leftJoin, we need getRawAndEntities
    const { entities, raw } = await qb.getRawAndEntities();
    const countQb = qb.clone();
    countQb.expressionMap.selects = []; // clear selects
    const total = await countQb.getCount();

    const usageByKey = await this.usageAggregatesFor(entities.map((entity) => entity.id));

    const apiKeys = entities.map(entity => {
      const row = raw.find(r => r.apiKey_id === entity.id);
      const usage = usageByKey.get(entity.id);
      return {
        ...toApiKeyView(entity, {
          remaining: String(row?.credit_remaining || "0"),
          consumed: String(row?.credit_consumed || "0"),
        }),
        requestsToday: usage?.requestsToday ?? 0,
        tokensThisMonth: usage?.tokensThisMonth ?? "0",
      };
    });

    return { apiKeys, total };
  }

  async getApiKey(id: string) {
    const qb = this.apiKeys.createQueryBuilder("apiKey")
      .leftJoin(
        subQuery => subQuery
          .select("tx.api_key_id", "apiKeyId")
          .addSelect("COALESCE(SUM(tx.amount), 0)::text", "remaining")
          .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'cost_consumed'), 0)::text", "consumed")
          .from(CreditTransaction, "tx")
          .groupBy("tx.api_key_id"),
        "credits",
        "credits.\"apiKeyId\" = apiKey.id"
      )
      .addSelect("COALESCE(credits.remaining, '0')", "credit_remaining")
      .addSelect("COALESCE(credits.consumed, '0')", "credit_consumed")
      .where("apiKey.id = :id", { id });

    const { entities, raw } = await qb.getRawAndEntities();
    const key = entities[0];
    if (!key) throw new NotFoundException();

    const row = raw[0];
    return {
      apiKey: toApiKeyView(key, {
        remaining: String(row?.credit_remaining || "0"),
        consumed: String(row?.credit_consumed || "0"),
      }),
      deletable: await this.isDeletable(id),
    };
  }

  async updateApiKey(adminUserId: string, id: string, dto: UpdateApiKeyDto, ipAddress: string | null) {
    // keeping previous logic for updateApiKey
    const keyInfo = await this.getApiKey(id);
    const beforeView = keyInfo.apiKey;

    const updatePayload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (k === "expiresAt") {
        updatePayload[k] = v === null ? null : new Date(v as string);
      } else {
        updatePayload[k] = v;
      }
    }

    await this.apiKeys.update(id, updatePayload);

    const updatedKeyInfo = await this.getApiKey(id);
    const afterView = updatedKeyInfo.apiKey;

    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_UPDATED,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
      before: beforeView,
      after: afterView,
    });

    return { apiKey: afterView };
  }

  async changeStatus(adminUserId: string, id: string, action: "suspend" | "reactivate" | "revoke", ipAddress: string | null) {
    const keyInfo = await this.getApiKey(id);
    const beforeView = keyInfo.apiKey;

    let newStatus: ApiKeyStatus;
    let allowedStatuses: ApiKeyStatus[];
    let auditAction: string;

    if (action === "suspend") {
      newStatus = ApiKeyStatus.SUSPENDED;
      allowedStatuses = [ApiKeyStatus.ACTIVE];
      auditAction = ADMIN_AUDIT_ACTIONS.API_KEY_SUSPENDED;
    } else if (action === "reactivate") {
      newStatus = ApiKeyStatus.ACTIVE;
      allowedStatuses = [ApiKeyStatus.SUSPENDED];
      auditAction = ADMIN_AUDIT_ACTIONS.API_KEY_REACTIVATED;
    } else if (action === "revoke") {
      newStatus = ApiKeyStatus.REVOKED;
      allowedStatuses = [ApiKeyStatus.ACTIVE, ApiKeyStatus.SUSPENDED, ApiKeyStatus.EXPIRED, ApiKeyStatus.CREDIT_EXHAUSTED];
      auditAction = ADMIN_AUDIT_ACTIONS.API_KEY_REVOKED;
    } else {
      throw new ConflictException("Invalid action.");
    }
    
    // Inactive expired key cannot be suspended; only active keys can transition to suspended.
    if (action === "suspend" && beforeView.status !== ApiKeyStatus.ACTIVE) {
      throw new ConflictException("Only active keys can be suspended.");
    }
    if (action === "reactivate" && beforeView.status !== ApiKeyStatus.SUSPENDED) {
      throw new ConflictException("Only suspended keys can be reactivated.");
    }
    if (action === "revoke" && beforeView.status === ApiKeyStatus.REVOKED) {
      throw new ConflictException("Key is already revoked.");
    }

    const updateResult = await this.apiKeys.createQueryBuilder()
      .update(ApiKey)
      .set({ status: newStatus })
      .where("id = :id AND status IN (:...allowedStatuses)", { id, allowedStatuses })
      .execute();

    if (updateResult.affected === 0) {
      const stillExists = await this.apiKeys.findOne({ where: { id } });
      if (!stillExists) throw new NotFoundException();
      if (action === "suspend") throw new ConflictException("Only active keys can be suspended.");
      if (action === "reactivate") throw new ConflictException("Only suspended keys can be reactivated.");
      if (action === "revoke") throw new ConflictException("Key is already revoked.");
      throw new ConflictException("Concurrent state change prevented update.");
    }

    const savedInfo = await this.getApiKey(id);
    const afterView = savedInfo.apiKey;

    await this.auditService.record({
      action: auditAction,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
      before: beforeView,
      after: afterView,
    });

    return { apiKey: afterView };
  }

  async addCredit(adminUserId: string, id: string, dto: AddCreditDto, ipAddress: string | null) {
    const key = await this.apiKeys.findOne({ where: { id } });
    if (!key) throw new NotFoundException();

    let transaction: CreditTransaction;
    let summary!: import("../credits/credit-ledger.service.js").CreditSummary;

    await this.dataSource.transaction(async manager => {
      // Amount signs need to be set properly. Input amount is validated to be positive magnitude except manual_adjustment.
      let finalAmount = dto.amount;
      if (dto.type === CreditTransactionType.CREDIT_REMOVED) {
        finalAmount = `-${dto.amount}`;
      }

      transaction = await this.creditLedgerService.append(
        {
          apiKeyId: id,
          type: dto.type,
          amount: finalAmount,
          description: dto.description || null,
          createdByAdminId: adminUserId,
        },
        manager
      );

      summary = await this.creditLedgerService.summary(id, manager);
    });

    await this.auditService.record({
      action: `admin.credit.${dto.type}`,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
      after: { transactionId: transaction!.id, amount: transaction!.amount, remaining: summary.remaining },
    });

    return { transaction: transaction!, summary };
  }

  async listCredits(id: string, query: ListCreditsQueryDto) {
    const key = await this.apiKeys.findOne({ where: { id } });
    if (!key) throw new NotFoundException();

    const [transactions, total] = await this.creditTransactions.findAndCount({
      where: { apiKeyId: id },
      order: { createdAt: "DESC" },
      take: query.limit,
      skip: query.offset,
    });

    const summary = await this.creditLedgerService.summary(id, this.dataSource.manager);

    return { summary, transactions, total };
  }

  async getUsageSummary(id: string, query: UsageSummaryQueryDto) {
    const key = await this.apiKeys.findOne({ where: { id } });
    if (!key) throw new NotFoundException();

    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();

    const modelQuery = this.usageRecords.createQueryBuilder("ur")
      .select("ur.model_id", "modelId")
      .addSelect("MAX(m.public_name)", "publicName") // join Model if we want
      .leftJoin("ur.model", "m")
      .addSelect("COUNT(*)::int", "requests")
      .addSelect("COALESCE(SUM(ur.calculated_cost), 0)", "costUsd")
      .where("ur.api_key_id = :id", { id })
      .andWhere("ur.created_at >= :from AND ur.created_at <= :to", { from, to })
      .groupBy("ur.model_id");

    const byModelRaw = await modelQuery.getRawMany();
    const byModel = byModelRaw.map(r => ({
      modelId: r.modelId,
      publicName: r.publicName,
      requests: parseInt(r.requests, 10),
      costUsd: String(r.costUsd || "0"),
    }));

    // byDimension query - pricing_snapshot->'lines' -> jsonb_array_elements
    const dimensionQuery = this.dataSource.manager.query(`
      SELECT 
        line->>'dimension' as dimension,
        COALESCE(SUM((line->>'cost')::numeric), 0) as "costUsd"
      FROM usage_records ur, jsonb_array_elements(ur.pricing_snapshot->'lines') line
      WHERE ur.api_key_id = $1
      AND ur.created_at >= $2 AND ur.created_at <= $3
      GROUP BY line->>'dimension'
    `, [id, from, to]);

    const byDimensionRaw = await dimensionQuery as Array<{ dimension: string; costUsd: string }>;
    const byDimension = byDimensionRaw.map((r) => ({
      dimension: r.dimension,
      costUsd: String(r.costUsd || "0"),
    }));

    return { byModel, byDimension };
  }

  async regenerateApiKey(adminUserId: string, id: string, ipAddress: string | null) {
    const existing = await this.apiKeys.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException();
    }
    if (existing.status === ApiKeyStatus.REVOKED) {
      throw new ConflictException(KEY_REGENERATE_REVOKED);
    }

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12);
    const previousPrefix = existing.keyPrefix;

    // Compare-and-set on the current hash and a non-revoked status so a
    // concurrent revoke cannot receive a new secret, and a concurrent
    // regenerate does not hand out a raw key that was never stored.
    const updateResult = await this.apiKeys
      .createQueryBuilder()
      .update(ApiKey)
      .set({ keyHash, keyPrefix, updatedAt: new Date() })
      .where("id = :id AND status != :revoked AND key_hash = :previousHash", {
        id,
        revoked: ApiKeyStatus.REVOKED,
        previousHash: existing.keyHash,
      })
      .execute();

    if (updateResult.affected === 0) {
      const still = await this.apiKeys.findOne({ where: { id } });
      if (!still) {
        throw new NotFoundException();
      }
      if (still.status === ApiKeyStatus.REVOKED) {
        throw new ConflictException(KEY_REGENERATE_REVOKED);
      }
      throw new ConflictException("The key changed while regenerating. Try again.");
    }

    const { apiKey } = await this.getApiKey(id);

    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_REGENERATED,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
      before: { keyPrefix: previousPrefix },
      after: { keyPrefix },
    });

    return { apiKey, rawKey };
  }

  async resetCounters(adminUserId: string, id: string, ipAddress: string | null) {
    const key = await this.apiKeys.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException();
    }

    await this.requestLimiter.resetCounters(id);

    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_COUNTERS_RESET,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
    });
  }

  async deleteApiKey(adminUserId: string, id: string, ipAddress: string | null) {
    const existing = await this.getApiKey(id);

    let outcome: "missing" | "history" | "deleted";
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        // credit_transactions cascade on this FK, and the ledger trigger
        // rejects those deletes. Hold the key row so a credit or usage insert
        // cannot land between the check and the delete.
        const locked = await manager
          .createQueryBuilder(ApiKey, "apiKey")
          .setLock("pessimistic_write")
          .where("apiKey.id = :id", { id })
          .getOne();
        if (!locked) {
          return "missing";
        }

        const usageCount = await manager.count(UsageRecord, { where: { apiKeyId: id } });
        const creditCount = await manager.count(CreditTransaction, { where: { apiKeyId: id } });
        if (usageCount > 0 || creditCount > 0) {
          return "history";
        }

        await manager.delete(ApiKey, { id });
        return "deleted";
      });
    } catch (error) {
      if (isHistoryDeleteBlocked(error)) {
        throw new ConflictException(KEY_DELETE_HAS_HISTORY);
      }
      throw error;
    }

    if (outcome === "missing") {
      throw new NotFoundException();
    }
    if (outcome === "history") {
      throw new ConflictException(KEY_DELETE_HAS_HISTORY);
    }

    await this.auditService.record({
      action: ADMIN_AUDIT_ACTIONS.API_KEY_DELETED,
      adminUserId,
      entityType: "api_key",
      entityId: id,
      ipAddress,
      before: existing.apiKey,
    });
  }

  async getLimitsUsage(id: string) {
    const key = await this.apiKeys.findOne({ where: { id } });
    if (!key) {
      throw new NotFoundException();
    }

    const usage = await this.requestLimiter.usage(id);
    return {
      limits: {
        requestsPerMinute: key.requestsPerMinute,
        requestsPerDay: key.requestsPerDay,
        tokensPerMinute: key.tokensPerMinute,
        tokensPerDay: key.tokensPerDay,
        tokensPerMonth: key.tokensPerMonth,
        maxConcurrentRequests: key.maxConcurrentRequests,
      },
      usage,
    };
  }

  private async usageAggregatesFor(ids: readonly string[]) {
    if (ids.length === 0) {
      return mapUsageAggregateRows([], []);
    }
    const now = new Date();
    const rows: unknown = await this.dataSource.query(usageAggregateStatement(ids.length), [
      ...ids,
      startOfUtcDay(now),
      startOfUtcMonth(now),
    ]);
    return mapUsageAggregateRows(ids, Array.isArray(rows) ? rows : []);
  }

  private async isDeletable(id: string): Promise<boolean> {
    const rows: unknown = await this.dataSource.query(
      `SELECT
         EXISTS(SELECT 1 FROM usage_records WHERE api_key_id = $1) AS "hasUsage",
         EXISTS(SELECT 1 FROM credit_transactions WHERE api_key_id = $1) AS "hasCredit"`,
      [id],
    );
    const row = Array.isArray(rows) ? asRecord(rows[0]) : null;
    if (row === null) {
      return false;
    }
    return !pgTruthy(row.hasUsage ?? row.hasusage) && !pgTruthy(row.hasCredit ?? row.hascredit);
  }
}

function metadataForTester(
  testers: readonly BulkTesterDto[] | undefined,
  index: number,
): Record<string, string> | null {
  if (testers === undefined) {
    return null;
  }
  const tester = testers[index];
  if (tester === undefined) {
    throw new Error("testers length does not match quantity");
  }
  const metadata: Record<string, string> = {};
  if (tester.testerName !== undefined) {
    metadata.testerName = tester.testerName;
  }
  if (tester.email !== undefined) {
    metadata.email = tester.email;
  }
  if (tester.googlePlayTesterNumber !== undefined) {
    metadata.googlePlayTesterNumber = tester.googlePlayTesterNumber;
  }
  if (tester.notes !== undefined) {
    metadata.notes = tester.notes;
  }
  return metadata;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pgTruthy(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1 || value === "1";
}

function isHistoryDeleteBlocked(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError: unknown = error.driverError;
  if (typeof driverError !== "object" || driverError === null || !("code" in driverError)) {
    return false;
  }
  const { code } = driverError;
  // 23503: usage_records ON DELETE RESTRICT. P0001: the append-only ledger
  // trigger, which also fires if the credit FK cascades.
  return code === "23503" || code === "P0001";
}
