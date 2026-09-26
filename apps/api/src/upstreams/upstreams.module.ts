import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Upstream } from "@gateway/database";
import { CredentialCipher } from "@gateway/shared";
import { AdminAuthModule } from "../admin-auth/admin-auth.module.js";
import { ConfigService } from "../config/config.service.js";
import { UpstreamProviderFactory } from "./upstream-provider.factory.js";
import { UpstreamsController } from "./upstreams.controller.js";
import { UpstreamsService } from "./upstreams.service.js";

@Module({
  imports: [AdminAuthModule, TypeOrmModule.forFeature([Upstream])],
  controllers: [UpstreamsController],
  providers: [
    UpstreamsService,
    UpstreamProviderFactory,
    {
      provide: CredentialCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CredentialCipher =>
        new CredentialCipher(config.env.CREDENTIALS_ENCRYPTION_KEY),
    },
  ],
  // Later public routes build a provider for a stored upstream, and tests
  // replace this factory so they do not call Vertex.
  exports: [UpstreamProviderFactory],
})
export class UpstreamsModule {}
