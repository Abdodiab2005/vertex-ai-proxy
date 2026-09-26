import { createHash } from "node:crypto";
import { ADMIN_AUDIT_ACTIONS } from "@gateway/contracts";
import { AdminSession, AdminUser, AuditLog } from "@gateway/database";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { Test as SuperTest } from "supertest";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapOwner, OwnerAlreadyExistsError } from "../src/cli/bootstrap-owner.js";
import { ConfigService } from "../src/config/config.service.js";
import { PasswordHasher } from "../src/security/password-hasher.js";
import {
  cookieHeaderValue,
  createE2eApp,
  resetE2eState,
  sessionCookie,
  type ParsedSetCookie,
} from "./e2e-app.js";

const OWNER_PASSWORD = "correct-horse-1";
const NEW_PASSWORD = "correct-horse-2";
const UNKNOWN_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GuardedRoute {
  label: string;
  send: (cookie?: string) => SuperTest;
}

describe("admin authentication", () => {
  let app: NestExpressApplication | undefined;
  let httpServer: ReturnType<NestExpressApplication["getHttpServer"]>;

  beforeAll(async () => {
    app = await createE2eApp();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetE2eState(requiredApp());
  });

  it("bootstraps the owner once and refuses a second bootstrap", async () => {
    const password = "bootstrap-password";
    const created = await bootstrapOwner(dataSource(), new PasswordHasher(), {
      email: "  Owner@Example.COM  ",
      password,
    });

    expect(created.email).toBe("owner@example.com");
    expect(created.id).toMatch(UUID_PATTERN);

    const user = await dataSource()
      .getRepository(AdminUser)
      .findOneByOrFail({ id: created.id });
    expect(user.email).toBe("owner@example.com");
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.passwordHash).not.toContain(password);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.OWNER_BOOTSTRAPPED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.adminUserId).toBe(created.id);
    expectNoSecret(audits, password);

    await expect(
      bootstrapOwner(dataSource(), new PasswordHasher(), {
        email: "second@example.com",
        password: "another-password",
      }),
    ).rejects.toBeInstanceOf(OwnerAlreadyExistsError);

    expect(await dataSource().getRepository(AdminUser).count()).toBe(1);
    expect(await dataSource().getRepository(AuditLog).count()).toBe(1);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.OWNER_BOOTSTRAPPED)).toHaveLength(1);
  });

  it("logs in with a hashed HttpOnly session cookie and returns the same admin from /admin/auth/me", async () => {
    const owner = await bootOwner();
    const response = await postLogin("owner@example.com", OWNER_PASSWORD, "203.0.113.10");

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("stack");
    expect(response.body.admin).toEqual({
      id: owner.id,
      email: "owner@example.com",
      lastLoginAt: expect.any(String),
    });
    expect(Date.parse(response.body.admin.lastLoginAt)).not.toBeNaN();
    expect(response.body.csrfToken).toEqual(expect.any(String));
    expect(response.body.csrfToken.length).toBeGreaterThan(0);
    expect(response.body.session.id).toMatch(UUID_PATTERN);
    expect(Date.parse(response.body.session.expiresAt)).toBeGreaterThan(Date.now());

    const cookie = sessionCookie(response);
    expect(cookie.name).toBe("gw_admin_session");
    expect(cookie.value.length).toBeGreaterThan(0);
    expect(cookie.attributes.httponly).toBe(true);
    expect(String(cookie.attributes.samesite).toLowerCase()).toBe("strict");
    expect(cookie.attributes.path).toBe("/");
    const env = requiredApp().get(ConfigService).env;
    expect(cookie.attributes["max-age"]).toBe(String(env.ADMIN_SESSION_TTL_HOURS * 60 * 60));
    const secure = env.ADMIN_COOKIE_SECURE ?? env.NODE_ENV === "production";
    if (secure) {
      expect(cookie.attributes.secure).toBe(true);
    } else {
      expect(cookie.attributes.secure).toBeUndefined();
    }

    const stored = await dataSource()
      .getRepository(AdminSession)
      .findOneByOrFail({ id: response.body.session.id });
    const tokenHash = createHash("sha256").update(cookie.value).digest("hex");
    expect(stored.tokenHash).toBe(tokenHash);
    expect(stored.tokenHash).not.toBe(cookie.value);

    const user = await dataSource()
      .getRepository(AdminUser)
      .findOneByOrFail({ id: owner.id });
    expect(user.lastLoginAt).toBeInstanceOf(Date);
    expect(response.body.admin.lastLoginAt).toBe(user.lastLoginAt?.toISOString());

    const succeeded = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.adminUserId).toBe(owner.id);
    expectNoSecret(succeeded, OWNER_PASSWORD);

    const me = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", cookieHeaderValue(cookie));
    expect(me.status).toBe(200);
    expect(me.body.admin).toEqual(response.body.admin);
    expect(me.body.csrfToken).toBe(response.body.csrfToken);
  });

  it("returns the same generic 401 for a wrong password and an unknown email, without auditing the password", async () => {
    await bootOwner();
    const wrongPassword = "wrong-password-value";
    const wrong = await postLogin("owner@example.com", wrongPassword, "203.0.113.20");
    const unknown = await postLogin(
      "missing-admin@example.com",
      wrongPassword,
      "203.0.113.20",
    );

    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body).toEqual(unknown.body);
    expectNestError(wrong, 401, "Invalid email or password.", "Unauthorized");
    expectNoSecret(wrong.body, wrongPassword);
    expectNoSecret(unknown.body, wrongPassword);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGIN_FAILED);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expectNoSecret(audits, wrongPassword);
  });

  it("rate limits an account from one IP after 5 failures, including the correct password, while another IP still gets 401", async () => {
    await bootOwner();
    const blockedIp = "203.0.113.30";
    const otherIp = "203.0.113.31";
    const wrongPassword = "wrong-password-value";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await postLogin("owner@example.com", wrongPassword, blockedIp);
      expect(response.status, `failure ${attempt}`).toBe(401);
      expect(response.body.message).toBe("Invalid email or password.");
    }

    const blocked = await postLogin("owner@example.com", OWNER_PASSWORD, blockedIp);
    expectNestError(
      blocked,
      429,
      "Too many attempts. Please try again later.",
      "Too Many Requests",
    );
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expectNoSecret(blocked.body, OWNER_PASSWORD);

    const otherIpAttempt = await postLogin("owner@example.com", wrongPassword, otherIp);
    expectNestError(otherIpAttempt, 401, "Invalid email or password.", "Unauthorized");
    expect(otherIpAttempt.headers["retry-after"]).toBeUndefined();

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGIN_FAILED);
    expect(audits.length).toBeGreaterThanOrEqual(5);
    expectNoSecret(audits, wrongPassword);
    expectNoSecret(audits, OWNER_PASSWORD);
  });

  it("rate limits an IP after 20 failures spread across different emails", async () => {
    const ip = "203.0.113.40";
    const password = "ip-spread-wrong-password";

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const response = await postLogin(`limit-${attempt}@example.com`, password, ip);
      expect(response.status, `failure ${attempt}`).toBe(401);
      expect(response.body.message).toBe("Invalid email or password.");
    }

    const blocked = await postLogin("limit-21@example.com", password, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expectNoSecret(blocked.body, password);

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGIN_FAILED);
    expect(audits).toHaveLength(20);
    expectNoSecret(audits, password);
  });

  it("rejects a parallel burst of wrong-password logins beyond the cap atomically without evaluating extra attempts, and resets on correct login", async () => {
    await bootOwner();
    const burstIp = "203.0.113.45";
    const wrongPassword = "burst-wrong-password";

    const burstRequests = Array.from({ length: 12 }, () =>
      postLogin("owner@example.com", wrongPassword, burstIp),
    );
    const burstResponses = await Promise.all(burstRequests);

    const evaluated = burstResponses.filter((res) => res.status === 401);
    const throttled = burstResponses.filter((res) => res.status === 429);

    expect(evaluated).toHaveLength(5);
    expect(throttled).toHaveLength(7);

    for (const res of throttled) {
      expect(res.headers["retry-after"]).toMatch(/^\d+$/);
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      expect(res.body.message).toBe("Too many attempts. Please try again later.");
    }

    const burstAudits = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGIN_FAILED);
    expect(burstAudits).toHaveLength(5);
    expectNoSecret(burstAudits, wrongPassword);

    const resetIp = "203.0.113.46";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await postLogin("owner@example.com", wrongPassword, resetIp);
      expect(response.status).toBe(401);
    }

    const successfulLogin = await postLogin("owner@example.com", OWNER_PASSWORD, resetIp);
    expect(successfulLogin.status).toBe(200);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await postLogin("owner@example.com", wrongPassword, resetIp);
      expect(response.status, `post-reset failure ${attempt}`).toBe(401);
    }

    const blockedAfterReset = await postLogin("owner@example.com", wrongPassword, resetIp);
    expect(blockedAfterReset.status).toBe(429);
  });

  it("rejects missing, bogus, expired, and disabled sessions on every guarded route", async () => {
    const routes = guardedRoutes();
    await expectUnauthorized(routes);
    await expectUnauthorized(routes, "gw_admin_session=not-a-real-session");

    const owner = await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.50");
    const before = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", loggedIn.cookieHeader);
    expect(before.status).toBe(200);

    await dataSource()
      .getRepository(AdminSession)
      .update({ id: loggedIn.sessionId }, { expiresAt: new Date(Date.now() - 60_000) });
    await expectUnauthorized(routes, loggedIn.cookieHeader);

    await dataSource()
      .getRepository(AdminSession)
      .update(
        { id: loggedIn.sessionId },
        { expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      );
    const restored = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", loggedIn.cookieHeader);
    expect(restored.status).toBe(200);

    await dataSource()
      .getRepository(AdminUser)
      .update({ id: owner.id }, { enabled: false });
    await expectUnauthorized(routes, loggedIn.cookieHeader);
  });

  it("rejects logout without a matching CSRF token and keeps the session", async () => {
    await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.60");

    const missing = await request(httpServer)
      .post("/admin/auth/logout")
      .set("Cookie", loggedIn.cookieHeader);
    expectNestError(missing, 403, "Forbidden", "Forbidden");

    const wrong = await request(httpServer)
      .post("/admin/auth/logout")
      .set("Cookie", loggedIn.cookieHeader)
      .set("x-csrf-token", "not-the-csrf-token");
    expectNestError(wrong, 403, "Forbidden", "Forbidden");

    const me = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", loggedIn.cookieHeader);
    expect(me.status).toBe(200);
    expect(me.body.admin.id).toBe(loggedIn.adminId);
    expect(me.body.csrfToken).toBe(loggedIn.csrfToken);
    expect(await auditsFor(ADMIN_AUDIT_ACTIONS.LOGOUT)).toHaveLength(0);
  });

  it("logout revokes the session, clears the cookie, and writes an audit row", async () => {
    const owner = await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.70");

    const response = await request(httpServer)
      .post("/admin/auth/logout")
      .set("Cookie", loggedIn.cookieHeader)
      .set("x-csrf-token", loggedIn.csrfToken);

    expect(response.status).toBe(204);
    const cleared = sessionCookie(response);
    expect(cleared.name).toBe("gw_admin_session");
    expect(cleared.value).toBe("");
    expect(cleared.attributes["max-age"]).toBe("0");
    expect(cleared.attributes.path).toBe("/");
    expect(cleared.attributes.httponly).toBe(true);
    expect(String(cleared.attributes.samesite).toLowerCase()).toBe("strict");

    const me = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", loggedIn.cookieHeader);
    expectNestError(me, 401, "Unauthorized", "Unauthorized");

    const audits = await auditsFor(ADMIN_AUDIT_ACTIONS.LOGOUT);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.adminUserId).toBe(owner.id);
  });

  it("password change revokes other sessions and replaces the password", async () => {
    await bootOwner();
    const session1 = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.80");
    const session2 = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.81");
    expect(session1.token).not.toBe(session2.token);

    const changed = await request(httpServer)
      .post("/admin/auth/password")
      .set("Cookie", session1.cookieHeader)
      .set("x-csrf-token", session1.csrfToken)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(204);

    const revoked = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", session2.cookieHeader);
    expectNestError(revoked, 401, "Unauthorized", "Unauthorized");

    const kept = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", session1.cookieHeader);
    expect(kept.status).toBe(200);
    expect(kept.body.admin.id).toBe(session1.adminId);

    const oldPassword = await postLogin("owner@example.com", OWNER_PASSWORD, "203.0.113.82");
    expectNestError(oldPassword, 401, "Invalid email or password.", "Unauthorized");

    const newPassword = await postLogin("owner@example.com", NEW_PASSWORD, "203.0.113.82");
    expect(newPassword.status).toBe(200);
    expect(newPassword.body.admin.email).toBe("owner@example.com");
  });

  it("rejects a wrong current password with 403", async () => {
    await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.90");
    const submitted = "not-the-current";

    const response = await request(httpServer)
      .post("/admin/auth/password")
      .set("Cookie", loggedIn.cookieHeader)
      .set("x-csrf-token", loggedIn.csrfToken)
      .send({ currentPassword: submitted, newPassword: NEW_PASSWORD });

    expectNestError(response, 403, "Current password is incorrect.", "Forbidden");
    expectNoSecret(response.body, submitted);
    expectNoSecret(response.body, NEW_PASSWORD);

    const stillCurrent = await postLogin("owner@example.com", OWNER_PASSWORD, "203.0.113.91");
    expect(stillCurrent.status).toBe(200);
  });

  it("rejects a new password equal to the current password with 400", async () => {
    await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.100");

    const response = await request(httpServer)
      .post("/admin/auth/password")
      .set("Cookie", loggedIn.cookieHeader)
      .set("x-csrf-token", loggedIn.csrfToken)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: OWNER_PASSWORD });

    expectNestError(
      response,
      400,
      "New password must be different from the current password.",
      "Bad Request",
    );
    expectNoSecret(response.body, OWNER_PASSWORD);
  });

  it("rejects a too-short new password with 400", async () => {
    await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "203.0.113.110");
    const submitted = "tiny";

    const response = await request(httpServer)
      .post("/admin/auth/password")
      .set("Cookie", loggedIn.cookieHeader)
      .set("x-csrf-token", loggedIn.csrfToken)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: submitted });

    expect(response.status).toBe(400);
    expect(response.body.statusCode).toBe(400);
    expect(response.body.error).toBe("Bad Request");
    expect(response.body).not.toHaveProperty("stack");
    expectNoSecret(response.body, submitted);
    expectNoSecret(response.body, OWNER_PASSWORD);
  });

  it("lists active sessions and revokes another session", async () => {
    await bootOwner();
    const session1 = await loginSession("owner@example.com", OWNER_PASSWORD, "198.51.100.10", "e2e-session-one");
    const session2 = await loginSession("owner@example.com", OWNER_PASSWORD, "198.51.100.11", "e2e-session-two");

    const listed = await request(httpServer)
      .get("/admin/auth/sessions")
      .set("Cookie", session1.cookieHeader);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);

    const sessions = listed.body.sessions as Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      ipAddress: string | null;
      userAgent: string | null;
      current: boolean;
    }>;
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessions.find((session) => session.id === session1.sessionId)?.current).toBe(true);
    expect(sessions.find((session) => session.id === session2.sessionId)?.current).toBe(false);
    expect(sessions[0]?.id).toBe(session2.sessionId);
    expect(Date.parse(sessions[0]?.createdAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(sessions[1]?.createdAt ?? ""),
    );

    for (const session of sessions) {
      expect(session.id).toMatch(UUID_PATTERN);
      expect(Date.parse(session.createdAt)).not.toBeNaN();
      expect(Date.parse(session.expiresAt)).not.toBeNaN();
      expect(session.ipAddress === null || typeof session.ipAddress === "string").toBe(true);
      expect(session.userAgent === null || typeof session.userAgent === "string").toBe(true);
      expect(typeof session.current).toBe("boolean");
    }
    expect(sessions.find((session) => session.id === session1.sessionId)?.userAgent).toBe(
      "e2e-session-one",
    );
    expect(sessions.find((session) => session.id === session2.sessionId)?.userAgent).toBe(
      "e2e-session-two",
    );

    const revoked = await request(httpServer)
      .delete(`/admin/auth/sessions/${session2.sessionId}`)
      .set("Cookie", session1.cookieHeader)
      .set("x-csrf-token", session1.csrfToken);
    expect(revoked.status).toBe(204);

    const revokedMe = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", session2.cookieHeader);
    expectNestError(revokedMe, 401, "Unauthorized", "Unauthorized");

    const kept = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", session1.cookieHeader);
    expect(kept.status).toBe(200);

    const missing = await request(httpServer)
      .delete(`/admin/auth/sessions/${UNKNOWN_SESSION_ID}`)
      .set("Cookie", session1.cookieHeader)
      .set("x-csrf-token", session1.csrfToken);
    expectNestError(missing, 404, "Not Found", "Not Found");

    const stillThere = await request(httpServer)
      .get("/admin/auth/me")
      .set("Cookie", session1.cookieHeader);
    expect(stillThere.status).toBe(200);
  });

  it("returns zero dashboard counts on an empty database", async () => {
    await bootOwner();
    const loggedIn = await loginSession("owner@example.com", OWNER_PASSWORD, "198.51.100.20");

    const response = await request(httpServer)
      .get("/admin/dashboard/summary")
      .set("Cookie", loggedIn.cookieHeader);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      apiKeys: { total: 0, active: 0 },
      upstreams: { total: 0, enabled: 0 },
      models: { total: 0, enabled: 0 },
      usageToday: { requests: 0, costUsd: "0" },
    });
    expect(typeof response.body.usageToday.costUsd).toBe("string");
  });

  it("sends the nosniff content type options header", async () => {
    const unauthenticated = await request(httpServer).get("/admin/auth/me");
    expect(unauthenticated.headers["x-content-type-options"]).toBe("nosniff");

    await bootOwner();
    const authenticated = await postLogin("owner@example.com", OWNER_PASSWORD, "198.51.100.30");
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers["x-content-type-options"]).toBe("nosniff");
  });

  function requiredApp(): NestExpressApplication {
    if (app === undefined) {
      throw new Error("E2E app was not started");
    }
    return app;
  }

  function dataSource(): DataSource {
    return requiredApp().get(DataSource);
  }

  function bootOwner(): Promise<{ id: string; email: string }> {
    return bootstrapOwner(dataSource(), new PasswordHasher(), {
      email: "owner@example.com",
      password: OWNER_PASSWORD,
    });
  }

  function postLogin(email: string, password: string, ip: string, userAgent?: string) {
    const req = request(httpServer)
      .post("/admin/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password });
    if (userAgent !== undefined) {
      req.set("User-Agent", userAgent);
    }
    return req;
  }

  async function loginSession(
    email: string,
    password: string,
    ip: string,
    userAgent?: string,
  ): Promise<{
    adminId: string;
    sessionId: string;
    csrfToken: string;
    token: string;
    cookieHeader: string;
    cookie: ParsedSetCookie;
  }> {
    const response = await postLogin(email, password, ip, userAgent);
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    return {
      adminId: response.body.admin.id,
      sessionId: response.body.session.id,
      csrfToken: response.body.csrfToken,
      token: cookie.value,
      cookieHeader: cookieHeaderValue(cookie),
      cookie,
    };
  }

  function guardedRoutes(): GuardedRoute[] {
    return [
      {
        label: "GET /admin/auth/me",
        send: (cookie) => withCookie(request(httpServer).get("/admin/auth/me"), cookie),
      },
      {
        label: "POST /admin/auth/logout",
        send: (cookie) => withCookie(request(httpServer).post("/admin/auth/logout"), cookie),
      },
      {
        label: "POST /admin/auth/password",
        send: (cookie) =>
          withCookie(
            request(httpServer)
              .post("/admin/auth/password")
              .send({ currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD }),
            cookie,
          ),
      },
      {
        label: "GET /admin/auth/sessions",
        send: (cookie) =>
          withCookie(request(httpServer).get("/admin/auth/sessions"), cookie),
      },
      {
        label: "DELETE /admin/auth/sessions/:id",
        send: (cookie) =>
          withCookie(
            request(httpServer).delete(`/admin/auth/sessions/${UNKNOWN_SESSION_ID}`),
            cookie,
          ),
      },
      {
        label: "GET /admin/dashboard/summary",
        send: (cookie) =>
          withCookie(request(httpServer).get("/admin/dashboard/summary"), cookie),
      },
    ];
  }

  async function expectUnauthorized(routes: GuardedRoute[], cookie?: string): Promise<void> {
    for (const route of routes) {
      const response = await route.send(cookie);
      expect(response.status, route.label).toBe(401);
      expect(response.body, route.label).toEqual({
        statusCode: 401,
        message: "Unauthorized",
        error: "Unauthorized",
      });
      expect(response.body, route.label).not.toHaveProperty("stack");
    }
  }

  function auditsFor(action: string): Promise<AuditLog[]> {
    return dataSource().getRepository(AuditLog).find({ where: { action } });
  }
});

function withCookie(req: SuperTest, cookie?: string): SuperTest {
  return cookie === undefined ? req : req.set("Cookie", cookie);
}

function expectNestError(
  response: Response,
  status: number,
  message: string,
  error: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ statusCode: status, message, error });
  expect(response.body).not.toHaveProperty("stack");
}

function expectNoSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}
