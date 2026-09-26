import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { UsageRecord } from "@gateway/database";
import { CreditLedgerService } from "./credit-ledger.service.js";
import { CreditReservationStore } from "./credit-reservation.store.js";
import { toMicros } from "./money.js";
import { CreditTransactionType } from "@gateway/contracts";

export interface SettleInput {
  requestId: string;
  apiKeyId: string;
  modelId: string;
  upstreamId: string | null;
  endpoint: string;
  status: string; // "success" | "error" | "partial"
  latencyMs: number | null;
  quantities: Record<string, string | number | bigint>;
  usageComplete: boolean;
  breakdown: {
    currency: string | null;
    total: string;
    lines: Record<string, unknown>[];
    unpricedDimensions: string[];
    snapshot: Record<string, unknown>;
  } | null;
  reservation: { reservationId: string } | null;
}

@Injectable()
export class UsageAccountingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly creditLedgerService: CreditLedgerService,
    private readonly reservationStore: CreditReservationStore
  ) {}

  async settle(input: SettleInput): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        // Prepare usage record data
        const inputTokens = input.quantities.input_tokens ? String(input.quantities.input_tokens) : null;
        const outputTokens = input.quantities.output_tokens ? String(input.quantities.output_tokens) : null;
        
        const otherUsageDimensions = { ...input.quantities };
        delete otherUsageDimensions.input_tokens;
        delete otherUsageDimensions.output_tokens;

        let calculatedCost: string | null = null;
        let pricingSnapshot: Record<string, unknown> | null = null;
        const costUndetermined =
          input.breakdown === null || !input.usageComplete || input.breakdown.unpricedDimensions.length > 0;

        if (input.breakdown) {
          pricingSnapshot = {
            ...input.breakdown.snapshot,
            lines: input.breakdown.lines
          };

          // The priced lines are a lower bound on the real cost: debit them even when a count is
          // missing or a dimension has no price, or such a response would cost the key nothing.
          // With nothing priced at all the cost is unknown, not zero.
          if (!costUndetermined || input.breakdown.lines.length > 0) {
            calculatedCost = input.breakdown.total;
          }
        }

        const usageRecord = manager.create(UsageRecord, {
          requestId: input.requestId,
          apiKeyId: input.apiKeyId,
          modelId: input.modelId,
          upstreamId: input.upstreamId,
          endpoint: input.endpoint,
          status: input.status,
          inputTokens,
          outputTokens,
          otherUsageDimensions: Object.keys(otherUsageDimensions).length > 0 ? otherUsageDimensions : null,
          calculatedCost,
          currency: input.breakdown?.currency ?? "USD",
          costUndetermined,
          pricingSnapshot,
          latencyMs: input.latencyMs,
        });

        const savedUsageRecord = await manager.save(usageRecord);

        // Debit the cost if known and > 0
        if (calculatedCost && toMicros(calculatedCost) > 0n) {
          // Negative total for debit
          const debitAmount = `-${calculatedCost}`;
          await this.creditLedgerService.append(
            {
              apiKeyId: input.apiKeyId,
              type: CreditTransactionType.COST_CONSUMED,
              amount: debitAmount,
              currency: savedUsageRecord.currency,
              usageRecordId: savedUsageRecord.id,
              description: `Cost consumed for request ${input.requestId}`,
            },
            manager
          );
        }
      });
    } finally {
      // Always release reservation, even if transaction fails
      if (input.reservation?.reservationId) {
        await this.reservationStore.release(input.apiKeyId, input.reservation.reservationId);
      }
    }
  }
}
