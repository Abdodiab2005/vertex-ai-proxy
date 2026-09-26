import { z } from "zod";

export const ListAlertsQuerySchema = z.object({
  status: z.enum(["active", "acknowledged", "resolved", "open"]).optional().default("open"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type ListAlertsQueryDto = z.infer<typeof ListAlertsQuerySchema>;

export const AcknowledgeAlertParamsSchema = z.object({
  id: z.string().uuid(),
});

export type AcknowledgeAlertParamsDto = z.infer<typeof AcknowledgeAlertParamsSchema>;

export type { AlertView, AlertsListResponse, EvaluateAlertsResponse } from "@gateway/contracts";
