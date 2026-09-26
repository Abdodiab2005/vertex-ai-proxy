import "reflect-metadata";

import type { InjectionToken } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { Response } from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app-setup.js";
import { ConfigService } from "../src/config/config.service.js";
import { RedisService } from "../src/redis/redis.service.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { assertSafeTestTargets } from "./safe-targets.js";
import { E2ePublicController } from "./e2e-public.controller.js";
import { ApiKeysModule } from "../src/api-keys/api-keys.module.js";

export interface E2eProviderOverride {
  provide: InjectionToken;
  useValue: unknown;
}

export async function createE2eApp(options?: {
  overrides?: readonly E2eProviderOverride[];
}): Promise<NestExpressApplication> {
  assertSafeTestTargets();

  let builder = Test.createTestingModule({
    imports: [AppModule, ApiKeysModule],
    controllers: [E2ePublicController],
  });
  for (const override of options?.overrides ?? []) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ["error", "warn"],
  });
  configureApp(app, app.get(ConfigService).env);
  await app.init();
  return app;
}

export async function resetE2eState(app: NestExpressApplication): Promise<void> {
  assertSafeTestTargets();

  await app
    .get(DataSource)
    .query(
      "TRUNCATE TABLE admin_sessions, admin_users, audit_logs, api_keys, key_presets, model_aliases, pricing_rules, models, upstreams, system_settings, credit_transactions, usage_records, request_logs, alerts CASCADE",
    );
  // The settings cache survives a truncate because tests write the table directly.
  app.get(SettingsService).clearCache();
  await app.get(RedisService).client.flushdb();
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
}

export function setCookieHeaders(response: Response): string[] {
  const raw = response.headers["set-cookie"];
  if (raw === undefined) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

export function parseSetCookie(header: string): ParsedSetCookie {
  const [pair, ...parts] = header.split(";").map((part) => part.trim());
  const separator = pair?.indexOf("=") ?? -1;
  if (pair === undefined || separator < 0) {
    throw new Error(`Unparseable Set-Cookie header: ${header}`);
  }

  const attributes: Record<string, string | true> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      attributes[part.toLowerCase()] = true;
      continue;
    }
    attributes[part.slice(0, equals).toLowerCase()] = part.slice(equals + 1);
  }

  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes,
  };
}

export function sessionCookie(response: Response): ParsedSetCookie {
  const header = setCookieHeaders(response).find((value) =>
    value.startsWith("gw_admin_session="),
  );
  if (header === undefined) {
    throw new Error(
      `Response is missing the gw_admin_session cookie. Set-Cookie: ${JSON.stringify(response.headers["set-cookie"])}`,
    );
  }
  return parseSetCookie(header);
}

export function cookieHeaderValue(cookie: ParsedSetCookie): string {
  return `${cookie.name}=${cookie.value}`;
}
