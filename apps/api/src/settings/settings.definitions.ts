import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { MODEL_NAME_PATTERN } from "../models/model-name.js";

export const MAINTENANCE_MESSAGE_DEFAULT =
  "The gateway is under maintenance. Please retry later.";

const decimalString = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);

const absoluteHttpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}, "Must be an absolute http(s) URL");

export type SettingValueType =
  | "boolean"
  | "integer"
  | "decimal"
  | "string"
  | "string-list"
  | "url";

export type SettingOption = {
  readonly value: number | null;
  readonly label: string;
};

function defineSetting<S extends z.ZodType>(definition: {
  schema: S;
  default: z.output<S>;
  label: string;
  description: string;
  type: SettingValueType;
  nullable: boolean;
  options?: readonly SettingOption[];
}): {
  schema: S;
  default: z.output<S>;
  label: string;
  description: string;
  type: SettingValueType;
  nullable: boolean;
  options?: readonly SettingOption[];
} {
  return definition;
}

export const SETTINGS_DEFINITIONS = {
  "gateway.enabled": defineSetting({
    schema: z.boolean(),
    default: true,
    label: "Gateway enabled",
    description: "When off, the public API rejects every request.",
    type: "boolean",
    nullable: false,
  }),
  "gateway.maintenanceMode": defineSetting({
    schema: z.boolean(),
    default: false,
    label: "Maintenance mode",
    description: "When on, the public API rejects requests with the maintenance message.",
    type: "boolean",
    nullable: false,
  }),
  "gateway.maintenanceMessage": defineSetting({
    schema: z.string().min(1).max(300),
    default: MAINTENANCE_MESSAGE_DEFAULT,
    label: "Maintenance message",
    description: "Returned to clients while maintenance mode is on.",
    type: "string",
    nullable: false,
  }),
  "gateway.killSwitch": defineSetting({
    schema: z.boolean(),
    default: false,
    label: "Kill switch",
    description: "Rejects every public request immediately, including requests with no API key.",
    type: "boolean",
    nullable: false,
  }),
  "keys.defaultRequestsPerMinute": defineSetting({
    schema: z.number().int().min(1).nullable(),
    default: null,
    label: "Default requests per minute",
    description: "Used when a new API key omits a per-minute limit. Empty means no default limit.",
    type: "integer",
    nullable: true,
  }),
  "keys.defaultRequestsPerDay": defineSetting({
    schema: z.number().int().min(1).nullable(),
    default: null,
    label: "Default requests per day",
    description: "Used when a new API key omits a daily request limit. Empty means no default limit.",
    type: "integer",
    nullable: true,
  }),
  "keys.defaultMaxConcurrentRequests": defineSetting({
    schema: z.number().int().min(1).nullable(),
    default: null,
    label: "Default max concurrent requests",
    description: "Used when a new API key omits a concurrency limit. Empty means no default limit.",
    type: "integer",
    nullable: true,
  }),
  "keys.defaultInitialCredit": defineSetting({
    schema: decimalString.nullable(),
    default: null,
    label: "Default initial credit",
    description:
      "Credit granted to a new API key when its creation omits an initial balance. Empty grants none.",
    type: "decimal",
    nullable: true,
  }),
  "keys.defaultAllowedModels": defineSetting({
    schema: z.array(z.string().regex(MODEL_NAME_PATTERN, "Invalid model name")),
    default: [],
    label: "Default allowed models",
    description:
      "Model names applied when a new API key omits allowed models. An empty list allows every model.",
    type: "string-list",
    nullable: false,
  }),
  "keys.defaultLifetimeDays": defineSetting({
    schema: z.number().int().min(1).max(3650).nullable(),
    default: null,
    label: "Default key lifetime (days)",
    description:
      "When set, a new API key that omits an expiry expires this many days after it is created.",
    type: "integer",
    nullable: true,
  }),
  "timeouts.requestMs": defineSetting({
    schema: z.number().int().min(1000).max(600_000),
    default: 120_000,
    label: "Request timeout (ms)",
    description: "Maximum time a public request may run.",
    type: "integer",
    nullable: false,
  }),
  "timeouts.streamIdleMs": defineSetting({
    schema: z.number().int().min(1000).max(600_000),
    default: 60_000,
    label: "Stream idle timeout (ms)",
    description: "Maximum time a stream may stay silent before it is closed.",
    type: "integer",
    nullable: false,
  }),
  "timeouts.upstreamConnectMs": defineSetting({
    schema: z.number().int().min(1000).max(120_000),
    default: 15_000,
    label: "Upstream connect timeout (ms)",
    description: "Maximum time to wait while connecting to an upstream.",
    type: "integer",
    nullable: false,
  }),
  "media.maxInlineBytes": defineSetting({
    schema: z.number().int().min(1024).max(100 * 1024 * 1024),
    default: 15 * 1024 * 1024,
    label: "Inline media limit (bytes)",
    description:
      "Maximum decoded size of inline media (images, audio, video, PDFs) in one request. The request body limit (PUBLIC_MAX_REQUEST_BODY_BYTES) still applies to the base64 form.",
    type: "integer",
    nullable: false,
  }),
  "media.allowFileUris": defineSetting({
    schema: z.boolean(),
    default: false,
    label: "Allow file URIs",
    description:
      "When off, fileData parts are rejected. A gs:// URI would otherwise be read with this gateway's own Vertex credentials.",
    type: "boolean",
    nullable: false,
  }),
  "media.fileUriHoldTokens": defineSetting({
    schema: z.number().int().min(1000).max(2_000_000),
    default: 50_000,
    label: "File URI hold (tokens)",
    description:
      "Tokens reserved for each fileData part when file URIs are allowed. The gateway cannot see the object's size.",
    type: "integer",
    nullable: false,
  }),
  "logging.metadataRetentionDays": defineSetting({
    schema: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable(),
    default: 90,
    label: "Metadata retention (days)",
    description: "How long request metadata is kept. Forever keeps it until it is deleted.",
    type: "integer",
    nullable: true,
    options: [
      { value: 7, label: "7 days" },
      { value: 30, label: "30 days" },
      { value: 90, label: "90 days" },
      { value: null, label: "Forever" },
    ],
  }),
  "logging.contentLoggingEnabled": defineSetting({
    // Storing prompts and responses needs its own opt-in design and retention policy, which doesn't
    // exist yet, so the switch cannot be turned on rather than silently doing nothing.
    schema: z.literal(false),
    default: false,
    label: "Content logging",
    description: "Not available: the gateway stores request metadata only, never prompts or responses.",
    type: "boolean",
    nullable: false,
  }),
  "billing.currency": defineSetting({
    schema: z.string().regex(/^[A-Z]{3}$/),
    default: "USD",
    label: "Billing currency",
    description: "Three-letter currency code used for prices and spend.",
    type: "string",
    nullable: false,
  }),
  "gateway.publicUrl": defineSetting({
    schema: absoluteHttpUrl.nullable(),
    default: null,
    label: "Public gateway URL",
    description: "Absolute http or https URL clients use to reach this gateway. Empty leaves it unset.",
    type: "url",
    nullable: true,
  }),
  "spend.upstreamBudget": defineSetting({
    schema: decimalString.nullable(),
    default: null,
    label: "Estimated upstream budget",
    description:
      "Your estimate of remaining Google Cloud credit. This is not the authoritative Google Cloud billing balance.",
    type: "decimal",
    nullable: true,
  }),
  "spend.safetyReserve": defineSetting({
    schema: decimalString,
    default: "0",
    label: "Safety reserve",
    description:
      "Amount held back from the estimated budget before tracked spend is treated as over the limit.",
    type: "decimal",
    nullable: false,
  }),
  "spend.blockWhenThresholdReached": defineSetting({
    schema: z.boolean(),
    default: false,
    label: "Block when the threshold is reached",
    description: "Reject new AI requests once tracked spend reaches the usable target.",
    type: "boolean",
    nullable: false,
  }),
};

