import { z } from "zod";
import { EncryptionKeyError, createEnv, parseEncryptionKey } from "@gateway/shared";
import { databaseEnvSchema } from "@gateway/database";

export const DEFAULT_PUBLIC_MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
export const DEFAULT_ADMIN_MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;

const trustProxySchema = z
  .string()
  .default("loopback")
  .transform((value) => {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }

    if (/^\d+$/.test(value)) {
      return Number(value);
    }

    return value;
  });

// Fail boot on a missing or mistyped key. A default key would encrypt every
// upstream credential with a secret that is in source control.
const credentialsEncryptionKeySchema = z.string().transform((value, ctx) => {
  try {
    return parseEncryptionKey(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message:
        error instanceof EncryptionKeyError ? error.message : "Invalid encryption key",
    });
    return z.NEVER;
  }
});

const adminCookieSecureSchema = z
  .preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).optional(),
  )
  .transform((value) => (value === undefined ? undefined : value === "true"));

const logIncludeStackSchema = z
  .preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).optional(),
  )
  .transform((value) => value === "true");

const metricsTokenSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(16).optional(),
);

const logFormatSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.enum(["json", "pretty"]).optional(),
);

const apiEnvBaseSchema = databaseEnvSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PUBLIC_MAX_REQUEST_BODY_BYTES),
  ADMIN_MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ADMIN_MAX_REQUEST_BODY_BYTES),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  TRUST_PROXY: trustProxySchema,
  ADMIN_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
  ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT_IP: z.coerce.number().int().min(1).default(5),
  ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT: z.coerce.number().int().min(1).default(50),
  ADMIN_LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().min(1).default(20),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  ADMIN_COOKIE_SECURE: adminCookieSecureSchema,
  CREDENTIALS_ENCRYPTION_KEY: credentialsEncryptionKeySchema,
  LOG_FORMAT: logFormatSchema,
  LOG_INCLUDE_STACK: logIncludeStackSchema,
  METRICS_TOKEN: metricsTokenSchema,
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),
});

export const apiEnvSchema = apiEnvBaseSchema.transform((env) => ({
  ...env,
  // Local logs should remain easy to scan, while production defaults to a
  // machine-readable format without requiring an environment override.
  LOG_FORMAT: env.LOG_FORMAT ?? (env.NODE_ENV === "production" ? "json" : "pretty"),
}));

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return createEnv(apiEnvSchema, source);
}
