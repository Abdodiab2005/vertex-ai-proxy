import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AdminSession, AdminUser } from "@gateway/database";
import { AdminSessionGuard } from "./admin-session.guard.js";
import type {
  AdminAuthenticatedRequest,
  AdminAuthentication,
} from "./admin-authentication.js";
import { AdminSessionsService, csrfTokenFor } from "./admin-sessions.service.js";
import { ADMIN_SESSION_COOKIE_NAME } from "./session-cookie.js";

const rawToken = "test-admin-session-token";

function authentication(): AdminAuthentication {
  const user: AdminUser = {
    id: "1d43cf93-8c8a-45c1-899f-f4e556850205",
    email: "admin@example.com",
    passwordHash: "stored-password-hash",
    enabled: true,
    lastLoginAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    sessions: [],
  };
  const session: AdminSession = {
    id: "5c23b0a1-2b7e-4754-bbb4-0a49e525cc42",
    adminUserId: user.id,
    adminUser: user,
    tokenHash: "session-token-hash",
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date("2026-02-01T00:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  return { user, session, csrfToken: "unused-by-resolve" };
}

function requestFor(
  method: string,
  csrfToken?: string,
): AdminAuthenticatedRequest {
  return {
    method,
    cookies: { [ADMIN_SESSION_COOKIE_NAME]: rawToken },
    headers: csrfToken === undefined ? {} : { "x-csrf-token": csrfToken },
  } as unknown as AdminAuthenticatedRequest;
}

function contextFor(request: AdminAuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardFor(): AdminSessionGuard {
  const sessions = {
    resolve: vi.fn().mockResolvedValue(authentication()),
  } as unknown as AdminSessionsService;

  return new AdminSessionGuard(sessions);
}

describe("AdminSessionGuard CSRF protection", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows %s requests without a CSRF header",
    async (method) => {
      const request = requestFor(method);

      await expect(guardFor().canActivate(contextFor(request))).resolves.toBe(true);
      expect(request.adminAuthentication?.csrfToken).toBe(csrfTokenFor(rawToken));
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects %s requests without a CSRF header",
    async (method) => {
      await expect(
        guardFor().canActivate(contextFor(requestFor(method))),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it("rejects an unsafe request with the wrong CSRF header", async () => {
    await expect(
      guardFor().canActivate(contextFor(requestFor("POST", "wrong-token"))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an unsafe request with the session-derived CSRF header", async () => {
    const request = requestFor("POST", csrfTokenFor(rawToken));

    await expect(guardFor().canActivate(contextFor(request))).resolves.toBe(true);
  });
});
