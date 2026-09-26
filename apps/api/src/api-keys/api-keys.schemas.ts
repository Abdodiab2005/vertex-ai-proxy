import { z } from "zod";
import { isIP } from "node:net";
import { PUBLIC_ENDPOINTS } from "./api-key-auth.guard.js";
import { ApiKeyStatus, CreditTransactionType } from "@gateway/contracts";
import { KeyPresetOverridesSchema } from "./key-presets.schemas.js";

const ipOrCidrSchema = z.string().refine((val) => {
  if (val.includes("/")) {
    const [ip, prefix] = val.split("/");
    const numPrefix = parseInt(prefix || "", 10);
    if (!ip || !isIP(ip) || isNaN(numPrefix) || numPrefix < 0) return false;
    if (ip.includes(":") && numPrefix > 128) return false;
    if (!ip.includes(":") && numPrefix > 32) return false;
    return true;
  }
  return isIP(val) !== 0;
}, "Must be a valid IPv4/IPv6 address or CIDR notation");

// Model names in allowed/blocked lists match against both public names and aliases at request time.
// Entries are not validated against current models so that keys can reference models added later.
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Invalid model name");
const moneyRegex = /^-?\d{1,12}(\.\d{1,6})?$/;

export const CreateApiKeySchema = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  allowedModels: z.array(modelSchema).optional(),
  blockedModels: z.array(modelSchema).optional(),
  allowedEndpoints: z.array(z.enum(PUBLIC_ENDPOINTS)).optional(),
  expiresAt: z.iso?.datetime ? z.iso.datetime().refine((val) => new Date(val) > new Date(), "Must be in the future").optional() : z.string().datetime({ offset: true }).refine((val) => new Date(val) > new Date(), "Must be in the future").optional(),
  requestsPerMinute: z.number().int().positive().nullable().optional(),
  requestsPerDay: z.number().int().positive().nullable().optional(),
  tokensPerMinute: z.number().int().positive().nullable().optional(),
  tokensPerDay: z.number().int().positive().nullable().optional(),
  tokensPerMonth: z.number().int().positive().nullable().optional(),
  maxConcurrentRequests: z.number().int().positive().nullable().optional(),
  allowedIPs: z.array(ipOrCidrSchema).optional(),
  blockedIPs: z.array(ipOrCidrSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).optional(),
  initialCredit: z.string().regex(moneyRegex).optional().refine((val) => val === undefined || (!val.startsWith("-") && val !== "0"), "initialCredit must be positive"),
});

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;

export const UpdateApiKeySchema = CreateApiKeySchema.omit({ initialCredit: true }).partial().extend({
  expiresAt: z.iso?.datetime ? z.iso.datetime().refine((val) => new Date(val) > new Date(), "Must be in the future").nullable().optional() : z.string().datetime({ offset: true }).refine((val) => new Date(val) > new Date(), "Must be in the future").nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
});

export type UpdateApiKeyDto = z.infer<typeof UpdateApiKeySchema>;

export const ListApiKeysQuerySchema = z.strictObject({
  status: z.nativeEnum(ApiKeyStatus).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListApiKeysQueryDto = z.infer<typeof ListApiKeysQuerySchema>;

export const AddCreditSchema = z.strictObject({
  type: z.enum([CreditTransactionType.CREDIT_ADDED, CreditTransactionType.CREDIT_REMOVED, CreditTransactionType.REFUND, CreditTransactionType.MANUAL_ADJUSTMENT]),
  amount: z.string().regex(moneyRegex, "Invalid amount format"),
  description: z.string().optional()
}).refine((data) => {
  if (
    (data.type === CreditTransactionType.CREDIT_REMOVED || 
     data.type === CreditTransactionType.REFUND || 
     data.type === CreditTransactionType.MANUAL_ADJUSTMENT) && 
    !data.description
  ) {
    return false;
  }
  return true;
}, {
  message: "Description is required for removed, refund, and manual_adjustment",
  path: ["description"]
}).refine((data) => {
  const isNegative = data.amount.startsWith("-");
  const isZero = parseFloat(data.amount) === 0;
  
  if (data.type === CreditTransactionType.MANUAL_ADJUSTMENT) {
    return !isZero;
  }
  return !isNegative && !isZero;
}, {
  message: "Invalid sign for transaction type",
  path: ["amount"]
});

export type AddCreditDto = z.infer<typeof AddCreditSchema>;

export const UsageSummaryQuerySchema = z.strictObject({
  from: z.iso?.datetime ? z.iso.datetime().optional() : z.string().datetime({ offset: true }).optional(),
  to: z.iso?.datetime ? z.iso.datetime().optional() : z.string().datetime({ offset: true }).optional(),
});

export type UsageSummaryQueryDto = z.infer<typeof UsageSummaryQuerySchema>;

export const ListCreditsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListCreditsQueryDto = z.infer<typeof ListCreditsQuerySchema>;

const testerSchema = z.strictObject({
  testerName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().max(320).pipe(z.email()).optional(),
  googlePlayTesterNumber: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

export const BulkCreateApiKeysSchema = z
  .strictObject({
    presetId: z.uuid().optional(),
    namePrefix: z.string().trim().min(1).max(80),
    quantity: z.number().int().min(1).max(200),
    overrides: KeyPresetOverridesSchema.optional(),
    testers: z.array(testerSchema).max(200).optional(),
  })
  .refine((data) => data.testers === undefined || data.testers.length === data.quantity, {
    message: "testers length must equal quantity",
    path: ["testers"],
  });

export type BulkCreateApiKeysDto = z.infer<typeof BulkCreateApiKeysSchema>;
export type BulkTesterDto = z.infer<typeof testerSchema>;

