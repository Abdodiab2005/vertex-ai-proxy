import { toMicros } from "../credits/money.js";

// A missing field falls through to the next layer. An explicit null is a choice
// (no limit, no credit, no expiry) and does not fall through. Layers are applied
// as overrides, then the preset, then settings defaults.
export interface KeyPolicySource {
  description?: string | null;
  allowedModels?: readonly string[] | null;
  blockedModels?: readonly string[] | null;
  allowedEndpoints?: readonly string[] | null;
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
  tokensPerMinute?: number | null;
  tokensPerDay?: number | null;
  tokensPerMonth?: number | null;
  maxConcurrentRequests?: number | null;
  initialCredit?: string | null;
  lifetimeDays?: number | null;
  tags?: readonly string[] | null;
}

export interface KeySettingsDefaults {
  allowedModels: readonly string[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  maxConcurrentRequests: number | null;
  initialCredit: string | null;
  lifetimeDays: number | null;
}

export interface StoredPresetPolicy {
  description: string | null;
  allowedModels: readonly string[];
  blockedModels: readonly string[];
  allowedEndpoints: readonly string[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxConcurrentRequests: number | null;
  initialCredit: string | null;
  lifetimeDays: number | null;
  tags: readonly string[];
}

export interface ResolvedKeyPolicy {
  description: string | null;
  allowedModels: string[];
  blockedModels: string[];
  allowedEndpoints: string[];
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  maxConcurrentRequests: number | null;
  initialCredit: string | null;
  lifetimeDays: number | null;
  tags: string[];
  expiresAt: Date | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function presetPolicySource(preset: StoredPresetPolicy): KeyPolicySource {
  return {
    description: preset.description,
    allowedModels: [...preset.allowedModels],
    blockedModels: [...preset.blockedModels],
    allowedEndpoints: [...preset.allowedEndpoints],
    requestsPerMinute: preset.requestsPerMinute,
    requestsPerDay: preset.requestsPerDay,
    tokensPerMinute: preset.tokensPerMinute,
    tokensPerDay: preset.tokensPerDay,
    tokensPerMonth: preset.tokensPerMonth,
    maxConcurrentRequests: preset.maxConcurrentRequests,
    initialCredit: preset.initialCredit,
    lifetimeDays: preset.lifetimeDays,
    tags: [...preset.tags],
  };
}

export function resolveKeyPolicy(input: {
  preset?: KeyPolicySource;
  overrides?: KeyPolicySource;
  defaults: KeySettingsDefaults;
  now: Date;
}): ResolvedKeyPolicy {
  const lifetimeDays = pickNullable(
    input.overrides,
    input.preset,
    "lifetimeDays",
    input.defaults.lifetimeDays,
  );

  return {
    description: pickNullable(input.overrides, input.preset, "description", null),
    allowedModels: pickList(
      input.overrides,
      input.preset,
      "allowedModels",
      input.defaults.allowedModels,
    ),
    blockedModels: pickList(input.overrides, input.preset, "blockedModels", []),
    allowedEndpoints: pickList(input.overrides, input.preset, "allowedEndpoints", []),
    requestsPerMinute: pickNullable(
      input.overrides,
      input.preset,
      "requestsPerMinute",
      input.defaults.requestsPerMinute,
    ),
    requestsPerDay: pickNullable(
      input.overrides,
      input.preset,
      "requestsPerDay",
      input.defaults.requestsPerDay,
    ),
    tokensPerMinute: pickNullable(input.overrides, input.preset, "tokensPerMinute", null),
    tokensPerDay: pickNullable(input.overrides, input.preset, "tokensPerDay", null),
    tokensPerMonth: pickNullable(input.overrides, input.preset, "tokensPerMonth", null),
    maxConcurrentRequests: pickNullable(
      input.overrides,
      input.preset,
      "maxConcurrentRequests",
      input.defaults.maxConcurrentRequests,
    ),
    initialCredit: pickNullable(
      input.overrides,
      input.preset,
      "initialCredit",
      input.defaults.initialCredit,
    ),
    lifetimeDays,
    tags: pickList(input.overrides, input.preset, "tags", []),
    expiresAt: expiresAtFromLifetime(lifetimeDays, input.now),
  };
}

export function expiresAtFromLifetime(lifetimeDays: number | null, now: Date): Date | null {
  if (lifetimeDays === null) {
    return null;
  }
  return new Date(now.getTime() + lifetimeDays * MS_PER_DAY);
}

// The ledger rejects a non-positive credit_added row, so a zero amount grants nothing.
export function grantableCredit(amount: string | null): string | null {
  if (amount === null) {
    return null;
  }
  if (toMicros(amount) <= 0n) {
    return null;
  }
  return amount;
}

// Width is the digit count of the quantity, with a floor of 2, so 1..99 read as 01..99
// and 100..200 read as 001..200.
export function bulkKeyIndexWidth(quantity: number): number {
  return quantity >= 100 ? 3 : 2;
}

export function bulkKeyName(prefix: string, index: number, quantity: number): string {
  return `${prefix} ${String(index).padStart(bulkKeyIndexWidth(quantity), "0")}`;
}

export interface BulkKeyCsvRow {
  name: string;
  key: string;
  credit: string;
  expiresAt: string;
}

const CSV_SPECIAL = /[",\r\n]/;

export function escapeCsvField(value: string): string {
  if (CSV_SPECIAL.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

// RFC 4180: CRLF between records, and a field containing a comma, quote, or
// line break is quoted with embedded quotes doubled. The result contains raw
// keys, so callers must not log it or store it.
export function buildBulkKeysCsv(rows: readonly BulkKeyCsvRow[]): string {
  const lines = ["name,key,credit,expiresAt"];
  for (const row of rows) {
    lines.push([row.name, row.key, row.credit, row.expiresAt].map(escapeCsvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function pickNullable<T>(
  overrides: KeyPolicySource | undefined,
  preset: KeyPolicySource | undefined,
  key: keyof KeyPolicySource,
  fallback: T | null,
): T | null {
  const override = readField<T | null>(overrides, key);
  if (override !== undefined) {
    return override;
  }
  const presetValue = readField<T | null>(preset, key);
  if (presetValue !== undefined) {
    return presetValue;
  }
  return fallback;
}

function pickList(
  overrides: KeyPolicySource | undefined,
  preset: KeyPolicySource | undefined,
  key: keyof KeyPolicySource,
  fallback: readonly string[],
): string[] {
  const override = readField<readonly string[] | null>(overrides, key);
  if (override !== undefined) {
    return [...(override ?? [])];
  }
  const presetValue = readField<readonly string[] | null>(preset, key);
  if (presetValue !== undefined) {
    return [...(presetValue ?? [])];
  }
  return [...fallback];
}

function readField<T>(source: KeyPolicySource | undefined, key: keyof KeyPolicySource): T | undefined {
  if (source === undefined || !Object.prototype.hasOwnProperty.call(source, key)) {
    return undefined;
  }
  return source[key] as T | undefined;
}
