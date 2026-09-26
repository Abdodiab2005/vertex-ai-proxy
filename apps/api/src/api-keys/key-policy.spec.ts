import { describe, expect, it } from "vitest";
import {
  buildBulkKeysCsv,
  bulkKeyName,
  grantableCredit,
  presetPolicySource,
  resolveKeyPolicy,
  type KeySettingsDefaults,
  type StoredPresetPolicy,
} from "./key-policy.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function defaults(overrides: Partial<KeySettingsDefaults> = {}): KeySettingsDefaults {
  return {
    allowedModels: [],
    requestsPerMinute: null,
    requestsPerDay: null,
    maxConcurrentRequests: null,
    initialCredit: null,
    lifetimeDays: null,
    ...overrides,
  };
}

const storedPreset = (overrides: Partial<StoredPresetPolicy> = {}): StoredPresetPolicy => ({
  description: null,
  allowedModels: [],
  blockedModels: [],
  allowedEndpoints: [],
  requestsPerMinute: null,
  requestsPerDay: null,
  tokensPerMinute: null,
  tokensPerDay: null,
  tokensPerMonth: null,
  maxConcurrentRequests: null,
  initialCredit: null,
  lifetimeDays: null,
  tags: [],
  ...overrides,
});

describe("bulk key names", () => {
  it.each([
    { prefix: "play", quantity: 1, index: 1, expected: "play 01" },
    { prefix: "play", quantity: 12, index: 1, expected: "play 01" },
    { prefix: "play", quantity: 12, index: 12, expected: "play 12" },
    { prefix: "play", quantity: 99, index: 7, expected: "play 07" },
    { prefix: "play", quantity: 99, index: 99, expected: "play 99" },
    { prefix: "play", quantity: 100, index: 1, expected: "play 001" },
    { prefix: "play", quantity: 100, index: 99, expected: "play 099" },
    { prefix: "play", quantity: 100, index: 100, expected: "play 100" },
    { prefix: "play", quantity: 200, index: 200, expected: "play 200" },
  ])("$prefix $index of $quantity is $expected", ({ prefix, quantity, index, expected }) => {
    expect(bulkKeyName(prefix, index, quantity)).toBe(expected);
  });
});

