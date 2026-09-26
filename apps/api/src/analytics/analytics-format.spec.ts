import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  exportExceedsRowLimit,
  formatErrorRate,
  stableDimensionJson,
  toCsv,
  USAGE_EXPORT_MAX_ROWS,
} from "./analytics-format.js";

describe("error rate formatting", () => {
  it.each([
    [0n, 0n, "0.0000"],
    [0n, 5n, "0.0000"],
    [1n, 1n, "1.0000"],
    [2n, 2n, "1.0000"],
    [1n, 2n, "0.5000"],
    [1n, 3n, "0.3333"],
    [2n, 3n, "0.6667"],
    [1n, 6n, "0.1667"],
    [1n, 8n, "0.1250"],
    [1n, 16n, "0.0625"],
    [1n, 20_000n, "0.0001"],
    [3n, 20_000n, "0.0002"],
    [1n, 200_000n, "0.0000"],
    [5n, 10_000n, "0.0005"],
  ])("formats %s / %s as %s", (errors, total, formatted) => {
    expect(formatErrorRate(errors, total)).toBe(formatted);
  });

  it.each([
    [-1n, 1n],
    [1n, -1n],
  ])("rejects a negative count %s / %s", (errors, total) => {
    expect(() => formatErrorRate(errors, total)).toThrow(RangeError);
  });
});

describe("CSV escaping", () => {
  it.each([
    ["plain", "plain"],
    ["", ""],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line\nbreak", '"line\nbreak"'],
    ["line\r\nbreak", '"line\r\nbreak"'],
    ["already, \"quoted\"", '"already, ""quoted"""'],
  ])("escapes %j", (input, expected) => {
    expect(escapeCsvField(input)).toBe(expected);
  });

  it("writes RFC 4180 rows with CRLF and a trailing newline", () => {
    expect(
      toCsv([
        ["day", "name"],
        ["2026-06-15", 'Beta "team", west'],
        ["2026-06-16", "Alpha"],
      ]),
    ).toBe('day,name\r\n2026-06-15,"Beta ""team"", west"\r\n2026-06-16,Alpha\r\n');
  });

  it("serializes dimension totals with sorted keys", () => {
    expect(stableDimensionJson({ reasoningTokens: "2", cachedInputTokens: "15" })).toBe(
      '{"cachedInputTokens":"15","reasoningTokens":"2"}',
    );
    expect(stableDimensionJson({})).toBe("{}");
  });
});

describe("CSV export row limit", () => {
  it.each([
    [0, false],
    [USAGE_EXPORT_MAX_ROWS, false],
    [USAGE_EXPORT_MAX_ROWS + 1, true],
  ])("count %s exceeds the cap: %s", (count, exceeds) => {
    expect(exportExceedsRowLimit(count)).toBe(exceeds);
  });
});
