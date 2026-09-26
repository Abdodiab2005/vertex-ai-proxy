import { z } from "zod";
import { createEnv } from "@gateway/shared";

export const databaseEnvSchema = z.object({
  DB_HOST: z.string().min(1).default("localhost"),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USERNAME: z.string().min(1).default("postgres"),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1).default("gemini_gateway"),
  DB_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export function loadDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  return createEnv(databaseEnvSchema, source);
}
