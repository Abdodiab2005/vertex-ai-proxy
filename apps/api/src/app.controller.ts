import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { RedisService } from "./redis/redis.service.js";
import { InFlightRequests } from "./lifecycle/in-flight-requests.js";

@Controller()
export class AppController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly inFlight: InFlightRequests,
  ) {}

  @Get("health")
  async getHealth(): Promise<{
    status: "ok" | "degraded";
    database: "connected" | "unavailable";
    redis: "connected" | "unavailable";
  }> {
    const { database, redis } = await this.checkDependencies();
    const body = {
      status: database && redis ? ("ok" as const) : ("degraded" as const),
      database: database ? ("connected" as const) : ("unavailable" as const),
      redis: redis ? ("connected" as const) : ("unavailable" as const),
    };
    if (body.status === "degraded") {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  @Get("health/ready")
  async getReadiness(): Promise<{
    status: "ready";
    checks: {
      database: "ok" | "unavailable";
      redis: "ok" | "unavailable";
    };
  }> {
    const { database, redis } = await this.checkDependencies();
    const checks = {
      database: database ? ("ok" as const) : ("unavailable" as const),
      redis: redis ? ("ok" as const) : ("unavailable" as const),
    };

    if (!database || !redis) {
      throw new ServiceUnavailableException({ status: "not_ready", checks });
    }
    // A draining instance is healthy but must stop receiving traffic.
    if (this.inFlight.draining) {
      throw new ServiceUnavailableException({ status: "shutting_down", checks });
    }

    return { status: "ready", checks };
  }

  @Get("health/live")
  getLiveness(): { status: "alive" } {
    return { status: "alive" };
  }

  private async checkDependencies(): Promise<{ database: boolean; redis: boolean }> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return { database, redis };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
