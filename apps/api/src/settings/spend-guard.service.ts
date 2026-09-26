import { HttpStatus, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { CreditTransactionType } from "@gateway/contracts";
import { CreditTransaction } from "@gateway/database";
import type { Repository } from "typeorm";
import { MoneyFormatError, formatMicros, toMicros } from "../credits/money.js";
import { GeminiApiException } from "../public-api/gemini-errors.js";
import { SettingsService } from "./settings.service.js";
import { SPEND_TRACKED_LABEL, isThresholdReached, usableTargetFor } from "./spend-threshold.js";

export interface SpendStatus {
  trackedSpendUsd: string;
  upstreamBudget: string | null;
  safetyReserve: string;
  usableTarget: string | null;
  thresholdReached: boolean;
  label: typeof SPEND_TRACKED_LABEL;
}

// cost_consumed amounts are signed debits (negative). Negating the sum is the
// positive magnitude of tracked spend, computed in numeric rather than JS floats.
const TRACKED_SPEND_SQL = `
  SELECT COALESCE((-SUM(amount))::text, '0') AS tracked
  FROM credit_transactions
  WHERE type = $1
`;

@Injectable()
export class SpendGuardService {
  private readonly logger = new Logger(SpendGuardService.name);

  constructor(
    private readonly settings: SettingsService,
    @InjectRepository(CreditTransaction)
    private readonly transactions: Repository<CreditTransaction>,
  ) {}

  async status(): Promise<SpendStatus> {
    const [budget, reserve, rows] = await Promise.all([
      this.settings.get("spend.upstreamBudget"),
      this.settings.get("spend.safetyReserve"),
      this.transactions.manager.query(TRACKED_SPEND_SQL, [CreditTransactionType.COST_CONSUMED]),
    ]);
    const trackedSpendUsd = this.canonicalTracked(readTracked(rows));
    const usableTarget = usableTargetFor(budget, reserve);
    return {
      trackedSpendUsd,
      upstreamBudget: budget,
      safetyReserve: reserve,
      usableTarget,
      thresholdReached: isThresholdReached(trackedSpendUsd, usableTarget),
      label: SPEND_TRACKED_LABEL,
    };
  }

  async assertWithinBudget(): Promise<void> {
    const block = await this.settings.get("spend.blockWhenThresholdReached");
    if (!block) {
      return;
    }
    const status = await this.status();
    if (status.thresholdReached) {
      throw new GeminiApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "UNAVAILABLE",
        "The gateway's spending limit has been reached.",
      );
    }
  }

  private canonicalTracked(raw: string): string {
    try {
      return formatMicros(toMicros(raw.trim()));
    } catch (error) {
      if (error instanceof MoneyFormatError) {
        this.logger.error("Spend total was not a decimal string.");
        throw new InternalServerErrorException("Spend total could not be read.");
      }
      throw error;
    }
  }
}

function readTracked(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new InternalServerErrorException("Spend total could not be read.");
  }
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null || !("tracked" in row)) {
    throw new InternalServerErrorException("Spend total could not be read.");
  }
  const tracked = (row as { tracked: unknown }).tracked;
  if (typeof tracked !== "string" || tracked.trim().length === 0) {
    throw new InternalServerErrorException("Spend total could not be read.");
  }
  return tracked;
}
