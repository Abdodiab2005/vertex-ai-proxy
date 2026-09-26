/**
 * Alert-related open types.
 * New alert types can be added without migrations - they're plain strings.
 */
export const KNOWN_ALERT_TYPES = [
  "credit_80",
  "credit_100",
  "high_error_rate",
  "upstream_unavailable",
  "spend_threshold",
] as const;

export type AlertType = (typeof KNOWN_ALERT_TYPES)[number] | (string & {});

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["active", "acknowledged", "resolved"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export interface AlertView {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  dedupeKey: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  status: AlertStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedByAdminId: string | null;
  acknowledgedByAdminEmail: string | null;
  resolvedAt: string | null;
}

export interface AlertsListResponse {
  alerts: AlertView[];
  counts: {
    active: number;
    acknowledged: number;
  };
}

export type AcknowledgeAlertRequest = Record<string, never>;

export interface EvaluateAlertsResponse {
  /** True when another evaluation (another instance, or the timer) was already running. */
  skipped: boolean;
  created: number;
  resolved: number;
}