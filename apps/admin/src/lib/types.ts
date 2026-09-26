export type AuthMeResponse = {
  admin: { id: string; email: string; lastLoginAt: string | null };
  csrfToken: string;
  session: { id: string; expiresAt: string };
};

export type UpstreamProvider = "vertex-ai";

export type UpstreamAuthMethod =
  | "application-default-credentials"
  | "service-account"
  | "api-key";

export type UpstreamStatus =
  | "unknown"
  | "connected"
  | "authentication_failed"
  | "permission_denied"
  | "model_unavailable"
  | "quota_exhausted"
  | "network_error"
  | "upstream_error";

export type ProbeStatus = Exclude<UpstreamStatus, "unknown">;

export type UpstreamView = {
  id: string;
  name: string;
  provider: UpstreamProvider;
  enabled: boolean;
  projectId: string;
  location: string;
  authMethod: UpstreamAuthMethod;
  hasCredentials: boolean;
  credentialSummary: string | null;
  priority: number;
  status: UpstreamStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpstreamsListResponse = {
  upstreams: UpstreamView[];
};

export type UpstreamResponse = {
  upstream: UpstreamView;
};

export type CreateUpstreamRequest = {
  name: string;
  provider?: UpstreamProvider;
  enabled?: boolean;
  projectId: string;
  location: string;
  authMethod: UpstreamAuthMethod;
  credentials?: Record<string, unknown> | string;
  priority?: number;
};

export type PatchUpstreamRequest = {
  name?: string;
  provider?: UpstreamProvider;
  enabled?: boolean;
  projectId?: string;
  location?: string;
  authMethod?: UpstreamAuthMethod;
  credentials?: Record<string, unknown> | string;
  priority?: number;
};

export type TestUpstreamResponse = {
  result: {
    status: ProbeStatus;
    httpStatus: number | null;
    message: string;
    checkedAt: string;
  };
  upstream: UpstreamView;
};

export const UPSTREAM_AUTH_METHODS = [
  "application-default-credentials",
  "service-account",
  "api-key",
] as const satisfies readonly UpstreamAuthMethod[];

export const AUTH_METHOD_LABELS: Record<UpstreamAuthMethod, string> = {
  "application-default-credentials": "Application Default Credentials",
  "service-account": "Service account key",
  "api-key": "API key (Vertex AI express mode)",
};

export const UPSTREAM_STATUS_LABELS: Record<UpstreamStatus, string> = {
  unknown: "Unknown",
  connected: "Connected",
  authentication_failed: "Authentication failed",
  permission_denied: "Permission denied",
  model_unavailable: "Model unavailable",
  quota_exhausted: "Quota exhausted",
  network_error: "Network error",
  upstream_error: "Upstream error",
};

export const LOCATION_SUGGESTIONS = [
  "global",
  "us-central1",
  "us-east5",
  "europe-west4",
  "asia-northeast1",
  "us",
  "eu",
] as const;

export function isUpstreamAuthMethod(value: string): value is UpstreamAuthMethod {
  return (UPSTREAM_AUTH_METHODS as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUpstreamResponse(value: unknown): value is UpstreamResponse {
  if (!isRecord(value) || !isRecord(value.upstream)) {
    return false;
  }
  return typeof value.upstream.id === "string";
}

export function isTestUpstreamResponse(value: unknown): value is TestUpstreamResponse {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.upstream)) {
    return false;
  }
  const { result } = value;
  return (
    typeof result.status === "string" &&
    typeof result.message === "string" &&
    typeof result.checkedAt === "string" &&
    (result.httpStatus === null || typeof result.httpStatus === "number") &&
    typeof value.upstream.id === "string"
  );
}

export type RoutingStrategy = "priority" | "round_robin" | "manual" | "fallback";

export type ModelRouteView = {
  id: string | null;
  upstreamId: string;
  upstreamName: string;
  priority: number;
  enabled: boolean;
  upstreamEnabled: boolean;
  upstreamStatus: UpstreamStatus;
  isDefault: boolean;
};

export type ModelRoutesResponse = {
  strategy: RoutingStrategy;
  routes: ModelRouteView[];
};

export type ModelView = {
  id: string;
  publicName: string;
  upstreamModelName: string;
  displayName: string;
  provider: UpstreamProvider;
  enabled: boolean;
  availabilityStatus: "available" | "unavailable";
  supportsText: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsFiles: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  upstreamId: string;
  upstream: { id: string; name: string };
  aliases: string[];
  routeCount: number;
  strategy: RoutingStrategy;
  currentPricing: Array<{
    billingDimension: string;
    unitSize: string;
    price: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
};

// API Key types

export type ApiKeyStatus =
  | "active"
  | "suspended"
  | "revoked"
  | "expired"
  | "credit_exhausted";

export type AllowedEndpoint =
  | "generateContent"
  | "streamGenerateContent"
  | "countTokens"
  | "embedContent"
  | "batchEmbedContents"
  | "models.list"
  | "models.get";

export type ApiKeyView = {
  id: string;
  name: string;
  keyPrefix: string;
  status: ApiKeyStatus;
  description: string | null;
  allowedModels: string[];
  blockedModels: string[];
  allowedEndpoints: AllowedEndpoint[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxConcurrentRequests: number | null;
  allowedIPs: string[];
  blockedIPs: string[];
  metadata: object | null;
  tags: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  credit?: {
    remaining: string;
    consumed: string;
  };
  requestsToday?: number;
  tokensThisMonth?: string;
};

export type PricingRuleView = {
  id: string;
  modelId: string;
  billingDimension: string;
  unitSize: string;
  price: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelsListResponse = {
  models: ModelView[];
};

export type ModelSyncSummary = {
  discovered: number;
  created: string[];
  markedAvailable: string[];
  markedUnavailable: string[];
  conflicts: string[];
};

export type ModelSyncResponse = {
  summary: ModelSyncSummary;
};

export function isModelSyncResponse(value: unknown): value is ModelSyncResponse {
  if (!isRecord(value) || !isRecord(value.summary)) {
    return false;
  }
  const { summary } = value;
  return (
    typeof summary.discovered === "number" &&
    isStringArray(summary.created) &&
    isStringArray(summary.markedAvailable) &&
    isStringArray(summary.markedUnavailable) &&
    isStringArray(summary.conflicts)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export type ModelResponse = {
  model: ModelView;
};

export type PricingRulesResponse = {
  rules: PricingRuleView[];
};

export function isModelResponse(value: unknown): value is ModelResponse {
  if (!isRecord(value) || !isRecord(value.model)) {
    return false;
  }
  return typeof value.model.id === "string";
}

export function isPricingRulesResponse(value: unknown): value is PricingRulesResponse {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return false;
  }
  return true;
}

export type ApiKeysListResponse = {
  apiKeys: ApiKeyView[];
  total: number;
};

export type ApiKeyResponse = {
  apiKey: ApiKeyView;
};

export type ApiKeyDetailResponse = {
  apiKey: ApiKeyView;
  deletable: boolean;
};

export type CreditSummaryView = {
  currency: string;
  totalAdded: string;
  totalRemoved: string;
  totalConsumed: string;
  totalRefunded: string;
  adjustmentsNet: string;
  remaining: string;
};

export type CreditTransactionView = {
  id: string;
  type: string;
  amount: string;
  description: string | null;
  createdAt: string;
};

export type CreditsListResponse = {
  summary: CreditSummaryView;
  transactions: CreditTransactionView[];
  total: number;
};

export type CreditWriteResponse = {
  summary: CreditSummaryView;
};

export type UsageSummaryResponse = {
  byModel: Array<{
    modelId: string;
    publicName: string | null;
    requests: number;
    costUsd: string;
  }>;
  byDimension: Array<{
    dimension: string;
    costUsd: string;
  }>;
};

export type LimitValue = number | null;

export type LimitsUsageResponse = {
  limits: {
    requestsPerMinute: LimitValue;
    requestsPerDay: LimitValue;
    tokensPerMinute: LimitValue;
    tokensPerDay: LimitValue;
    tokensPerMonth: LimitValue;
    maxConcurrentRequests: LimitValue;
  };
  usage: {
    requestsThisMinute: number;
    requestsToday: number;
    tokensThisMinute: number;
    tokensToday: number;
    tokensThisMonth: number;
  };
};

export function isCreditSummary(value: unknown): value is CreditSummaryView {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.currency === "string" &&
    typeof value.totalAdded === "string" &&
    typeof value.totalRemoved === "string" &&
    typeof value.totalConsumed === "string" &&
    typeof value.totalRefunded === "string" &&
    typeof value.adjustmentsNet === "string" &&
    typeof value.remaining === "string"
  );
}

export function isCreditsListResponse(value: unknown): value is CreditsListResponse {
  if (!isRecord(value) || !isCreditSummary(value.summary) || !Array.isArray(value.transactions)) {
    return false;
  }
  if (typeof value.total !== "number" || !Number.isInteger(value.total)) {
    return false;
  }
  return value.transactions.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.type === "string" &&
      typeof item.amount === "string" &&
      (item.description === null || typeof item.description === "string") &&
      typeof item.createdAt === "string",
  );
}

export function isCreditWriteResponse(value: unknown): value is CreditWriteResponse {
  return isRecord(value) && isCreditSummary(value.summary);
}

export function isUsageSummaryResponse(value: unknown): value is UsageSummaryResponse {
  if (!isRecord(value) || !Array.isArray(value.byModel) || !Array.isArray(value.byDimension)) {
    return false;
  }
  const modelsOk = value.byModel.every(
    (item) =>
      isRecord(item) &&
      typeof item.modelId === "string" &&
      (item.publicName === null || typeof item.publicName === "string") &&
      typeof item.requests === "number" &&
      typeof item.costUsd === "string",
  );
  const dimensionsOk = value.byDimension.every(
    (item) => isRecord(item) && typeof item.dimension === "string" && typeof item.costUsd === "string",
  );
  return modelsOk && dimensionsOk;
}

function isLimitValue(value: unknown): value is LimitValue {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isLimitsUsageResponse(value: unknown): value is LimitsUsageResponse {
  if (!isRecord(value) || !isRecord(value.limits) || !isRecord(value.usage)) {
    return false;
  }
  const { limits, usage } = value;
  return (
    isLimitValue(limits.requestsPerMinute) &&
    isLimitValue(limits.requestsPerDay) &&
    isLimitValue(limits.tokensPerMinute) &&
    isLimitValue(limits.tokensPerDay) &&
    isLimitValue(limits.tokensPerMonth) &&
    isLimitValue(limits.maxConcurrentRequests) &&
    isCounter(usage.requestsThisMinute) &&
    isCounter(usage.requestsToday) &&
    isCounter(usage.tokensThisMinute) &&
    isCounter(usage.tokensToday) &&
    isCounter(usage.tokensThisMonth)
  );
}

export type CreateApiKeyRequest = {
  name: string;
  description?: string;
  allowedModels?: string[];
  blockedModels?: string[];
  allowedEndpoints?: AllowedEndpoint[];
  expiresAt?: string;
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerMinute?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
  maxConcurrentRequests?: number;
  allowedIPs?: string[];
  blockedIPs?: string[];
  tags?: string[];
};

export type PatchApiKeyRequest = {
  name?: string;
  description?: string | null;
  allowedModels?: string[];
  blockedModels?: string[];
  allowedEndpoints?: AllowedEndpoint[];
  expiresAt?: string | null;
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
  tokensPerMinute?: number | null;
  tokensPerDay?: number | null;
  tokensPerMonth?: number | null;
  maxConcurrentRequests?: number | null;
  allowedIPs?: string[];
  blockedIPs?: string[];
  tags?: string[];
};

export type CreateApiKeyResponse = {
  apiKey: ApiKeyView;
  rawKey: string;
};

export const ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  "generateContent",
  "streamGenerateContent",
  "countTokens",
  "embedContent",
  "batchEmbedContents",
  "models.list",
  "models.get",
] as const;

export const ENDPOINT_LABELS: Record<AllowedEndpoint, string> = {
  generateContent: "generateContent",
  streamGenerateContent: "streamGenerateContent",
  countTokens: "countTokens",
  embedContent: "embedContent",
  batchEmbedContents: "batchEmbedContents",
  "models.list": "models.list",
  "models.get": "models.get",
};

export const API_KEY_STATUS_LABELS: Record<ApiKeyStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  revoked: "Revoked",
  expired: "Expired",
  credit_exhausted: "Credit exhausted",
};

export function isApiKeyStatus(value: string): value is ApiKeyStatus {
  return (Object.keys(API_KEY_STATUS_LABELS) as readonly string[]).includes(value);
}

export function isAllowedEndpoint(value: string): value is AllowedEndpoint {
  return (ALLOWED_ENDPOINTS as readonly string[]).includes(value);
}

export function isApiKeyResponse(value: unknown): value is ApiKeyResponse {
  if (!isRecord(value) || !isRecord(value.apiKey)) {
    return false;
  }
  return typeof value.apiKey.id === "string";
}

export function isCreateApiKeyResponse(value: unknown): value is CreateApiKeyResponse {
  if (!isRecord(value) || !isRecord(value.apiKey) || typeof value.rawKey !== "string") {
    return false;
  }
  return typeof value.apiKey.id === "string";
}

export type KeyPresetView = {
  id: string;
  name: string;
  description: string | null;
  allowedModels: string[];
  blockedModels: string[];
  allowedEndpoints: AllowedEndpoint[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxConcurrentRequests: number | null;
  initialCredit: string | null;
  lifetimeDays: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type KeyPresetsListResponse = {
  presets: KeyPresetView[];
};

export type KeyPresetResponse = {
  preset: KeyPresetView;
};

export type KeyPresetWriteRequest = {
  name: string;
  description?: string | null;
  allowedModels?: string[];
  blockedModels?: string[];
  allowedEndpoints?: AllowedEndpoint[];
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
  tokensPerMinute?: number | null;
  tokensPerDay?: number | null;
  tokensPerMonth?: number | null;
  maxConcurrentRequests?: number | null;
  initialCredit?: string | null;
  lifetimeDays?: number | null;
  tags?: string[];
};

export type BulkTesterInput = {
  testerName?: string;
  email?: string;
  googlePlayTesterNumber?: string;
  notes?: string;
};

export type BulkCreateApiKeysRequest = {
  presetId?: string;
  namePrefix: string;
  quantity: number;
  overrides?: Omit<KeyPresetWriteRequest, "name">;
  testers?: BulkTesterInput[];
};

export type BulkCreatedKey = {
  apiKey: ApiKeyView & {
    credit?: { remaining: string; consumed: string };
  };
  rawKey: string;
};

export type BulkCreateApiKeysResponse = {
  keys: BulkCreatedKey[];
  csv: string;
};

export function isKeyPresetResponse(value: unknown): value is KeyPresetResponse {
  if (!isRecord(value) || !isRecord(value.preset)) {
    return false;
  }
  return typeof value.preset.id === "string" && typeof value.preset.name === "string";
}

export function isBulkCreateApiKeysResponse(value: unknown): value is BulkCreateApiKeysResponse {
  if (!isRecord(value) || typeof value.csv !== "string" || !Array.isArray(value.keys)) {
    return false;
  }
  return value.keys.every(
    (item) =>
      isRecord(item) &&
      typeof item.rawKey === "string" &&
      isRecord(item.apiKey) &&
      typeof item.apiKey.id === "string" &&
      typeof item.apiKey.name === "string",
  );
}

// Audit Log types
export type AuditLogAction =
  | "admin.login.succeeded"
  | "admin.login.failed"
  | "admin.logout"
  | "admin.password.changed"
  | "admin.password.change_failed"
  | "admin.session.revoked"
  | "admin.owner.bootstrapped"
  | "admin.api_key.created"
  | "admin.api_key.updated"
  | "admin.api_key.suspended"
  | "admin.api_key.reactivated"
  | "admin.api_key.revoked"
  | "admin.api_key.regenerated"
  | "admin.api_key.counters_reset"
  | "admin.api_key.deleted"
  | "admin.api_key.bulk_created"
  | "admin.key_preset.created"
  | "admin.key_preset.updated"
  | "admin.key_preset.deleted"
  | "admin.model.created"
  | "admin.model.updated"
  | "admin.model.alias_added"
  | "admin.model.alias_removed"
  | "admin.pricing.rule_added"
  | "admin.pricing.rule_deleted"
  | "admin.upstream.created"
  | "admin.upstream.updated"
  | "admin.upstream.tested"
  | string;

export type AuditLogEntry = {
  id: string;
  action: string;
  adminUserId: string | null;
  adminEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

export type AuditLogsListResponse = {
  entries: AuditLogEntry[];
  nextCursor: string | null;
};

export type AuditActionsResponse = {
  actions: string[];
};

export function isAuditLogsListResponse(value: unknown): value is AuditLogsListResponse {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return false;
  }
  return typeof value.nextCursor === "string" || value.nextCursor === null;
}

export function isAuditActionsResponse(value: unknown): value is AuditActionsResponse {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    return false;
  }
  return value.actions.every((a) => typeof a === "string");
}

// Settings types

export const SETTING_VALUE_TYPES = [
  "boolean",
  "integer",
  "decimal",
  "string",
  "string-list",
  "url",
] as const;

export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

export type SettingValue = boolean | number | string | string[] | null;

export type SettingOption = {
  value: number | null;
  label: string;
};

export type SettingDefinition = {
  key: string;
  label: string;
  description: string;
  type: SettingValueType;
  default: SettingValue;
  nullable: boolean;
  options?: SettingOption[];
};

export type SettingsResponse = {
  settings: Record<string, SettingValue>;
  definitions: SettingDefinition[];
};

export type SpendStatus = {
  trackedSpendUsd: string;
  upstreamBudget: string | null;
  safetyReserve: string;
  usableTarget: string | null;
  thresholdReached: boolean;
  label: string;
};

export function isSettingValue(value: unknown): value is SettingValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSettingValueType(value: unknown): value is SettingValueType {
  return typeof value === "string" && (SETTING_VALUE_TYPES as readonly string[]).includes(value);
}

function isSettingOption(value: unknown): value is SettingOption {
  if (!isRecord(value) || typeof value.label !== "string") {
    return false;
  }
  return value.value === null || typeof value.value === "number";
}

function isSettingDefinition(value: unknown): value is SettingDefinition {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.key !== "string" ||
    typeof value.label !== "string" ||
    typeof value.description !== "string" ||
    !isSettingValueType(value.type) ||
    !isSettingValue(value.default) ||
    typeof value.nullable !== "boolean"
  ) {
    return false;
  }
  if (value.options === undefined) {
    return true;
  }
  return Array.isArray(value.options) && value.options.every((option) => isSettingOption(option));
}

export function isSettingsResponse(value: unknown): value is SettingsResponse {
  if (!isRecord(value) || !isRecord(value.settings) || !Array.isArray(value.definitions)) {
    return false;
  }
  const settings = value.settings;
  const definitions = value.definitions;
  if (!definitions.every((definition) => isSettingDefinition(definition))) {
    return false;
  }
  return definitions.every((definition) => isSettingValue(settings[definition.key]));
}

export function isSettingsUpdateResponse(
  value: unknown,
): value is { settings: Record<string, SettingValue> } {
  if (!isRecord(value) || !isRecord(value.settings)) {
    return false;
  }
  return Object.values(value.settings).every((item) => isSettingValue(item));
}

export function isSpendStatus(value: unknown): value is SpendStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.trackedSpendUsd === "string" &&
    (value.upstreamBudget === null || typeof value.upstreamBudget === "string") &&
    typeof value.safetyReserve === "string" &&
    (value.usableTarget === null || typeof value.usableTarget === "string") &&
    typeof value.thresholdReached === "boolean" &&
    typeof value.label === "string"
  );
}
// Request Log types

