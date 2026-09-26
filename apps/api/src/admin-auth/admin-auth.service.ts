import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AdminSession, AdminUser } from "@gateway/database";
import type { Repository } from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import { LoginRateLimiter } from "../security/login-rate-limiter.js";
import { PasswordHasher } from "../security/password-hasher.js";
import type { AdminAuthentication } from "./admin-authentication.js";
import { AdminSessionsService } from "./admin-sessions.service.js";

export interface AdminLoginResult {
  user: AdminUser;
  session: AdminSession;
  token: string;
}

export class LoginRateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      HttpException.createBody(
        "Too many attempts. Please try again later.",
        "Too Many Requests",
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectRepository(AdminUser)
    private readonly adminUsers: Repository<AdminUser>,
    private readonly sessions: AdminSessionsService,
    private readonly hasher: PasswordHasher,
    private readonly limiter: LoginRateLimiter,
    private readonly audit: AuditService,
  ) {}

  async login(
    email: string,
    password: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<AdminLoginResult> {
    const normalizedEmail = normalizeEmail(email);
    // Atomic admission checks capacity and pre-counts the attempt before slow Argon2 hashing.
    // This stops concurrent burst attacks from evaluating more passwords than the throttle budget.
    await this.admitLogin(normalizedEmail, ip);

    const user = await this.adminUsers.findOneBy({ email: normalizedEmail });
    const valid = await this.hasher.verify(user?.passwordHash ?? null, password);

    if (user === null || !valid || !user.enabled) {
      const reason = loginFailureReason(user, valid);
      await this.audit.record({
        action: ADMIN_AUDIT_ACTIONS.LOGIN_FAILED,
        adminUserId: user?.id ?? null,
        ipAddress: ip,
        after: { email: normalizedEmail, reason },
      });
      throw new UnauthorizedException("Invalid email or password.");
    }

    await this.clearRateLimitOnSuccess(normalizedEmail, ip);
    return this.issueSession(user, ip, userAgent);
  }

  async changePassword(
    authentication: AdminAuthentication,
    currentPassword: string,
    newPassword: string,
    ip: string | null,
  ): Promise<void> {
    if (newPassword === currentPassword) {
      throw new BadRequestException("New password must be different from the current password.");
    }

    await this.checkRateLimit(authentication.user.email, ip);
    const valid = await this.hasher.verify(authentication.user.passwordHash, currentPassword);

    if (!valid) {
      await this.recordRateLimitFailure(authentication.user.email, ip);
      await this.audit.record({
        action: ADMIN_AUDIT_ACTIONS.PASSWORD_CHANGE_FAILED,
        adminUserId: authentication.user.id,
        entityType: "admin_user",
        entityId: authentication.user.id,
        ipAddress: ip,
      });
      throw new ForbiddenException("Current password is incorrect.");
    }

    // Targeted updates, not save(): save() writes back every field that differs from
    // this request's snapshot, which could undo a concurrent change such as disabling
    // the account.
    await this.adminUsers.update(authentication.user.id, {
      passwordHash: await this.hasher.hash(newPassword),
    });
    const revokedSessions = await this.sessions.revokeAllExcept(
      authentication.user.id,
      authentication.session.id,
    );
    await this.audit.record({
      action: ADMIN_AUDIT_ACTIONS.PASSWORD_CHANGED,
      adminUserId: authentication.user.id,
      entityType: "admin_user",
      entityId: authentication.user.id,
      ipAddress: ip,
      after: { revokedSessions },
    });
  }

  async logout(authentication: AdminAuthentication, ip: string | null): Promise<void> {
    await this.sessions.revoke(authentication.user.id, authentication.session.id);
    await this.audit.record({
      action: ADMIN_AUDIT_ACTIONS.LOGOUT,
      adminUserId: authentication.user.id,
      entityType: "admin_session",
      entityId: authentication.session.id,
      ipAddress: ip,
    });
  }

  listSessions(authentication: AdminAuthentication): Promise<AdminSession[]> {
    return this.sessions.listActive(authentication.user.id);
  }

  async revokeSession(
    authentication: AdminAuthentication,
    sessionId: string,
    ip: string | null,
  ): Promise<void> {
    if (!isUuid(sessionId)) {
      throw new NotFoundException("Not Found");
    }

    const revoked = await this.sessions.revoke(authentication.user.id, sessionId);
    if (!revoked) {
      throw new NotFoundException("Not Found");
    }

    await this.audit.record({
      action: ADMIN_AUDIT_ACTIONS.SESSION_REVOKED,
      adminUserId: authentication.user.id,
      entityType: "admin_session",
      entityId: sessionId,
      ipAddress: ip,
    });
  }

  private async issueSession(
    user: AdminUser,
    ip: string | null,
    userAgent: string | null,
  ): Promise<AdminLoginResult> {
    const { session, token } = await this.sessions.create(user, ip, userAgent);
    user.lastLoginAt = new Date();
    await this.adminUsers.update(user.id, { lastLoginAt: user.lastLoginAt });
    await this.audit.record({
      action: ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      adminUserId: user.id,
      entityType: "admin_session",
      entityId: session.id,
      ipAddress: ip,
    });

    return { user, session, token };
  }

  private async admitLogin(email: string, ip: string | null): Promise<void> {
    let result;
    try {
      result = await this.limiter.admit(email, ip);
    } catch {
      throw loginUnavailable();
    }

    if (!result.allowed) {
      throw new LoginRateLimitedException(result.retryAfterSeconds);
    }
  }

  // Password changes keep the read-then-record limiter: they run behind an authenticated session,
  // so a parallel burst there needs a stolen session and only guesses that session's own password.
  private async checkRateLimit(email: string, ip: string | null): Promise<void> {
    let result;
    try {
      result = await this.limiter.check(email, ip);
    } catch {
      throw loginUnavailable();
    }

    if (!result.allowed) {
      throw new LoginRateLimitedException(result.retryAfterSeconds);
    }
  }

  private async recordRateLimitFailure(email: string, ip: string | null): Promise<void> {
    try {
      await this.limiter.recordFailure(email, ip);
    } catch {
      throw loginUnavailable();
    }
  }

  private async clearRateLimitOnSuccess(email: string, ip: string | null): Promise<void> {
    try {
      await this.limiter.recordSuccess(email, ip);
    } catch {
      throw loginUnavailable();
    }
  }

}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function loginFailureReason(
  user: AdminUser | null,
  valid: boolean,
): "unknown_email" | "wrong_password" | "disabled" {
  if (user === null) {
    return "unknown_email";
  }

  if (!valid) {
    return "wrong_password";
  }

  return "disabled";
}

function loginUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException("Login is temporarily unavailable.");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
