import {
  DEFAULT_ADMIN_MAX_REQUEST_BODY_BYTES,
  DEFAULT_PUBLIC_MAX_REQUEST_BODY_BYTES,
  loadApiEnv,
} from "./env.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const baseEnv = { DB_PASSWORD: "test-password", CREDENTIALS_ENCRYPTION_KEY: encryptionKey };

describe("loadApiEnv", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["2", 2],
    ["loopback", "loopback"],
    ["10.0.0.0/8,127.0.0.1", "10.0.0.0/8,127.0.0.1"],
  ])("parses TRUST_PROXY %j", (value, expected) => {
    expect(loadApiEnv({ ...baseEnv, TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it("uses the security defaults", () => {
    const env = loadApiEnv(baseEnv);

    expect(env).toMatchObject({
      TRUST_PROXY: "loopback",
      ADMIN_LOGIN_WINDOW_SECONDS: 900,
      ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT_IP: 5,
      ADMIN_LOGIN_MAX_FAILURES_PER_ACCOUNT: 50,
      ADMIN_LOGIN_MAX_FAILURES_PER_IP: 20,
      ADMIN_SESSION_TTL_HOURS: 12,
      PUBLIC_MAX_REQUEST_BODY_BYTES: DEFAULT_PUBLIC_MAX_REQUEST_BODY_BYTES,
      ADMIN_MAX_REQUEST_BODY_BYTES: DEFAULT_ADMIN_MAX_REQUEST_BODY_BYTES,
      LOG_FORMAT: "pretty",
      LOG_INCLUDE_STACK: false,
    });
  });

  it.each([
    ["development", "pretty"],
    ["test", "pretty"],
    ["production", "json"],
  ])("uses the %s LOG_FORMAT default", (nodeEnv, expectedLogFormat) => {
    expect(loadApiEnv({ ...baseEnv, NODE_ENV: nodeEnv }).LOG_FORMAT).toBe(expectedLogFormat);
  });

  it("allows LOG_FORMAT to override the environment default", () => {
    expect(loadApiEnv({ ...baseEnv, NODE_ENV: "production", LOG_FORMAT: "pretty" }).LOG_FORMAT).toBe(
      "pretty",
    );
  });

  it("treats an empty LOG_FORMAT as unset", () => {
    expect(loadApiEnv({ ...baseEnv, NODE_ENV: "production", LOG_FORMAT: "" }).LOG_FORMAT).toBe(
      "json",
    );
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
  ])("parses LOG_INCLUDE_STACK %j", (value, expected) => {
    expect(loadApiEnv({ ...baseEnv, LOG_INCLUDE_STACK: value }).LOG_INCLUDE_STACK).toBe(expected);
  });

  it("accepts an unset metrics token and requires configured tokens to be long enough", () => {
    expect(loadApiEnv({ ...baseEnv, METRICS_TOKEN: "" }).METRICS_TOKEN).toBeUndefined();
    expect(loadApiEnv({ ...baseEnv, METRICS_TOKEN: "metrics-token-value" }).METRICS_TOKEN).toBe(
      "metrics-token-value",
    );
    expect(() => loadApiEnv({ ...baseEnv, METRICS_TOKEN: "too-short-token" })).toThrow(
      /METRICS_TOKEN/,
    );
  });

  it("overrides the JSON body size limits", () => {
    const env = loadApiEnv({
      ...baseEnv,
      PUBLIC_MAX_REQUEST_BODY_BYTES: "1024",
      ADMIN_MAX_REQUEST_BODY_BYTES: "512",
    });

    expect(env.PUBLIC_MAX_REQUEST_BODY_BYTES).toBe(1024);
    expect(env.ADMIN_MAX_REQUEST_BODY_BYTES).toBe(512);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["", undefined],
  ])("parses ADMIN_COOKIE_SECURE %j", (value, expected) => {
    expect(loadApiEnv({ ...baseEnv, ADMIN_COOKIE_SECURE: value }).ADMIN_COOKIE_SECURE).toBe(
      expected,
    );
  });

  it("parses CREDENTIALS_ENCRYPTION_KEY into the raw 32-byte key", () => {
    expect(loadApiEnv(baseEnv).CREDENTIALS_ENCRYPTION_KEY).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects a missing or invalid credentials encryption key without echoing it", () => {
    expect(() => loadApiEnv({ DB_PASSWORD: "test-password" })).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);

    const badKey = "not-a-valid-key!!";
    expect(() =>
      loadApiEnv({ DB_PASSWORD: "test-password", CREDENTIALS_ENCRYPTION_KEY: badKey }),
    ).toThrow(/32 bytes/);

    try {
      loadApiEnv({ DB_PASSWORD: "test-password", CREDENTIALS_ENCRYPTION_KEY: badKey });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(badKey);
    }
  });
});
