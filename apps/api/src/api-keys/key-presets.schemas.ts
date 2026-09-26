import { z } from "zod";
import { PUBLIC_ENDPOINTS } from "./api-key-auth.guard.js";

// Model names in allowed/blocked lists match against both public names and aliases at request time.
// Entries are not validated against current models so that keys can reference models added later.
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Invalid model name");
const moneyRegex = /^-?\d{1,12}(\.\d{1,6})?$/;

// Same money rule as API key creation: a positive decimal, never a float.
const positiveMoneySchema = z
  .string()
  .regex(moneyRegex)
  .refine((val) => !val.startsWith("-") && val !== "0", "initialCredit must be positive");

const limitSchema = z.number().int().positive().nullable();

// Same bound as keys.defaultLifetimeDays. Past this, now + days is not a
// representable Date, so a preset cannot outlive the settings default either.
const lifetimeDaysSchema = z.number().int().min(1).max(3650).nullable();

const keyPolicyFields = {
  description: z.string().max(1000).nullable().optional(),
  allowedModels: z.array(modelSchema).optional(),
  blockedModels: z.array(modelSchema).optional(),
  allowedEndpoints: z.array(z.enum(PUBLIC_ENDPOINTS)).optional(),
  requestsPerMinute: limitSchema.optional(),
  requestsPerDay: limitSchema.optional(),
  tokensPerMinute: limitSchema.optional(),
  tokensPerDay: limitSchema.optional(),
  tokensPerMonth: limitSchema.optional(),
  maxConcurrentRequests: limitSchema.optional(),
  initialCredit: positiveMoneySchema.nullable().optional(),
  lifetimeDays: lifetimeDaysSchema.optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).optional(),
};

export const KeyPresetOverridesSchema = z.strictObject(keyPolicyFields);

export const CreateKeyPresetSchema = z.strictObject({
  name: z.string().min(1).max(100),
  ...keyPolicyFields,
});

export type CreateKeyPresetDto = z.infer<typeof CreateKeyPresetSchema>;

export const UpdateKeyPresetSchema = CreateKeyPresetSchema.partial();

export type UpdateKeyPresetDto = z.infer<typeof UpdateKeyPresetSchema>;
