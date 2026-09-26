import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_MESSAGE_DEFAULT,
  SETTINGS_DEFINITIONS,
  settingKeys,
  type SettingKey,
} from "./settings.definitions.js";

const cases: Array<{ key: SettingKey; valid: unknown[]; invalid: unknown[] }> = [
  {
    key: "gateway.enabled",
    valid: [true, false],
    invalid: ["true", 1, null, 0],
  },
  {
    key: "gateway.maintenanceMode",
    valid: [true, false],
    invalid: ["false", null, 1],
  },
  {
    key: "gateway.maintenanceMessage",
    valid: ["x", "a".repeat(300)],
    invalid: ["", "a".repeat(301), null, 1],
  },
  {
    key: "gateway.killSwitch",
    valid: [true, false],
    invalid: ["true", null, 1],
  },
  {
    key: "keys.defaultRequestsPerMinute",
    valid: [1, 60, null],
    invalid: [0, -1, 1.5, "10", true],
  },
  {
    key: "keys.defaultRequestsPerDay",
    valid: [1, null],
    invalid: [0, -5, 2.2, "100"],
  },
  {
    key: "keys.defaultMaxConcurrentRequests",
    valid: [1, 8, null],
    invalid: [0, -1, 1.1, false],
  },
  {
    key: "keys.defaultInitialCredit",
    valid: ["0", "10", "1.5", "999999999999.999999", null],
    invalid: ["-1", "1.", "1.1234567", "", 10, " 1"],
  },
  {
    key: "keys.defaultAllowedModels",
    valid: [[], ["gemini-2.5-flash"], ["A", "model_name.v1"]],
    invalid: ["gemini-2.5-flash", [""], [" bad"], ["*"], ["a".repeat(129)]],
  },
  {
    key: "keys.defaultLifetimeDays",
    valid: [1, 3650, null],
    invalid: [0, 3651, 1.5, "30", -1],
  },
  {
    key: "timeouts.requestMs",
    valid: [1000, 120_000, 600_000],
    invalid: [999, 600_001, 1.5, "120000", null],
  },
  {
    key: "timeouts.streamIdleMs",
    valid: [1000, 60_000, 600_000],
    invalid: [999, 600_001, 0, null],
  },
  {
    key: "timeouts.upstreamConnectMs",
    valid: [1000, 15_000, 120_000],
    invalid: [999, 120_001, 15.5, null],
  },
  {
    key: "media.maxInlineBytes",
    valid: [1024, 15 * 1024 * 1024, 100 * 1024 * 1024],
    invalid: [1023, 100 * 1024 * 1024 + 1, 1.5, "1024", null],
  },
  {
    key: "media.allowFileUris",
    valid: [true, false],
    invalid: ["true", null, 1, 0],
  },
  {
    key: "media.fileUriHoldTokens",
    valid: [1000, 50_000, 2_000_000],
    invalid: [999, 2_000_001, 1.5, "50000", null],
  },
  {
    key: "logging.metadataRetentionDays",
    valid: [7, 30, 90, null],
    invalid: [14, 0, 91, "90", false],
  },
  {
    key: "logging.contentLoggingEnabled",
    valid: [false],
    invalid: [true, "false", null, 0],
  },
  {
    key: "billing.currency",
    valid: ["USD", "EUR"],
    invalid: ["usd", "US", "USDD", "US$", "", null],
  },
  {
    key: "gateway.publicUrl",
    valid: ["https://gateway.example.com", "http://localhost:3000/v1", null],
    invalid: ["ftp://example.com", "example.com", "/relative", "", "javascript:alert(1)"],
  },
  {
    key: "spend.upstreamBudget",
    valid: ["0", "300", "20.5", null],
    invalid: ["-1", "1.1234567", "", 300],
  },
  {
    key: "spend.safetyReserve",
    valid: ["0", "20", "0.000001"],
    invalid: ["-1", "", null, 0, "1.1234567"],
  },
  {
    key: "spend.blockWhenThresholdReached",
    valid: [true, false],
    invalid: ["true", null, 1],
  },
];

describe("setting schemas", () => {
  it("has a case for every definition", () => {
    expect(cases.map((item) => item.key).sort()).toEqual([...settingKeys].sort());
  });

  it("uses the documented defaults", () => {
    expect(SETTINGS_DEFINITIONS["gateway.enabled"].default).toBe(true);
    expect(SETTINGS_DEFINITIONS["gateway.maintenanceMode"].default).toBe(false);
    expect(SETTINGS_DEFINITIONS["gateway.maintenanceMessage"].default).toBe(MAINTENANCE_MESSAGE_DEFAULT);
    expect(SETTINGS_DEFINITIONS["gateway.killSwitch"].default).toBe(false);
    expect(SETTINGS_DEFINITIONS["keys.defaultRequestsPerMinute"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["keys.defaultRequestsPerDay"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["keys.defaultMaxConcurrentRequests"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["keys.defaultInitialCredit"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["keys.defaultAllowedModels"].default).toEqual([]);
    expect(SETTINGS_DEFINITIONS["keys.defaultLifetimeDays"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["timeouts.requestMs"].default).toBe(120_000);
    expect(SETTINGS_DEFINITIONS["timeouts.streamIdleMs"].default).toBe(60_000);
    expect(SETTINGS_DEFINITIONS["timeouts.upstreamConnectMs"].default).toBe(15_000);
    expect(SETTINGS_DEFINITIONS["media.allowFileUris"].default).toBe(false);
    expect(SETTINGS_DEFINITIONS["media.fileUriHoldTokens"].default).toBe(50_000);
    expect(SETTINGS_DEFINITIONS["logging.metadataRetentionDays"].default).toBe(90);
    expect(SETTINGS_DEFINITIONS["logging.contentLoggingEnabled"].default).toBe(false);
    expect(SETTINGS_DEFINITIONS["billing.currency"].default).toBe("USD");
    expect(SETTINGS_DEFINITIONS["gateway.publicUrl"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["spend.upstreamBudget"].default).toBeNull();
    expect(SETTINGS_DEFINITIONS["spend.safetyReserve"].default).toBe("0");
    expect(SETTINGS_DEFINITIONS["spend.blockWhenThresholdReached"].default).toBe(false);
  });

  it.each(settingKeys)("%s accepts its default", (key) => {
    const definition = SETTINGS_DEFINITIONS[key];
    expect(definition.schema.parse(definition.default)).toEqual(definition.default);
  });

  it.each(cases)("$key accepts obvious valid values", ({ key, valid }) => {
    for (const value of valid) {
      const parsed = SETTINGS_DEFINITIONS[key].schema.safeParse(value);
      expect(parsed.success, JSON.stringify(value)).toBe(true);
    }
  });

  it.each(cases)("$key rejects obvious bad values", ({ key, invalid }) => {
    for (const value of invalid) {
      expect(SETTINGS_DEFINITIONS[key].schema.safeParse(value).success).toBe(false);
    }
  });
});