export type RequestLogStatus = "success" | "error" | "partial";

export type RequestLogEndpoint = AllowedEndpoint;

export type RequestLogEntry = {
  id: string;
  requestId: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  model: string | null;
  endpoint: string;
  status: string;
  latencyMs: number | null;
  inputTokens: string | null;
  outputTokens: string | null;
  otherUsageDimensions: Record<string, unknown> | null;
  calculatedCost: string | null;
  clientIp: string | null;
  userAgent: string | null;
  upstream: string | null;
  errorCode: string | null;
  createdAt: string;
};

export type RequestLogsListResponse = {
  entries: RequestLogEntry[];
  nextCursor: string | null;
};

export function isRequestLogsListResponse(value: unknown): value is RequestLogsListResponse {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return false;
  }
  return typeof value.nextCursor === "string" || value.nextCursor === null;
}

export const REQUEST_LOG_STATUS_LABELS: Record<RequestLogStatus, string> = {
  success: "Success",
  error: "Error",
  partial: "Partial",
};

export const REQUEST_LOG_ENDPOINT_LABELS: Record<RequestLogEndpoint, string> = {
  generateContent: "generateContent",
  streamGenerateContent: "streamGenerateContent",
  countTokens: "countTokens",
  embedContent: "embedContent",
  batchEmbedContents: "batchEmbedContents",
  "models.list": "models.list",
  "models.get": "models.get",
};

