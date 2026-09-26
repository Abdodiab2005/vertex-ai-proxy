// List-page usage columns. One grouped read for the ids on the page — a count
// per key would be an N+1. These figures come from usage_records (accounting),
// not the Redis rate-limit windows.
//
// The id count is capped at the list endpoint's max page size so the
// placeholder list cannot grow with a caller-supplied string.

const MAX_PAGE_IDS = 200;

export type KeyUsageAggregate = {
  requestsToday: number;
  tokensThisMonth: string;
};

export function usageAggregateStatement(idCount: number): string {
  if (!Number.isInteger(idCount) || idCount < 1 || idCount > MAX_PAGE_IDS) {
    throw new RangeError(`usage aggregate id count must be from 1 to ${MAX_PAGE_IDS}`);
  }

  const idPlaceholders = Array.from({ length: idCount }, (_, index) => `$${index + 1}::uuid`).join(", ");
  const today = `$${idCount + 1}`;
  const month = `$${idCount + 2}`;

  // bigint sums come back as numeric. Cast to bigint text so the value stays
  // an integer string and the UI never parses a token count.
  return `
    SELECT ur.api_key_id AS "apiKeyId",
           COUNT(*) FILTER (WHERE ur.created_at >= ${today})::int AS "requestsToday",
           COALESCE(
             SUM(COALESCE(ur.input_tokens, 0) + COALESCE(ur.output_tokens, 0))
               FILTER (WHERE ur.created_at >= ${month}),
             0
           )::bigint::text AS "tokensThisMonth"
      FROM usage_records ur
     WHERE ur.api_key_id IN (${idPlaceholders})
     GROUP BY ur.api_key_id
  `;
}

export function mapUsageAggregateRows(
  keyIds: readonly string[],
  rows: readonly unknown[],
): Map<string, KeyUsageAggregate> {
  const byId = new Map<string, KeyUsageAggregate>();
  for (const id of keyIds) {
    byId.set(id, { requestsToday: 0, tokensThisMonth: "0" });
  }

  for (const row of rows) {
    const record = asRecord(row);
    if (record === null) {
      continue;
    }
    const apiKeyId = field(record, ["apiKeyId", "api_key_id"]);
    if (typeof apiKeyId !== "string" || !byId.has(apiKeyId)) {
      continue;
    }
    byId.set(apiKeyId, {
      requestsToday: asCount(field(record, ["requestsToday", "requests_today"])),
      tokensThisMonth: asIntegerString(field(record, ["tokensThisMonth", "tokens_this_month"])),
    });
  }

  return byId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function field(row: Record<string, unknown>, names: readonly string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(key.toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function asIntegerString(value: unknown): string {
  if (typeof value === "bigint" && value >= 0n) {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== "string") {
    return "0";
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return stripLeadingZeros(trimmed);
  }
  // A numeric cast can look like "3125.000000". Only an all-zero fraction is
  // an integer; anything else is not a token count we can show honestly.
  const dotted = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined && /^0+$/.test(dotted[2])) {
    return stripLeadingZeros(dotted[1]);
  }
  return "0";
}

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+(?=\d)/, "");
  return stripped.length === 0 ? "0" : stripped;
}
