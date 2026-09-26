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

export const ListAuditLogsQuerySchema = z.strictObject({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  entityId: z.uuid().optional(),
  adminUserId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: CursorSchema.optional(),
});

export type ListAuditLogsQueryDto = z.infer<typeof ListAuditLogsQuerySchema>;

export const AuditEntryViewSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  adminUserId: z.string().nullable(),
  adminEmail: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

export type AuditEntryView = z.infer<typeof AuditEntryViewSchema>;

export const ListAuditLogsResponseSchema = z.object({
  entries: z.array(AuditEntryViewSchema),
  nextCursor: z.string().nullable(),
});

export type ListAuditLogsResponse = z.infer<typeof ListAuditLogsResponseSchema>;

export const AuditActionsResponseSchema = z.object({
  actions: z.array(z.string()),
});

export type AuditActionsResponse = z.infer<typeof AuditActionsResponseSchema>;