export type AnalyticsRangeName = "24h" | "7d" | "30d";

export type AnalyticsBucket = "hour" | "day";

export type RankedKey = {
  apiKeyId: string;
  name: string;
  keyPrefix: string;
  requests: number;
  cost: string;
};

export type RankedModel = {
  modelId: string;
  publicName: string;
  requests: number;
  cost: string;
};

export type AnalyticsUpstream = {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  lastCheckedAt: string | null;
};

export type AnalyticsOverview = {
  range: { from: string; to: string };
  requestsToday: number;
  requestsThisMonth: number;
  requestsInRange: number;
  inputTokensInRange: string;
  outputTokensInRange: string;
  costToday: string;
  costThisMonth: string;
  costInRange: string;
  credit: {
    totalAllocated: string;
    totalConsumed: string;
    totalRemaining: string;
  };
  keys: {
    active: number;
    suspended: number;
    revoked: number;
    expired: number;
    creditExhausted: number;
  };
  topKeys: RankedKey[];
  topModels: RankedModel[];
  currentRpm: number;
  errorRate: string;
  activeStreams: number;
  upstreams: AnalyticsUpstream[];
};

export type AnalyticsTimeseries = {
  bucket: AnalyticsBucket;
  points: { t: string; value: string }[];
};

export type UsageReport = {
  range: { from: string; to: string };
  totals: {
    requestCount: number;
    successCount: number;
    errorCount: number;
    partialCount: number;
    inputTokens: string;
    outputTokens: string;
    otherUsage: Record<string, string>;
    cost: string;
    costUndeterminedCount: number;
    avgLatencyMs: number | null;
  };
  byDay: { day: string; requests: number; cost: string }[];
  byModel: RankedModel[];
  byKey: RankedKey[];
};

