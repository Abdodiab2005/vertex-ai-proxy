import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Model, ModelAlias, ModelRoute, PricingRule, Upstream } from "@gateway/database";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { UpstreamsModule } from "../upstreams/upstreams.module.js";
import { ModelResolver } from "./model-resolver.js";
import { ModelsController } from "./models.controller.js";
import { ModelsService } from "./models.service.js";

@Module({
  imports: [
    AdminAuthModule,
    UpstreamsModule,
    TypeOrmModule.forFeature([Model, ModelAlias, PricingRule, Upstream, ModelRoute]),
  ],
  controllers: [ModelsController],
  providers: [ModelsService, ModelResolver],
  exports: [ModelResolver],
})
export class ModelsModule {}
