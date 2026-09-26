export const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
export const DEFAULT_USAGE_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESET_SPAN_MS = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const;

export type AnalyticsRangeName = "24h" | "7d" | "30d" | "custom";
export type AnalyticsBucket = "hour" | "day";

export interface RangeInput {
  range: AnalyticsRangeName;
  from?: string;
  to?: string;
}

export interface ResolvedRange {
  from: Date;
  to: Date;
  bucket: AnalyticsBucket;
}

export function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

export function nextUtcDay(dayStart: Date): Date {
  return new Date(Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate() + 1));
}

export function startOfUtcMonth(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
}

export function nextUtcMonth(monthStart: Date): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
}

export function rangeSpanIssue(from: string, to: string): string | null {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return "from and to must be valid datetimes";
  }
  if (toMs <= fromMs) {
    return "to must be after from";
  }
  if (toMs - fromMs > MAX_RANGE_MS) {
    return "range cannot exceed 366 days";
  }
  return null;
}

export function resolveRange(input: RangeInput, now: Date): ResolvedRange {
  if (input.range === "custom") {
    if (input.from === undefined || input.to === undefined) {
      throw new RangeError("custom range requires from and to");
    }
    const issue = rangeSpanIssue(input.from, input.to);
    if (issue !== null) {
      throw new RangeError(issue);
    }
    return {
      from: new Date(input.from),
      to: new Date(input.to),
      bucket: "day",
    };
  }

  const span = PRESET_SPAN_MS[input.range];
  return {
    from: new Date(now.getTime() - span),
    to: now,
    bucket: input.range === "24h" ? "hour" : "day",
  };
}

function truncateUtc(instant: Date, bucket: AnalyticsBucket): Date {
  if (bucket === "hour") {
    return new Date(
      Date.UTC(
        instant.getUTCFullYear(),
        instant.getUTCMonth(),
        instant.getUTCDate(),
        instant.getUTCHours(),
      ),
    );
  }
  return startOfUtcDay(instant);
}

// Half-open [from, to). The last bucket is the one containing to - 1ms, so an
// exclusive end that lands on a boundary does not add an empty trailing bucket.
export function enumerateBuckets(from: Date, to: Date, bucket: AnalyticsBucket): Date[] {
  if (to.getTime() <= from.getTime()) {
    return [];
  }
  const start = truncateUtc(from, bucket);
  const last = truncateUtc(new Date(to.getTime() - 1), bucket);
  const step = bucket === "hour" ? HOUR_MS : DAY_MS;
  const buckets: Date[] = [];
  for (let time = start.getTime(); time <= last.getTime(); time += step) {
    buckets.push(new Date(time));
  }
  return buckets;
}

export function zeroFillPoints(
  buckets: readonly Date[],
  actual: readonly { t: string; value: string }[],
  zero: string,
): { t: string; value: string }[] {
  const values = new Map(actual.map((point) => [point.t, point.value]));
  return buckets.map((bucket) => {
    const t = bucket.toISOString();
    return { t, value: values.get(t) ?? zero };
  });
}
