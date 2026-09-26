import {
  adminSessionCookieOptions,
  clearAdminSessionCookieOptions,
} from "./session-cookie.js";
import type { AdminSessionCookieEnv } from "./session-cookie.js";

function cookieEnv(
  overrides: Partial<AdminSessionCookieEnv> = {},
): AdminSessionCookieEnv {
  return {
    NODE_ENV: "development",
    ADMIN_SESSION_TTL_HOURS: 12,
    ...overrides,
  };
}

describe("admin session cookie options", () => {
  it.each([
    [cookieEnv(), false],
    [cookieEnv({ NODE_ENV: "production" }), true],
    [cookieEnv({ ADMIN_COOKIE_SECURE: true }), true],
    [cookieEnv({ NODE_ENV: "production", ADMIN_COOKIE_SECURE: false }), false],
  ])("uses secure=%s only when configured or in production", (env, secure) => {
    expect(adminSessionCookieOptions(env)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure,
      maxAge: 12 * 60 * 60 * 1_000,
    });
  });

  it("uses matching scope and security attributes when clearing the cookie", () => {
    const setOptions = adminSessionCookieOptions(
      cookieEnv({ NODE_ENV: "production" }),
    );
    const clearOptions = clearAdminSessionCookieOptions(
      cookieEnv({ NODE_ENV: "production" }),
    );

    expect(clearOptions).toMatchObject({
      httpOnly: setOptions.httpOnly,
      sameSite: setOptions.sameSite,
      path: setOptions.path,
      secure: setOptions.secure,
      maxAge: 0,
    });
  });
});
