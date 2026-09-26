import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { ConfigService } from "../config/config.service.js";

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    // No lazyConnect: ioredis auto-connects and retries with its own backoff in
    // the background, so a Redis that's down at boot degrades /health instead of
    // blocking startup. maxRetriesPerRequest keeps individual commands (like the
    // health-check ping) failing fast instead of queuing for the default 20 retries.
    this.client = new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 1 });

    // ioredis treats an 'error' event with no listener as unhandled and crashes
    // the process — this listener is what makes "Redis is down" a degraded
    // health check instead of a dead app.
    this.client.on("error", (err) => {
      this.logger.warn(`Redis connection error: ${err.message}`);
    });
  }

  // Not onModuleDestroy: that runs before the shutdown drain, and requests still settling need Redis
  // to release their concurrency slots and credit reservations.
  onApplicationShutdown(): void {
    this.client.disconnect();
  }

  ping(): Promise<string> {
    return this.client.ping();
  }
}
