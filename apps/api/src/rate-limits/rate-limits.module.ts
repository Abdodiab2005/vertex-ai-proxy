import { Global, Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module.js";
import { RequestLimiter } from "./request-limiter.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

@Global()
@Module({
  imports: [RedisModule],
  providers: [RequestLimiter, ConcurrencyLimiter],
  exports: [RequestLimiter, ConcurrencyLimiter],
})
export class RateLimitsModule {}