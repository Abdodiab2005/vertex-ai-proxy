import { z } from "zod";

// Base64URL-encoded cursor: "<createdAt ISO>|<id>"
export const CursorSchema = z.string().refine((val) => {
  try {
    const decoded = Buffer.from(val, "base64url").toString("utf8");
    const [iso, id] = decoded.split("|");
    if (!iso || !id) return false;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    // UUID validation
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  } catch {
    return false;
  }
}, "Invalid cursor format");

export const RequestLogStatusSchema = z.enum(["success", "error", "partial"]);

export const RequestLogEndpointSchema = z.enum([
  "generateContent",
  "streamGenerateContent",
  "countTokens",
  "embedContent",
  "batchEmbedContents",
  "models.list",
  "models.get",
]);

export const ListRequestLogsQuerySchema = z.strictObject({
  apiKeyId: z.uuid().optional(),
  model: z.string().trim().max(200).optional(),
  endpoint: RequestLogEndpointSchema.optional(),
  status: RequestLogStatusSchema.optional(),
  upstream: z.string().trim().max(200).optional(),
  errorCode: z.string().trim().max(100).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: CursorSchema.optional(),
});

export type ListRequestLogsQueryDto = z.infer<typeof ListRequestLogsQuerySchema>;

export const RequestLogViewSchema = z.object({
  id: z.uuid(),
  requestId: z.string(),
  apiKeyId: z.string().nullable(),
  apiKeyName: z.string().nullable(),
  apiKeyPrefix: z.string().nullable(),
  model: z.string().nullable(),
  endpoint: z.string(),
  status: z.string(),
  latencyMs: z.number().nullable(),
  inputTokens: z.string().nullable(),
  outputTokens: z.string().nullable(),
  otherUsageDimensions: z.record(z.string(), z.unknown()).nullable(),
  calculatedCost: z.string().nullable(),
  clientIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  upstream: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type RequestLogView = z.infer<typeof RequestLogViewSchema>;

export const ListRequestLogsResponseSchema = z.object({
  entries: z.array(RequestLogViewSchema),
  nextCursor: z.string().nullable(),
});

export type ListRequestLogsResponse = z.infer<typeof ListRequestLogsResponseSchema>;