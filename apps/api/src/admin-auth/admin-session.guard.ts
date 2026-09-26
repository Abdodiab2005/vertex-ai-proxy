import { timingSafeEqual } from "node:crypto";
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { AdminSessionsService, csrfTokenFor } from "./admin-sessions.service.js";
import type {
  AdminAuthenticatedRequest,
  AdminAuthentication,
} from "./admin-authentication.js";
import { ADMIN_SESSION_COOKIE_NAME } from "./session-cookie.js";

const CSRF_PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly sessions: AdminSessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();
    const rawToken = request.cookies?.[ADMIN_SESSION_COOKIE_NAME];

    if (typeof rawToken !== "string" || rawToken.length === 0) {
      throw new UnauthorizedException("Unauthorized");
    }

    const resolved = await this.sessions.resolve(rawToken);
    if (resolved === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const csrfToken = csrfTokenFor(rawToken);
    if (
      CSRF_PROTECTED_METHODS.has(request.method.toUpperCase()) &&
      !csrfTokensMatch(request.headers["x-csrf-token"], csrfToken)
    ) {
      throw new ForbiddenException("Forbidden");
    }

    request.adminAuthentication = {
      ...resolved,
      csrfToken,
    } satisfies AdminAuthentication;

    return true;
  }
}

export function csrfTokensMatch(
  suppliedToken: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof suppliedToken !== "string") {
    return false;
  }

  const supplied = Buffer.from(suppliedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
