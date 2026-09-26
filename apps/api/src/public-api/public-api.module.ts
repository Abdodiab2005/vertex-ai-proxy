import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Model } from "@gateway/database";
import { PublicModelsController } from "./public-models.controller.js";
import { PublicGenerationController } from "./public-generation.controller.js";
import { PublicGenerationService } from "./public-generation.service.js";
import { ModelsModule } from "../models/models.module.js";
import { ApiKeysModule } from "../api-keys/api-keys.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { RateLimitsModule } from "../rate-limits/rate-limits.module.js";
import { CreditsModule } from "../credits/credits.module.js";
import { UpstreamsModule } from "../upstreams/upstreams.module.js";
import { MetricsModule } from "../metrics/metrics.module.js";

@Module({
  imports: [
    ModelsModule,
    ApiKeysModule,
    SettingsModule,
    RateLimitsModule,
    CreditsModule,
    UpstreamsModule,
    MetricsModule,
    TypeOrmModule.forFeature([Model])
  ],
  controllers: [PublicModelsController, PublicGenerationController],
  providers: [PublicGenerationService],
})
export class PublicApiModule {}
