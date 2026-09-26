import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { AdminAuthService, LoginRateLimitedException } from "./admin-auth.service.js";
import type { AdminAuthentication } from "./admin-authentication.js";
import {
  adminLoginSchema,
  adminPasswordChangeSchema,
  type AdminLoginInput,
  type AdminPasswordChangeInput,
} from "./admin-auth.schemas.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { CurrentAdmin } from "./current-admin.decorator.js";
import { csrfTokenFor } from "./admin-sessions.service.js";
import {
  ADMIN_SESSION_COOKIE_NAME,
  adminSessionCookieOptions,
  clearAdminSessionCookieOptions,
} from "./session-cookie.js";
import { ConfigService } from "../config/config.service.js";

interface AdminAuthResponse {
  admin: {
    id: string;
    email: string;
    lastLoginAt: string | null;
  };
  csrfToken: string;
  session: {
    id: string;
    expiresAt: string;
  };
}

@Controller("admin/auth")
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly config: ConfigService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(adminLoginSchema)) body: AdminLoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminAuthResponse> {
    try {
      const result = await this.auth.login(
        body.email,
        body.password,
        requestIp(request),
        requestUserAgent(request),
      );
      response.cookie(
        ADMIN_SESSION_COOKIE_NAME,
        result.token,
        adminSessionCookieOptions(this.config.env),
      );

      return serializeAuthentication(
        result.user,
        result.session,
        csrfTokenFor(result.token),
      );
    } catch (error) {
      setRetryAfterHeader(response, error);
      throw error;
    }
  }

  @Get("me")
  @UseGuards(AdminSessionGuard)
  me(@CurrentAdmin() authentication: AdminAuthentication): AdminAuthResponse {
    return serializeAuthentication(
      authentication.user,
      authentication.session,
      authentication.csrfToken,
    );
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminSessionGuard)
  async logout(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(authentication, requestIp(request));
    response.cookie(
      ADMIN_SESSION_COOKIE_NAME,
      "",
      clearAdminSessionCookieOptions(this.config.env),
    );
  }

  @Post("password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminSessionGuard)
  async changePassword(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Body(new ZodValidationPipe(adminPasswordChangeSchema)) body: AdminPasswordChangeInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.auth.changePassword(
        authentication,
        body.currentPassword,
        body.newPassword,
        requestIp(request),
      );
    } catch (error) {
      setRetryAfterHeader(response, error);
      throw error;
    }
  }

  @Get("sessions")
  @UseGuards(AdminSessionGuard)
  async listSessions(@CurrentAdmin() authentication: AdminAuthentication): Promise<{
    sessions: Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      ipAddress: string | null;
      userAgent: string | null;
      current: boolean;
    }>;
  }> {
    const sessions = await this.auth.listSessions(authentication);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        current: session.id === authentication.session.id,
      })),
    };
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminSessionGuard)
  async revokeSession(
    @CurrentAdmin() authentication: AdminAuthentication,
    @Param("id") sessionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.revokeSession(authentication, sessionId, requestIp(request));
    if (sessionId.toLowerCase() === authentication.session.id.toLowerCase()) {
      response.cookie(
        ADMIN_SESSION_COOKIE_NAME,
        "",
        clearAdminSessionCookieOptions(this.config.env),
      );
    }
  }
}

function serializeAuthentication(
  authentication: AdminAuthentication["user"],
  session: AdminAuthentication["session"],
  csrfToken: string,
): AdminAuthResponse {
  return {
    admin: {
      id: authentication.id,
      email: authentication.email,
      lastLoginAt: authentication.lastLoginAt?.toISOString() ?? null,
    },
    csrfToken,
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

function requestIp(request: Request): string | null {
  return request.ip || null;
}

function requestUserAgent(request: Request): string | null {
  return request.get("user-agent") ?? null;
}

function setRetryAfterHeader(response: Response, error: unknown): void {
  if (error instanceof LoginRateLimitedException) {
    response.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
}
