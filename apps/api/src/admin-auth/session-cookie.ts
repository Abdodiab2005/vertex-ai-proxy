import type { CookieOptions } from "express";

export const ADMIN_SESSION_COOKIE_NAME = "gw_admin_session";

export interface AdminSessionCookieEnv {
  NODE_ENV: "development" | "test" | "production";
  ADMIN_SESSION_TTL_HOURS: number;
  ADMIN_COOKIE_SECURE?: boolean;
}

export function adminSessionCookieOptions(
  env: AdminSessionCookieEnv,
): CookieOptions {
  return {
    ...baseCookieOptions(env),
    maxAge: env.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1_000,
  };
}

export function clearAdminSessionCookieOptions(
  env: AdminSessionCookieEnv,
): CookieOptions {
  return {
    ...baseCookieOptions(env),
    maxAge: 0,
  };
}

function baseCookieOptions(env: AdminSessionCookieEnv): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: env.ADMIN_COOKIE_SECURE ?? env.NODE_ENV === "production",
  };
}
