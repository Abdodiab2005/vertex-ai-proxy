import { describe, expect, it } from "vitest";
import { mapUsageAggregateRows, usageAggregateStatement } from "./api-key-usage-aggregate.js";

describe("usageAggregateStatement", () => {
  it("binds one uuid placeholder per key and the two window times after them", () => {
    const sql = usageAggregateStatement(2);
    expect(sql).toContain("FROM usage_records ur");
    expect(sql).toContain("GROUP BY ur.api_key_id");
    expect(sql).toContain("::bigint::text");
    expect(sql).toContain("$1::uuid, $2::uuid");
    expect(sql).toContain(">= $3");
    expect(sql).toContain(">= $4");
    expect(sql).not.toContain("$5");
  });

  it("rejects an empty or oversized page", () => {
    expect(() => usageAggregateStatement(0)).toThrow(RangeError);
    expect(() => usageAggregateStatement(201)).toThrow(RangeError);
    expect(() => usageAggregateStatement(1.5)).toThrow(RangeError);
  });
});

describe("mapUsageAggregateRows", () => {
  it("defaults keys that have no aggregate row", () => {
    const mapped = mapUsageAggregateRows(["a", "b"], []);
    expect(mapped.get("a")).toEqual({ requestsToday: 0, tokensThisMonth: "0" });
    expect(mapped.get("b")).toEqual({ requestsToday: 0, tokensThisMonth: "0" });
  });

  it("maps counts and integer token strings", () => {
    const mapped = mapUsageAggregateRows(
      ["a"],
      [{ apiKeyId: "a", requestsToday: 2, tokensThisMonth: "3125" }],
    );
    expect(mapped.get("a")).toEqual({ requestsToday: 2, tokensThisMonth: "3125" });
  });

  it("accepts numeric strings and zero-fraction token sums", () => {
    const mapped = mapUsageAggregateRows(
      ["a"],
      [{ apiKeyId: "a", requestsToday: "4", tokensThisMonth: "3125.000000" }],
    );
    expect(mapped.get("a")).toEqual({ requestsToday: 4, tokensThisMonth: "3125" });
  });

  it("strips leading zeros and keeps a single zero", () => {
    const mapped = mapUsageAggregateRows(
      ["a", "b"],
      [
        { apiKeyId: "a", requestsToday: 0, tokensThisMonth: "0008" },
        { apiKeyId: "b", requestsToday: "0", tokensThisMonth: "0.000" },
      ],
    );
    expect(mapped.get("a")).toEqual({ requestsToday: 0, tokensThisMonth: "8" });
    expect(mapped.get("b")).toEqual({ requestsToday: 0, tokensThisMonth: "0" });
  });

  it("ignores rows outside the page and drops non-integer values", () => {
    const mapped = mapUsageAggregateRows(
      ["a"],
      [
        { apiKeyId: "other", requestsToday: 9, tokensThisMonth: "1" },
        { apiKeyId: "a", requestsToday: 1.5, tokensThisMonth: "1.5" },
        "not-a-row",
      ],
    );
    expect(mapped.get("a")).toEqual({ requestsToday: 0, tokensThisMonth: "0" });
    expect(mapped.has("other")).toBe(false);
  });

  it("reads lowercase driver keys and bigint token values", () => {
    const mapped = mapUsageAggregateRows(
      ["a"],
      [{ apikeyid: "a", requeststoday: 3n, tokensthismonth: 8n }],
    );
    expect(mapped.get("a")).toEqual({ requestsToday: 3, tokensThisMonth: "8" });
  });
});