function isRankedKey(value: unknown): value is RankedKey {
  return (
    isRecord(value) &&
    typeof value.apiKeyId === "string" &&
    typeof value.name === "string" &&
    typeof value.keyPrefix === "string" &&
    typeof value.requests === "number" &&
    typeof value.cost === "string"
  );
}

function isRankedModel(value: unknown): value is RankedModel {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    typeof value.publicName === "string" &&
    typeof value.requests === "number" &&
    typeof value.cost === "string"
  );
}

export function isAnalyticsOverview(value: unknown): value is AnalyticsOverview {
  if (!isRecord(value) || !isRecord(value.range) || !isRecord(value.credit) || !isRecord(value.keys)) {
    return false;
  }
  return (
    typeof value.range.from === "string" &&
    typeof value.range.to === "string" &&
    typeof value.requestsToday === "number" &&
    typeof value.requestsThisMonth === "number" &&
    typeof value.requestsInRange === "number" &&
    typeof value.inputTokensInRange === "string" &&
    typeof value.outputTokensInRange === "string" &&
    typeof value.costToday === "string" &&
    typeof value.costThisMonth === "string" &&
    typeof value.costInRange === "string" &&
    typeof value.credit.totalAllocated === "string" &&
    typeof value.credit.totalConsumed === "string" &&
    typeof value.credit.totalRemaining === "string" &&
    typeof value.keys.active === "number" &&
    typeof value.keys.suspended === "number" &&
    typeof value.keys.revoked === "number" &&
    typeof value.keys.expired === "number" &&
    typeof value.keys.creditExhausted === "number" &&
    Array.isArray(value.topKeys) &&
    value.topKeys.every((key) => isRankedKey(key)) &&
    Array.isArray(value.topModels) &&
    value.topModels.every((model) => isRankedModel(model)) &&
    typeof value.currentRpm === "number" &&
    typeof value.errorRate === "string" &&
    typeof value.activeStreams === "number" &&
    Array.isArray(value.upstreams) &&
    value.upstreams.every(
      (upstream) =>
        isRecord(upstream) &&
        typeof upstream.id === "string" &&
        typeof upstream.name === "string" &&
        typeof upstream.enabled === "boolean" &&
        typeof upstream.status === "string" &&
        (upstream.lastCheckedAt === null || typeof upstream.lastCheckedAt === "string"),
    )
  );
}

