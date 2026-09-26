import { Injectable } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { CreditTransaction } from "@gateway/database";
import { ApiKey } from "@gateway/database";
import { CreditTransactionType, ApiKeyStatus } from "@gateway/contracts";
import { toMicros } from "./money.js";

export interface CreditSummary {
  currency: string;
  totalAdded: string;
  totalRemoved: string;
  totalConsumed: string;
  totalRefunded: string;
  adjustmentsNet: string;
  remaining: string;
}

interface RawCreditSummary {
  currency: string | null;
  totalAdded: string | null;
  totalRemoved: string | null;
  totalConsumed: string | null;
  totalRefunded: string | null;
  adjustmentsNet: string | null;
  remaining: string | null;
}

function toCreditSummary(row: RawCreditSummary | undefined): CreditSummary {
  return {
    currency: row?.currency ?? "USD",
    totalAdded: String(row?.totalAdded ?? "0"),
    totalRemoved: String(row?.totalRemoved ?? "0"),
    totalConsumed: String(row?.totalConsumed ?? "0"),
    totalRefunded: String(row?.totalRefunded ?? "0"),
    adjustmentsNet: String(row?.adjustmentsNet ?? "0"),
    remaining: String(row?.remaining ?? "0"),
  };
}

@Injectable()
export class CreditLedgerService {
  async summary(apiKeyId: string, manager: EntityManager): Promise<CreditSummary> {
    const result = await this.summaryQuery(manager)
      .where("tx.api_key_id = :apiKeyId", { apiKeyId })
      .getRawOne<RawCreditSummary>();
    return toCreditSummary(result);
  }

  /** One grouped query for many keys; keys without ledger rows are absent from the map. */
  async summaries(apiKeyIds: readonly string[], manager: EntityManager): Promise<Map<string, CreditSummary>> {
    if (apiKeyIds.length === 0) {
      return new Map();
    }
    const rows = await this.summaryQuery(manager)
      .addSelect("tx.api_key_id", "apiKeyId")
      .where("tx.api_key_id IN (:...apiKeyIds)", { apiKeyIds })
      .groupBy("tx.api_key_id")
      .getRawMany<RawCreditSummary & { apiKeyId: string }>();
    return new Map(rows.map((row) => [row.apiKeyId, toCreditSummary(row)]));
  }

  private summaryQuery(manager: EntityManager) {
    return manager
      .createQueryBuilder(CreditTransaction, "tx")
      .select("MAX(tx.currency)", "currency")
      .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'credit_added'), 0)::text", "totalAdded")
      .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'credit_removed'), 0)::text", "totalRemoved")
      .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'cost_consumed'), 0)::text", "totalConsumed")
      .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'refund'), 0)::text", "totalRefunded")
      .addSelect("COALESCE(SUM(tx.amount) FILTER (WHERE tx.type = 'manual_adjustment'), 0)::text", "adjustmentsNet")
      .addSelect("COALESCE(SUM(tx.amount), 0)::text", "remaining");
  }

  async remainingMicros(apiKeyId: string, manager: EntityManager): Promise<bigint> {
    const summary = await this.summary(apiKeyId, manager);
    return toMicros(summary.remaining);
  }

  async append(
    entry: Partial<CreditTransaction> & { apiKeyId: string; type: CreditTransactionType; amount: string },
    manager: EntityManager
  ): Promise<CreditTransaction> {
    const tx = manager.create(CreditTransaction, {
      ...entry,
      currency: entry.currency ?? "USD",
    });
    const saved = await manager.save(tx);
    
    // Evaluate if we should flip status based on remaining credit
    const summary = await this.summary(entry.apiKeyId, manager);
    const remaining = toMicros(summary.remaining);
    
    if (remaining > 0n) {
      await manager.update(
        ApiKey, 
        { id: entry.apiKeyId, status: ApiKeyStatus.CREDIT_EXHAUSTED },
        { status: ApiKeyStatus.ACTIVE }
      );
    } else {
      await manager.update(
        ApiKey,
        { id: entry.apiKeyId, status: ApiKeyStatus.ACTIVE },
        { status: ApiKeyStatus.CREDIT_EXHAUSTED }
      );
    }

    return saved;
  }
}