export type SettingKey = keyof typeof SETTINGS_DEFINITIONS;

export type SettingsSnapshot = {
  [K in SettingKey]: z.output<(typeof SETTINGS_DEFINITIONS)[K]["schema"]>;
};

export type SettingsPatch = Partial<SettingsSnapshot>;

export type SettingDefinitionView = {
  key: SettingKey;
  label: string;
  description: string;
  type: SettingValueType;
  default: SettingsSnapshot[SettingKey];
  nullable: boolean;
  options?: readonly SettingOption[];
};

export const settingKeys = Object.keys(SETTINGS_DEFINITIONS) as SettingKey[];

const settingKeySet = new Set<string>(settingKeys);

export function isSettingKey(key: string): key is SettingKey {
  return settingKeySet.has(key);
}

export function settingDefinitionViews(): SettingDefinitionView[] {
  return settingKeys.map((key) => {
    const definition = SETTINGS_DEFINITIONS[key];
    const view: SettingDefinitionView = {
      key,
      label: definition.label,
      description: definition.description,
      type: definition.type,
      default: definition.default,
      nullable: definition.nullable,
    };
    if (definition.options !== undefined) {
      view.options = definition.options;
    }
    return view;
  });
}

export function defaultSnapshot(): SettingsSnapshot {
  const snapshot = {} as SettingsSnapshot;
  for (const key of settingKeys) {
    writeSetting(snapshot, key, SETTINGS_DEFINITIONS[key].default);
  }
  return snapshot;
}

