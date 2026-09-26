const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export type UsageSearch = {
  apiKeyId?: string;
  modelId?: string;
  upstreamId?: string;
  status?: string;
  endpoint?: string;
  from?: string;
  to?: string;
};

export type ParsedUsageSearch =
  | { ok: true; search: UsageSearch; query: URLSearchParams }
  | { ok: false; search: UsageSearch; message: string };

export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function parseUsageSearch(input: UsageSearch): ParsedUsageSearch {
  const search: UsageSearch = {
    apiKeyId: blankToUndefined(input.apiKeyId),
    modelId: blankToUndefined(input.modelId),
    upstreamId: blankToUndefined(input.upstreamId),
    status: blankToUndefined(input.status),
    endpoint: blankToUndefined(input.endpoint),
    from: blankToUndefined(input.from),
    to: blankToUndefined(input.to),
  };

  if ((search.from === undefined) !== (search.to === undefined)) {
    return {
      ok: false,
      search,
      message: "Choose both a start date and an end date, or leave both empty for the last 30 days.",
    };
  }

  if (
    search.status !== undefined &&
    search.status !== "success" &&
    search.status !== "error" &&
    search.status !== "partial"
  ) {
    return { ok: false, search, message: "Status must be success, error, or partial." };
  }

  const params = new URLSearchParams();
  if (search.apiKeyId) {
    params.set("apiKeyId", search.apiKeyId);
  }
  if (search.modelId) {
    params.set("modelId", search.modelId);
  }
  if (search.upstreamId) {
    params.set("upstreamId", search.upstreamId);
  }
  if (search.status) {
    params.set("status", search.status);
  }
  if (search.endpoint) {
    params.set("endpoint", search.endpoint);
  }

  if (search.from !== undefined && search.to !== undefined) {
    const start = parseUtcDate(search.from);
    const endDay = parseUtcDate(search.to);
    if (start === null || endDay === null) {
      return { ok: false, search, message: "Dates must be real calendar days in YYYY-MM-DD." };
    }
    if (endDay.getTime() < start.getTime()) {
      return { ok: false, search, message: "The end date must be on or after the start date." };
    }
    const exclusiveEnd = new Date(
      Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate() + 1),
    );
    if (exclusiveEnd.getTime() - start.getTime() > MAX_RANGE_MS) {
      return { ok: false, search, message: "The date range cannot be longer than 366 days." };
    }
    params.set("from", start.toISOString());
    params.set("to", exclusiveEnd.toISOString());
  }

  return { ok: true, search, query: params };
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseUtcDate(value: string): Date | null {
  const match = DATE_ONLY.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
