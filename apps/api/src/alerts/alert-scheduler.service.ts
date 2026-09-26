import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { EvaluateAlertsResponse } from "@gateway/contracts";
import { AlertEvaluatorService } from "./alert-evaluator.service.js";

const INTERVAL_MS = 60_000;

/** Evaluates alert rules every minute; the evaluator's lock keeps concurrent instances from overlapping. */
@Injectable()
export class AlertScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AlertScheduler.name);
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly evaluator: AlertEvaluatorService) {}

  onApplicationBootstrap(): void {
    // Unref'd: a pending evaluation must never keep the process (or a test run) alive.
    this.interval = setInterval(() => void this.runScheduled(), INTERVAL_MS).unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.interval);
  }

  runNow(): Promise<EvaluateAlertsResponse> {
    return this.evaluator.evaluate();
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.evaluator.evaluate();
    } catch (error) {
      this.logger.error("Alert evaluation failed", error instanceof Error ? error.stack : undefined);
    }
  }
}
