import { describe, expect, it } from "vitest";
import {
  enumerateBuckets,
  MAX_RANGE_MS,
  nextUtcDay,
  nextUtcMonth,
  rangeSpanIssue,
  resolveRange,
  startOfUtcDay,
  startOfUtcMonth,
  zeroFillPoints,
} from "./analytics-range.js";
import { overviewQuerySchema, timeseriesQuerySchema, usageQuerySchema } from "./analytics.schemas.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("analytics range parsing", () => {
  it.each([
    {
      name: "24h",
      input: { range: "24h" as const },
      from: "2026-06-14T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
      bucket: "hour" as const,
    },
    {
      name: "7d",
      input: { range: "7d" as const },
      from: "2026-06-08T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
      bucket: "day" as const,
    },
    {
      name: "30d",
      input: { range: "30d" as const },
      from: "2026-05-16T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
      bucket: "day" as const,
    },
  ])("$name is a half-open window ending at now", ({ input, from, to, bucket }) => {
    expect(resolveRange(input, NOW)).toEqual({
      from: new Date(from),
      to: new Date(to),
      bucket,
    });
  });

  it("uses daily buckets for a custom window even when it is shorter than a day", () => {
    const resolved = resolveRange(
      {
        range: "custom",
        from: "2026-06-15T10:00:00.000Z",
        to: "2026-06-15T12:00:00.000Z",
      },
      NOW,
    );
    expect(resolved).toEqual({
      from: new Date("2026-06-15T10:00:00.000Z"),
      to: new Date("2026-06-15T12:00:00.000Z"),
      bucket: "day",
    });
  });

  it("ignores from and to on a preset range", () => {
    const resolved = resolveRange(
      {
        range: "24h",
        from: "2020-01-01T00:00:00.000Z",
        to: "2020-02-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(resolved.to.toISOString()).toBe(NOW.toISOString());
    expect(resolved.bucket).toBe("hour");
  });

  it.each([
    ["missing from", { range: "custom" as const, to: "2026-06-15T00:00:00.000Z" }],
    ["missing to", { range: "custom" as const, from: "2026-06-14T00:00:00.000Z" }],
    ["equal bounds", { range: "custom" as const, from: "2026-06-14T00:00:00.000Z", to: "2026-06-14T00:00:00.000Z" }],
    [
      "inverted bounds",
      { range: "custom" as const, from: "2026-06-15T00:00:00.000Z", to: "2026-06-14T00:00:00.000Z" },
    ],
    [
      "longer than 366 days",
      {
        range: "custom" as const,
        from: "2024-01-01T00:00:00.000Z",
        to: new Date(Date.parse("2024-01-01T00:00:00.000Z") + MAX_RANGE_MS + 1).toISOString(),
      },
    ],
  ])("rejects a custom range with %s", (_name, input) => {
    expect(() => resolveRange(input, NOW)).toThrow(RangeError);
  });

  it("accepts a custom span of exactly 366 days", () => {
    const from = "2024-01-01T00:00:00.000Z";
    const to = new Date(Date.parse(from) + MAX_RANGE_MS).toISOString();
    expect(rangeSpanIssue(from, to)).toBeNull();
    expect(resolveRange({ range: "custom", from, to }, NOW).to.toISOString()).toBe(to);
  });

  it.each([
    [{}, "24h"],
    [{ range: "" }, "24h"],
    [{ range: "7d" }, "7d"],
  ])("overview query %# defaults the range", (query, range) => {
    expect(overviewQuerySchema.parse(query).range).toBe(range);
  });

  it.each([
    [{ range: "custom" }, "custom range requires from and to"],
    [{ range: "custom", from: "2026-06-15T00:00:00.000Z" }, "custom range requires from and to"],
    [
      { range: "custom", from: "2026-06-15T00:00:00.000Z", to: "2026-06-14T00:00:00.000Z" },
      "to must be after from",
    ],
    [
      {
        range: "custom",
        from: "2024-01-01T00:00:00.000Z",
        to: new Date(Date.parse("2024-01-01T00:00:00.000Z") + MAX_RANGE_MS + 1).toISOString(),
      },
      "range cannot exceed 366 days",
    ],
    [{ range: "nope" }, "range"],
    [{ metric: "requests" }, "metric"],
  ])("rejects invalid analytics query %#", (query, fragment) => {
    const overview = overviewQuerySchema.safeParse(query);
    const timeseries = timeseriesQuerySchema.safeParse(
      "metric" in query ? query : { ...query, metric: "requests" },
    );
    const failed = [overview, timeseries].filter((result) => !result.success);
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).toContain(fragment);
  });

  it("accepts a blank usage filter as the default window", () => {
    expect(usageQuerySchema.parse({ apiKeyId: "", status: "", endpoint: "" })).toEqual({
      apiKeyId: undefined,
      modelId: undefined,
      upstreamId: undefined,
      status: undefined,
      endpoint: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it.each([
    [{ from: "2026-06-01T00:00:00.000Z" }, "from and to must be provided together"],
    [
      { from: "2026-06-15T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
      "to must be after from",
    ],
    [{ status: "timeout" }, "status"],
    [{ apiKeyId: "not-a-uuid" }, "apiKeyId"],
  ])("rejects usage query %#", (query, fragment) => {
    const result = usageQuerySchema.safeParse(query);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain(fragment);
    }
  });
});

describe("UTC calendar boundaries", () => {
  it("starts the UTC day and month without shifting for a non-UTC host", () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(nextUtcDay(startOfUtcDay(NOW)).toISOString()).toBe("2026-06-16T00:00:00.000Z");
    expect(startOfUtcMonth(NOW).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(nextUtcMonth(startOfUtcMonth(NOW)).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    const december = new Date("2026-12-15T22:30:00.000Z");
    expect(nextUtcMonth(startOfUtcMonth(december)).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("zero-filled buckets", () => {
  it.each([
    {
      name: "hourly partial hours",
      from: "2026-06-14T12:30:00.000Z",
      to: "2026-06-14T15:00:00.000Z",
      bucket: "hour" as const,
      expected: [
        "2026-06-14T12:00:00.000Z",
        "2026-06-14T13:00:00.000Z",
        "2026-06-14T14:00:00.000Z",
      ],
    },
    {
      name: "24h preset",
      from: "2026-06-14T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
      bucket: "hour" as const,
      expected: Array.from({ length: 24 }, (_, index) =>
        new Date(Date.parse("2026-06-14T12:00:00.000Z") + index * 60 * 60 * 1000).toISOString(),
      ),
    },
    {
      name: "daily across a month boundary",
      from: "2026-01-31T10:00:00.000Z",
      to: "2026-02-02T00:00:00.000Z",
      bucket: "day" as const,
      expected: ["2026-01-31T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    },
    {
      name: "leap day",
      from: "2024-02-28T00:00:00.000Z",
      to: "2024-03-01T00:00:00.000Z",
      bucket: "day" as const,
      expected: ["2024-02-28T00:00:00.000Z", "2024-02-29T00:00:00.000Z"],
    },
    {
      name: "midnight crossing hours",
      from: "2026-06-15T23:30:00.000Z",
      to: "2026-06-16T01:30:00.000Z",
      bucket: "hour" as const,
      expected: [
        "2026-06-15T23:00:00.000Z",
        "2026-06-16T00:00:00.000Z",
        "2026-06-16T01:00:00.000Z",
      ],
    },
    {
      name: "empty when the window is not positive",
      from: "2026-06-15T12:00:00.000Z",
      to: "2026-06-15T12:00:00.000Z",
      bucket: "day" as const,
      expected: [],
    },
  ])("$name", ({ from, to, bucket, expected }) => {
    expect(enumerateBuckets(new Date(from), new Date(to), bucket).map((bucketStart) => bucketStart.toISOString())).toEqual(
      expected,
    );
  });

  it("fills missing buckets and ignores points outside the series", () => {
    const buckets = enumerateBuckets(
      new Date("2026-06-15T00:00:00.000Z"),
      new Date("2026-06-17T00:00:00.000Z"),
      "day",
    );
    expect(
      zeroFillPoints(
        buckets,
        [
          { t: "2026-06-16T00:00:00.000Z", value: "4" },
          { t: "2026-06-18T00:00:00.000Z", value: "9" },
        ],
        "0",
      ),
    ).toEqual([
      { t: "2026-06-15T00:00:00.000Z", value: "0" },
      { t: "2026-06-16T00:00:00.000Z", value: "4" },
    ]);
  });
});
