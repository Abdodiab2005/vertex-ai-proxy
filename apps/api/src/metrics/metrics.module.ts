import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { MetricsController } from "./metrics.controller.js";
import { MetricsRegistry } from "./metrics.registry.js";

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [MetricsController],
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class MetricsModule {}