describe("key policy merge", () => {
  it("applies overrides, then the preset, then settings defaults", () => {
    const resolved = resolveKeyPolicy({
      preset: {
        requestsPerMinute: 10,
        allowedModels: ["preset-model"],
        initialCredit: "2",
        lifetimeDays: 5,
        tokensPerMinute: 100,
      },
      overrides: {
        requestsPerMinute: 20,
        initialCredit: "4",
      },
      defaults: defaults({
        requestsPerMinute: 30,
        requestsPerDay: 40,
        maxConcurrentRequests: 2,
        allowedModels: ["default-model"],
        initialCredit: "8",
        lifetimeDays: 14,
      }),
      now: NOW,
    });

    expect(resolved.requestsPerMinute).toBe(20);
    expect(resolved.initialCredit).toBe("4");
    expect(resolved.allowedModels).toEqual(["preset-model"]);
    expect(resolved.lifetimeDays).toBe(5);
    expect(resolved.expiresAt?.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(resolved.tokensPerMinute).toBe(100);
    expect(resolved.requestsPerDay).toBe(40);
    expect(resolved.maxConcurrentRequests).toBe(2);
  });

  it("uses settings defaults when neither the preset nor the overrides set a field", () => {
    const resolved = resolveKeyPolicy({
      defaults: defaults({
        allowedModels: ["gemini-2.5-flash"],
        requestsPerMinute: 15,
        requestsPerDay: 200,
        maxConcurrentRequests: 3,
        initialCredit: "25.5",
        lifetimeDays: 14,
      }),
      now: NOW,
    });

    expect(resolved.allowedModels).toEqual(["gemini-2.5-flash"]);
    expect(resolved.requestsPerMinute).toBe(15);
    expect(resolved.requestsPerDay).toBe(200);
    expect(resolved.maxConcurrentRequests).toBe(3);
    expect(resolved.initialCredit).toBe("25.5");
    expect(resolved.lifetimeDays).toBe(14);
    expect(resolved.expiresAt?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(resolved.blockedModels).toEqual([]);
    expect(resolved.tokensPerMinute).toBeNull();
    expect(resolved.description).toBeNull();
    expect(resolved.tags).toEqual([]);
  });

  it("keeps an explicit null instead of falling through", () => {
    const resolved = resolveKeyPolicy({
      preset: { requestsPerMinute: 10, lifetimeDays: 5, initialCredit: "2", allowedModels: ["preset"] },
      overrides: { requestsPerMinute: null, lifetimeDays: null, initialCredit: null, allowedModels: null },
      defaults: defaults({
        requestsPerMinute: 30,
        lifetimeDays: 14,
        initialCredit: "8",
        allowedModels: ["default"],
      }),
      now: NOW,
    });

    expect(resolved.requestsPerMinute).toBeNull();
    expect(resolved.lifetimeDays).toBeNull();
    expect(resolved.expiresAt).toBeNull();
    expect(resolved.initialCredit).toBeNull();
    expect(resolved.allowedModels).toEqual([]);
  });

  it("treats a stored preset null as an explicit value, not a settings default", () => {
    const resolved = resolveKeyPolicy({
      preset: presetPolicySource(storedPreset()),
      defaults: defaults({
        allowedModels: ["gemini-2.5-flash"],
        requestsPerMinute: 10,
        requestsPerDay: 20,
        maxConcurrentRequests: 3,
        initialCredit: "5",
        lifetimeDays: 14,
      }),
      now: NOW,
    });

    expect(resolved.requestsPerMinute).toBeNull();
    expect(resolved.requestsPerDay).toBeNull();
    expect(resolved.maxConcurrentRequests).toBeNull();
    expect(resolved.allowedModels).toEqual([]);
    expect(resolved.initialCredit).toBeNull();
    expect(resolved.lifetimeDays).toBeNull();
    expect(resolved.expiresAt).toBeNull();
  });

  it("does not let the resolved lists alias the inputs", () => {
    const models = ["gemini-2.5-flash"];
    const resolved = resolveKeyPolicy({
      defaults: defaults({ allowedModels: models }),
      now: NOW,
    });
    resolved.allowedModels.push("other");
    expect(models).toEqual(["gemini-2.5-flash"]);
  });

  it.each([
    { amount: null, expected: null },
    { amount: "0", expected: null },
    { amount: "0.0", expected: null },
    { amount: "-1", expected: null },
    { amount: "1.5", expected: "1.5" },
    { amount: "12.500000", expected: "12.500000" },
  ])("grantable credit $amount -> $expected", ({ amount, expected }) => {
    expect(grantableCredit(amount)).toBe(expected);
  });
});

describe("bulk key csv", () => {
  it.each([
    {
      name: "header and one plain row",
      rows: [{ name: "play 01", key: "lvg_abc", credit: "12.5", expiresAt: "2026-01-08T00:00:00.000Z" }],
      expected:
        "name,key,credit,expiresAt\r\nplay 01,lvg_abc,12.5,2026-01-08T00:00:00.000Z\r\n",
    },
    {
      name: "empty credit and expiry",
      rows: [{ name: "play 01", key: "lvg_abc", credit: "", expiresAt: "" }],
      expected: "name,key,credit,expiresAt\r\nplay 01,lvg_abc,,\r\n",
    },
    {
      name: "comma and quote in the name",
      rows: [{ name: 'Ada "Lovelace", Jr.', key: "lvg_abc", credit: "", expiresAt: "" }],
      expected: 'name,key,credit,expiresAt\r\n"Ada ""Lovelace"", Jr.",lvg_abc,,\r\n',
    },
    {
      name: "line break in a field",
      rows: [{ name: "line1\nline2", key: "lvg_abc", credit: "1", expiresAt: "" }],
      expected: 'name,key,credit,expiresAt\r\n"line1\nline2",lvg_abc,1,\r\n',
    },
    {
      name: "no data rows still has the header",
      rows: [],
      expected: "name,key,credit,expiresAt\r\n",
    },
  ])("$name", ({ rows, expected }) => {
    expect(buildBulkKeysCsv(rows)).toBe(expected);
  });

  it("keeps row order", () => {
    const csv = buildBulkKeysCsv([
      { name: "play 01", key: "k1", credit: "1", expiresAt: "" },
      { name: "play 02", key: "k2", credit: "", expiresAt: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(csv).toBe(
      "name,key,credit,expiresAt\r\nplay 01,k1,1,\r\nplay 02,k2,,2026-02-01T00:00:00.000Z\r\n",
    );
  });
});
