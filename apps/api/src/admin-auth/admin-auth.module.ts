import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AdminSession, AdminUser } from "@gateway/database";
import { SecurityModule } from "../security/security.module.js";
import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthService } from "./admin-auth.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSessionsService } from "./admin-sessions.service.js";

@Module({
  imports: [TypeOrmModule.forFeature([AdminUser, AdminSession]), SecurityModule],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminSessionsService, AdminSessionGuard],
  // Nest instantiates a guard inside each module that uses it, so modules applying
  // AdminSessionGuard also need the service it depends on.
  exports: [AdminSessionGuard, AdminSessionsService],
})
export class AdminAuthModule {}