export function cloneSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
  return structuredClone(snapshot);
}

export function writeSetting(
  snapshot: SettingsSnapshot,
  key: SettingKey,
  value: SettingsSnapshot[SettingKey],
): void {
  const record = snapshot as Record<SettingKey, SettingsSnapshot[SettingKey]>;
  record[key] = Array.isArray(value) ? [...value] : value;
}

export function settingValuesEqual(
  left: SettingsSnapshot[SettingKey],
  right: SettingsSnapshot[SettingKey],
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => item === right[index]);
  }
  return left === right;
}

export function parseSettingsPatch(body: unknown): SettingsPatch {
  if (!isPlainObject(body)) {
    throw new BadRequestException(["body: Expected an object of settings."]);
  }

  const errors: string[] = [];
  const patch: SettingsPatch = {};
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) {
      errors.push(`${key}: Unknown setting`);
      continue;
    }
    const parsed = SETTINGS_DEFINITIONS[key].schema.safeParse(value);
    if (!parsed.success) {
      errors.push(`${key}: ${formatIssues(parsed.error)}`);
      continue;
    }
    writeSetting(patch as SettingsSnapshot, key, parsed.data as SettingsSnapshot[SettingKey]);
  }

  if (errors.length > 0) {
    throw new BadRequestException(errors);
  }
  return patch;
}

export function changedSettingKeys(
  current: SettingsSnapshot,
  patch: SettingsPatch,
): SettingKey[] {
  const changed: SettingKey[] = [];
  for (const key of settingKeys) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    const nextValue = patch[key];
    if (nextValue === undefined) {
      continue;
    }
    if (!settingValuesEqual(current[key], nextValue)) {
      changed.push(key);
    }
  }
  return changed;
}

export function applySettingsPatch(
  current: SettingsSnapshot,
  patch: SettingsPatch,
): SettingsSnapshot {
  const next = cloneSnapshot(current);
  for (const key of settingKeys) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    writeSetting(next, key, value);
  }
  return next;
}

export function pickSettings(
  snapshot: SettingsSnapshot,
  keys: readonly SettingKey[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = snapshot[key];
    picked[key] = Array.isArray(value) ? [...value] : value;
  }
  return picked;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