export function isAnalyticsTimeseries(value: unknown): value is AnalyticsTimeseries {
  if (!isRecord(value) || (value.bucket !== "hour" && value.bucket !== "day") || !Array.isArray(value.points)) {
    return false;
  }
  return value.points.every(
    (point) => isRecord(point) && typeof point.t === "string" && typeof point.value === "string",
  );
}

export function isUsageReport(value: unknown): value is UsageReport {
  if (!isRecord(value) || !isRecord(value.range) || !isRecord(value.totals)) {
    return false;
  }
  const totals = value.totals;
  if (!isRecord(totals) || !isRecord(totals.otherUsage)) {
    return false;
  }
  const otherUsage = totals.otherUsage;
  return (
    typeof value.range.from === "string" &&
    typeof value.range.to === "string" &&
    typeof totals.requestCount === "number" &&
    typeof totals.successCount === "number" &&
    typeof totals.errorCount === "number" &&
    typeof totals.partialCount === "number" &&
    typeof totals.inputTokens === "string" &&
    typeof totals.outputTokens === "string" &&
    Object.values(otherUsage).every((total) => typeof total === "string") &&
    typeof totals.cost === "string" &&
    typeof totals.costUndeterminedCount === "number" &&
    (totals.avgLatencyMs === null || typeof totals.avgLatencyMs === "number") &&
    Array.isArray(value.byDay) &&
    value.byDay.every(
      (row) =>
        isRecord(row) &&
        typeof row.day === "string" &&
        typeof row.requests === "number" &&
        typeof row.cost === "string",
    ) &&
    Array.isArray(value.byModel) &&
    value.byModel.every((row) => isRankedModel(row)) &&
    Array.isArray(value.byKey) &&
    value.byKey.every((row) => isRankedKey(row))
  );
}

