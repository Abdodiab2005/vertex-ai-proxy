import { describe, expect, it } from "vitest";

import { estimateInputOnlyReservationMicros, type ReservationPolicy } from "../../credits/reservation-estimate.js";
import type { PricingRuleInput } from "../../pricing/pricing-engine.js";
import type { JsonObject } from "../../upstreams/providers/upstream-provider.js";
import { embedReservationBody, MAX_BATCH_EMBED_REQUESTS, parseBatchEmbedRequests } from "./batch-embed.js";

const URL_MODEL = "gemini-embedding-001";
const EQUIVALENT = new Set(["gemini-embedding-001", "embed-alias"]);

function parse(body: JsonObject, urlModel = URL_MODEL, names: ReadonlySet<string> = EQUIVALENT) {
  return parseBatchEmbedRequests(body, urlModel, names);
}

describe("parseBatchEmbedRequests", () => {
  it("maps present embed fields and drops the model", () => {
    const parsed = parse({
      requests: [
        { model: "models/gemini-embedding-001", content: { parts: [{ text: "one" }] } },
        {
          content: { parts: [{ text: "two" }] },
          taskType: "RETRIEVAL_QUERY",
          title: "note",
          outputDimensionality: 128,
          extra: true,
        },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      requests: [
        { content: { parts: [{ text: "one" }] } },
        {
          content: { parts: [{ text: "two" }] },
          taskType: "RETRIEVAL_QUERY",
          title: "note",
          outputDimensionality: 128,
        },
      ],
    });
  });

  it("accepts models/<name>, the bare name, and an alias of the URL model", () => {
    expect(parse({ requests: [{ model: "models/gemini-embedding-001", content: {} }] }).ok).toBe(true);
    expect(parse({ requests: [{ model: "gemini-embedding-001", content: {} }] }).ok).toBe(true);
    expect(parse({ requests: [{ model: "models/embed-alias", content: {} }] }).ok).toBe(true);
    expect(
      parse({ requests: [{ model: "gemini-embedding-001", content: {} }] }, "models/embed-alias").ok,
    ).toBe(true);
    expect(parse({ requests: [{ content: {} }] }).ok).toBe(true);
  });

  it("rejects a model that is not the URL model", () => {
    const parsed = parse({ requests: [{ model: "models/other-model", content: {} }] });
    expect(parsed).toEqual({
      ok: false,
      message: "Each request's model must match the model in the URL.",
    });
  });

  it("rejects a non-string model", () => {
    const parsed = parse({ requests: [{ model: 1, content: {} }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toBe("Each request's model must match the model in the URL.");
    }
  });

  it("rejects an empty requests array and a missing requests field", () => {
    expect(parse({ requests: [] })).toEqual({ ok: false, message: "requests must be a non-empty array." });
    expect(parse({})).toEqual({ ok: false, message: "requests must be a non-empty array." });
    expect(parse({ requests: {} })).toEqual({ ok: false, message: "requests must be a non-empty array." });
  });

  it("rejects more than 100 requests and a non-object item", () => {
    const tooMany = Array.from({ length: MAX_BATCH_EMBED_REQUESTS + 1 }, () => ({ content: {} }));
    const over = parse({ requests: tooMany });
    expect(over).toEqual({ ok: false, message: "requests must contain at most 100 items." });

    const atLimit = parse({ requests: tooMany.slice(0, MAX_BATCH_EMBED_REQUESTS) });
    expect(atLimit.ok).toBe(true);

    expect(parse({ requests: ["nope"] })).toEqual({
      ok: false,
      message: "requests[0] must be an object.",
    });
  });

  it("keeps a field that is present even when its value is null", () => {
    const parsed = parse({ requests: [{ content: { parts: [] }, taskType: null }] });
    expect(parsed).toEqual({
      ok: true,
      requests: [{ content: { parts: [] }, taskType: null }],
    });
  });
});

describe("embedReservationBody", () => {
  const policy: ReservationPolicy = {
    charsPerToken: 3,
    tokensPerMediaPart: 1_000,
    defaultMaxOutputTokens: 8_192,
    fileUriHoldTokens: 1_000,
  };
  const rule: PricingRuleInput = {
    id: "input",
    billingDimension: "input_tokens",
    unitSize: "1000000",
    price: "1.25",
    currency: "USD",
    effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
    effectiveTo: null,
  };

  it("exposes one content object as contents so the input-only estimate sees the text", () => {
    const item = { content: { parts: [{ text: "abc" }] }, taskType: "RETRIEVAL_QUERY" };
    expect(embedReservationBody(item)).toEqual({ contents: [{ parts: [{ text: "abc" }] }] });
    expect(embedReservationBody({})).toEqual({});
    // 1 token * $1.25 / 1_000_000, reservation rounds the line up to 2 micros.
    expect(estimateInputOnlyReservationMicros(embedReservationBody(item), rule, policy)).toBe(2n);
  });
});
