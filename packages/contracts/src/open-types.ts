/**
 * Open-ended vocabularies: stored as plain strings (not DB enums) because the
 * spec requires new upstream providers, auth methods, and billing dimensions to
 * be addable without code changes or migrations. The `KNOWN_*` arrays document
 * today's known values for admin UI dropdowns and validation; they are not
 * exhaustive constraints.
 */

export const KNOWN_MODEL_PROVIDERS = ["vertex-ai"] as const;
export type ModelProvider = (typeof KNOWN_MODEL_PROVIDERS)[number] | (string & {});

export const KNOWN_UPSTREAM_AUTH_METHODS = [
  "application-default-credentials",
  "service-account",
  "api-key",
] as const;
export type UpstreamAuthMethod = (typeof KNOWN_UPSTREAM_AUTH_METHODS)[number] | (string & {});

export const KNOWN_UPSTREAM_CONNECTION_STATUSES = [
  "connected",
  "authentication_failed",
  "permission_denied",
  "model_unavailable",
  "quota_exhausted",
  "network_error",
  "upstream_error",
  "unknown",
] as const;
export type UpstreamConnectionStatus =
  | (typeof KNOWN_UPSTREAM_CONNECTION_STATUSES)[number]
  | (string & {});

export const MODEL_AVAILABILITY_STATUSES = ["available", "unavailable"] as const;
export type ModelAvailabilityStatus = (typeof MODEL_AVAILABILITY_STATUSES)[number];

export const ROUTING_STRATEGIES = ["priority", "round_robin", "manual", "fallback"] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export const KNOWN_BILLING_DIMENSIONS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
  "audio_input_tokens",
  "audio_output_tokens",
  "image_output_tokens",
  "image_units",
] as const;
export type BillingDimension = (typeof KNOWN_BILLING_DIMENSIONS)[number] | (string & {});
