import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RedisService } from "../redis/redis.service.js";
import { RequestLogRetentionService } from "./request-log-retention.service.js";

const FIRST_RUN_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60 * 1000;
// Shorter than the interval, so a crashed holder never blocks the next hour's run.
const LOCK_TTL_MS = 50 * 60 * 1000;
const LOCK_KEY = "request-logs:retention:lock";

/**
 * Purges expired request logs hourly. Every API instance runs the timer; a Redis lock makes only
 * one of them do the purge each hour.
 */
@Injectable()
export class RequestLogRetentionScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RequestLogRetentionScheduler.name);
  private firstRun: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly retention: RequestLogRetentionService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    // Unref'd: a pending purge must never keep the process (or a test run) alive.
    this.firstRun = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS).unref();
    this.interval = setInterval(() => void this.runOnce(), INTERVAL_MS).unref();
  }

  onApplicationShutdown(): void {
    clearTimeout(this.firstRun);
    clearInterval(this.interval);
  }

  /** Returns the rows deleted, or null when another instance holds this hour's lock. */
  async runOnce(): Promise<number | null> {
    try {
      const acquired = await this.redis.client.set(LOCK_KEY, randomUUID(), "PX", LOCK_TTL_MS, "NX");
      if (acquired !== "OK") {
        return null;
      }
      return await this.retention.purgeOlderThan();
    } catch (error) {
      this.logger.error("Request log retention purge failed", error instanceof Error ? error.stack : undefined);
      return null;
    }
  }
}