// Alert types

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertStatus = "active" | "acknowledged" | "resolved";

export type AlertStatusFilter = AlertStatus | "open";

export type AlertView = {
  id: string;
  type: string;
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
};

export type AlertsListResponse = {
  alerts: AlertView[];
  counts: {
    active: number;
    acknowledged: number;
  };
};

export type EvaluateAlertsResponse = {
  skipped: boolean;
  created: number;
  resolved: number;
};

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  active: "Active",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

export const ALERT_STATUS_COLORS: Record<AlertStatus, string> = {
  active: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  acknowledged: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  resolved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
};

export const ALERT_SEVERITY_COLORS: Record<AlertSeverity, string> = {
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export function isAlertView(value: unknown): value is AlertView {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.severity === "string" &&
    typeof value.dedupeKey === "string" &&
    typeof value.title === "string" &&
    typeof value.message === "string" &&
    (value.data === null || isRecord(value.data)) &&
    typeof value.status === "string" &&
    typeof value.firstSeenAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    (value.acknowledgedAt === null || typeof value.acknowledgedAt === "string") &&
    (value.acknowledgedByAdminId === null || typeof value.acknowledgedByAdminId === "string") &&
    (value.acknowledgedByAdminEmail === null || typeof value.acknowledgedByAdminEmail === "string") &&
    (value.resolvedAt === null || typeof value.resolvedAt === "string")
  );
}

export function isAlertsListResponse(value: unknown): value is AlertsListResponse {
  if (!isRecord(value) || !Array.isArray(value.alerts) || !isRecord(value.counts)) {
    return false;
  }
  return (
    value.alerts.every((a) => isAlertView(a)) &&
    typeof value.counts.active === "number" &&
    typeof value.counts.acknowledged === "number"
  );
}

export function isEvaluateAlertsResponse(value: unknown): value is EvaluateAlertsResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.skipped === "boolean" &&
    typeof value.created === "number" &&
    typeof value.resolved === "number"
  );
}
