import { CreditSummary } from "../../credits/credit-ledger.service.js";
import { Upstream } from "@gateway/database";
import { SpendStatus } from "../../settings/spend-guard.service.js";

export interface RuleContext {
  // For credit rules
  creditSummary?: CreditSummary;
  // For high_error_rate rule: public requests in the window, from request_logs
  requestCounts?: { total: number; errors: number };
  // For upstream_unavailable rule
  upstream?: Upstream;
  // For spend_threshold rule
  spendStatus?: SpendStatus;
}

/**
 * Result of evaluating a single alert rule.
 * - shouldAlert: whether an alert should be active (condition met)
 * - dedupeKey: unique key for this alert instance (e.g., "credit_80:<apiKeyId>")
 * - title: human-readable title for the alert
 * - message: detailed message for the alert
 * - data: additional context data for the alert
 * - severity: the alert severity
 */
export interface RuleEvaluation {
  shouldAlert: boolean;
  dedupeKey: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  severity: "info" | "warning" | "critical";
}

/**
 * Base interface for an alert rule.
 * Each rule is a pure decision function that takes context and returns evaluation.
 */
export interface AlertRule {
  /** Unique identifier for this rule (matches alert type) */
  readonly type: string;
  /** Human-readable name for the rule */
  readonly name: string;
  /** Evaluate the rule against the given context */
  evaluate(context: RuleContext): RuleEvaluation | null;
}