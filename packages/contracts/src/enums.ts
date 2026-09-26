/**
 * Real closed-set enums, reserved for the two state machines that directly gate
 * security/accounting control flow. Everything else that could grow with a new
 * provider (model provider, upstream auth method, billing dimension, ...) is a
 * plain string in ./open-types.ts instead, so adding one never needs a migration.
 */

export enum ApiKeyStatus {
  ACTIVE = "active",
  SUSPENDED = "suspended",
  REVOKED = "revoked",
  EXPIRED = "expired",
  CREDIT_EXHAUSTED = "credit_exhausted",
}

export enum CreditTransactionType {
  CREDIT_ADDED = "credit_added",
  CREDIT_REMOVED = "credit_removed",
  COST_CONSUMED = "cost_consumed",
  MANUAL_ADJUSTMENT = "manual_adjustment",
  REFUND = "refund",
}
