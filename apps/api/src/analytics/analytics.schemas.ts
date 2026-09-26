import { z } from "zod";
import { rangeSpanIssue, type AnalyticsRangeName } from "./analytics-range.js";

const RANGE_NAMES = ["24h", "7d", "30d", "custom"] as const;
const USAGE_STATUSES = ["success", "error", "partial"] as const;
const TIMESERIES_METRICS = ["requests", "tokens", "cost", "errors"] as const;

function blankToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const analyticsRangeSchema = z.preprocess((value) => {
  if (value === undefined || value === "") {
    return "24h";
  }
  return value;
}, z.enum(RANGE_NAMES));

const optionalIso = z.preprocess(blankToUndefined, z.iso.datetime().optional());

const rangeFields = {
  range: analyticsRangeSchema,
  from: optionalIso,
  to: optionalIso,
};

interface IssueTarget {
  addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void;
}

function refineCustomRange(
  value: { range: AnalyticsRangeName; from?: string; to?: string },
  ctx: IssueTarget,
): void {
  if (value.range !== "custom") {
    return;
  }
  if (value.from === undefined || value.to === undefined) {
    ctx.addIssue({
      code: "custom",
      path: [value.from === undefined ? "from" : "to"],
      message: "custom range requires from and to",
    });
    return;
  }
  const issue = rangeSpanIssue(value.from, value.to);
  if (issue !== null) {
    ctx.addIssue({ code: "custom", path: ["to"], message: issue });
  }
}

export const overviewQuerySchema = z.strictObject(rangeFields).superRefine(refineCustomRange);

export type OverviewQuery = z.output<typeof overviewQuerySchema>;

export const timeseriesQuerySchema = z
  .strictObject({
    metric: z.enum(TIMESERIES_METRICS),
    ...rangeFields,
  })
  .superRefine(refineCustomRange);

export type TimeseriesQuery = z.output<typeof timeseriesQuerySchema>;

export const usageQuerySchema = z
  .strictObject({
    apiKeyId: z.preprocess(blankToUndefined, z.uuid().optional()),
    modelId: z.preprocess(blankToUndefined, z.uuid().optional()),
    upstreamId: z.preprocess(blankToUndefined, z.uuid().optional()),
    status: z.preprocess(blankToUndefined, z.enum(USAGE_STATUSES).optional()),
    endpoint: z.preprocess(blankToUndefined, z.string().trim().min(1).max(200).optional()),
    from: optionalIso,
    to: optionalIso,
  })
  .superRefine((value, ctx) => {
    if (value.from === undefined && value.to === undefined) {
      return;
    }
    if (value.from === undefined || value.to === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [value.from === undefined ? "from" : "to"],
        message: "from and to must be provided together",
      });
      return;
    }
    const issue = rangeSpanIssue(value.from, value.to);
    if (issue !== null) {
      ctx.addIssue({ code: "custom", path: ["to"], message: issue });
    }
  });

export type UsageQuery = z.output<typeof usageQuerySchema>;
