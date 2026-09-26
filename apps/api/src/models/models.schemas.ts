import { MODEL_AVAILABILITY_STATUSES, ROUTING_STRATEGIES } from "@gateway/contracts";
import { z } from "zod";
import { MODEL_NAME_PATTERN } from "./model-name.js";
import { isPositiveBigintString, isPriceString } from "./pricing-schedule.js";

const modelNameSchema = z.string().regex(MODEL_NAME_PATTERN, "Invalid model name");

const requiredTextSchema = z.string().trim().min(1).max(256);

const providerSchema = z.string().trim().min(1).max(64);

const tokenLimitSchema = z.number().int().positive().max(2_147_483_647);

const priceSchema = z.string().refine(isPriceString, {
  message: "Price must be a non-negative decimal with at most 8 fractional digits",
});

const unitSizeSchema = z.string().refine(isPositiveBigintString, {
  message: "unitSize must be a positive integer that fits in a bigint",
});

const capabilityFields = {
  supportsText: z.boolean(),
  supportsVision: z.boolean(),
  supportsAudio: z.boolean(),
  supportsVideo: z.boolean(),
  supportsFiles: z.boolean(),
  supportsTools: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsEmbeddings: z.boolean(),
};

export const createModelSchema = z.strictObject({
  publicName: modelNameSchema,
  upstreamModelName: requiredTextSchema,
  displayName: requiredTextSchema,
  provider: providerSchema.default("vertex-ai"),
  upstreamId: z.uuid(),
  // A model is not resolvable until an admin enables it, including one that
  // does not have pricing yet. The column default is true for rows inserted
  // outside this API; this route does not use that default.
  enabled: z.boolean().default(false),
  availabilityStatus: z.enum(MODEL_AVAILABILITY_STATUSES).default("available"),
  supportsText: capabilityFields.supportsText.default(true),
  supportsVision: capabilityFields.supportsVision.default(false),
  supportsAudio: capabilityFields.supportsAudio.default(false),
  supportsVideo: capabilityFields.supportsVideo.default(false),
  supportsFiles: capabilityFields.supportsFiles.default(false),
  supportsTools: capabilityFields.supportsTools.default(false),
  supportsStreaming: capabilityFields.supportsStreaming.default(false),
  supportsEmbeddings: capabilityFields.supportsEmbeddings.default(false),
  inputTokenLimit: tokenLimitSchema.nullable().optional(),
  outputTokenLimit: tokenLimitSchema.nullable().optional(),
});

export type CreateModelInput = z.output<typeof createModelSchema>;

export const updateModelSchema = z.strictObject({
  publicName: modelNameSchema.optional(),
  upstreamModelName: requiredTextSchema.optional(),
  displayName: requiredTextSchema.optional(),
  provider: providerSchema.optional(),
  upstreamId: z.uuid().optional(),
  enabled: z.boolean().optional(),
  availabilityStatus: z.enum(MODEL_AVAILABILITY_STATUSES).optional(),
  supportsText: capabilityFields.supportsText.optional(),
  supportsVision: capabilityFields.supportsVision.optional(),
  supportsAudio: capabilityFields.supportsAudio.optional(),
  supportsVideo: capabilityFields.supportsVideo.optional(),
  supportsFiles: capabilityFields.supportsFiles.optional(),
  supportsTools: capabilityFields.supportsTools.optional(),
  supportsStreaming: capabilityFields.supportsStreaming.optional(),
  supportsEmbeddings: capabilityFields.supportsEmbeddings.optional(),
  inputTokenLimit: tokenLimitSchema.nullable().optional(),
  outputTokenLimit: tokenLimitSchema.nullable().optional(),
});

export type UpdateModelInput = z.output<typeof updateModelSchema>;

export const addAliasSchema = z.strictObject({
  alias: modelNameSchema,
});

export type AddAliasInput = z.output<typeof addAliasSchema>;

export const addPricingRuleSchema = z.strictObject({
  billingDimension: z.string().trim().min(1).max(64),
  unitSize: unitSizeSchema.default("1000000"),
  price: priceSchema,
  currency: z.string().trim().min(1).max(16).default("USD"),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

export type AddPricingRuleInput = z.output<typeof addPricingRuleSchema>;

function blankToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

export const listModelsQuerySchema = z.strictObject({
  search: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  enabled: z.preprocess(blankToUndefined, z.enum(["true", "false"]).optional()),
  availability: z.preprocess(
    blankToUndefined,
    z.enum(MODEL_AVAILABILITY_STATUSES).optional(),
  ),
});

export type ListModelsQuery = z.output<typeof listModelsQuerySchema>;

export const syncModelsSchema = z.strictObject({
  upstreamId: z.uuid(),
});

export type SyncModelsInput = z.output<typeof syncModelsSchema>;

export const modelRouteInputSchema = z.strictObject({
  upstreamId: z.uuid(),
  priority: z.number().int().min(0).max(1000),
  enabled: z.boolean(),
});

export const updateModelRoutesSchema = z.strictObject({
  strategy: z.enum(ROUTING_STRATEGIES),
  routes: z.array(modelRouteInputSchema).refine(
    (routes) => {
      const ids = routes.map((r) => r.upstreamId);
      return new Set(ids).size === ids.length;
    },
    { message: "Duplicate upstreamId in routes is not allowed" },
  ),
});

export type UpdateModelRoutesInput = z.output<typeof updateModelRoutesSchema>;

