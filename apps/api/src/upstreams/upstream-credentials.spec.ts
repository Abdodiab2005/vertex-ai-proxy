import {
  parseCredentials,
  planCredentialUpdate,
  type KnownUpstreamAuthMethod,
} from "./upstream-credentials.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
const validAccount = {
  type: "service_account",
  client_email: "gateway@example.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY,
  token_uri: "https://oauth2.googleapis.com/token",
  private_key_id: "kid-123",
};

const parseCases: Array<
  [string, KnownUpstreamAuthMethod, unknown, boolean, boolean]
> = [
  ["adc without credentials", "application-default-credentials", undefined, false, true],
  ["adc with an object", "application-default-credentials", validAccount, true, false],
  ["adc with an empty string", "application-default-credentials", "", true, false],
  ["service account key", "service-account", validAccount, true, true],
  ["service account omitted", "service-account", undefined, false, false],
  ["service account string", "service-account", "a".repeat(20), true, false],
  ["service account array", "service-account", [validAccount], true, false],
  ["service account null", "service-account", null, true, false],
  [
    "service account wrong type",
    "service-account",
    { ...validAccount, type: "user" },
    true,
    false,
  ],
  [
    "service account bad email",
    "service-account",
    { ...validAccount, client_email: "not-an-email" },
    true,
    false,
  ],
  [
    "service account key without the private key marker",
    "service-account",
    { ...validAccount, private_key: "not-a-key" },
    true,
    false,
  ],
  [
    "service account numeric key",
    "service-account",
    { ...validAccount, private_key: 12 },
    true,
    false,
  ],
  ["api key at the minimum length", "api-key", "a".repeat(10), true, true],
  ["api key at the maximum length", "api-key", "a".repeat(512), true, true],
  ["api key too short", "api-key", "a".repeat(9), true, false],
  ["api key too long", "api-key", "a".repeat(513), true, false],
  ["api key with whitespace", "api-key", "abcd efghij", true, false],
  ["api key with a newline", "api-key", "abcdefghij\n", true, false],
  ["api key omitted", "api-key", undefined, false, false],
  ["api key object", "api-key", validAccount, true, false],
];

describe("parseCredentials", () => {
  it.each(parseCases)("%s", (_name, method, credentials, provided, ok) => {
    expect(parseCredentials(method, credentials, provided).ok).toBe(ok);
  });

  it("keeps every service-account field and uses client_email as the summary", () => {
    const parsed = parseCredentials("service-account", validAccount, true);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== "service-account") {
      return;
    }
    expect(parsed.value.credentials).toEqual(validAccount);
    expect(parsed.value.summary).toBe("gateway@example.iam.gserviceaccount.com");
    expect(JSON.stringify(parsed.value)).not.toContain("not-a-key");
    expect(validAccount.private_key).toBe(PRIVATE_KEY);
  });

  it("reports every invalid service-account field at once", () => {
    const parsed = parseCredentials(
      "service-account",
      { type: "user", client_email: "nope", private_key: "nope" },
      true,
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.issues).toEqual([
      { path: "credentials.type", message: 'must be "service_account"' },
      { path: "credentials.client_email", message: "must be an email address" },
      { path: "credentials.private_key", message: "must be a private key" },
    ]);
    expect(JSON.stringify(parsed.issues)).not.toContain("nope");
  });
});

const planCases: Array<
  [string, KnownUpstreamAuthMethod, KnownUpstreamAuthMethod, boolean, "keep" | "clear" | "error"]
> = [
  ["adc stays adc", "application-default-credentials", "application-default-credentials", false, "keep"],
  [
    "adc rejects credentials",
    "application-default-credentials",
    "application-default-credentials",
    true,
    "error",
  ],
  ["adc to service account requires credentials", "application-default-credentials", "service-account", false, "error"],
  ["adc to api key requires credentials", "application-default-credentials", "api-key", false, "error"],
  ["service account keeps stored credentials", "service-account", "service-account", false, "keep"],
  ["service account to adc drops credentials", "service-account", "application-default-credentials", false, "clear"],
  [
    "service account to adc rejects new credentials",
    "service-account",
    "application-default-credentials",
    true,
    "error",
  ],
  ["service account to api key requires credentials", "service-account", "api-key", false, "error"],
  ["api key keeps stored credentials", "api-key", "api-key", false, "keep"],
  ["api key to adc drops credentials", "api-key", "application-default-credentials", false, "clear"],
  ["api key to service account requires credentials", "api-key", "service-account", false, "error"],
];

describe("planCredentialUpdate", () => {
  it.each(planCases)("%s", (_name, current, next, provided, expected) => {
    const result = planCredentialUpdate({
      currentAuthMethod: current,
      nextAuthMethod: next,
      credentials: provided ? validAccount : undefined,
      credentialsProvided: provided,
    });

    if (expected === "error") {
      expect(result.ok).toBe(false);
      return;
    }
    expect(result).toEqual({ ok: true, value: { action: expected } });
  });

  it.each([
    ["adc", "application-default-credentials"],
    ["service-account", "service-account"],
  ] as const)("replaces credentials when %s switches to a service account", (_name, current) => {
    const result = planCredentialUpdate({
      currentAuthMethod: current,
      nextAuthMethod: "service-account",
      credentials: validAccount,
      credentialsProvided: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== "replace") {
      throw new Error("expected a credential replacement");
    }
    expect(JSON.parse(result.value.plaintext) as unknown).toEqual(validAccount);
    expect(result.value.summary).toBe(validAccount.client_email);
  });

  it.each([
    ["adc", "application-default-credentials"],
    ["api-key", "api-key"],
    ["service-account", "service-account"],
  ] as const)("replaces credentials when %s moves to an api key", (_name, current) => {
    const apiKey = "express-mode-api-key-sentinel";
    const result = planCredentialUpdate({
      currentAuthMethod: current,
      nextAuthMethod: "api-key",
      credentials: apiKey,
      credentialsProvided: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== "replace") {
      throw new Error("expected a credential replacement");
    }
    expect(JSON.parse(result.value.plaintext) as unknown).toBe(apiKey);
    expect(result.value.summary).toBeNull();
  });

  it("rejects a credential that does not match the new auth method", () => {
    const wrongKey = planCredentialUpdate({
      currentAuthMethod: "service-account",
      nextAuthMethod: "api-key",
      credentials: validAccount,
      credentialsProvided: true,
    });
    const wrongAccount = planCredentialUpdate({
      currentAuthMethod: "api-key",
      nextAuthMethod: "service-account",
      credentials: "express-mode-api-key-sentinel",
      credentialsProvided: true,
    });

    expect(wrongKey.ok).toBe(false);
    expect(wrongAccount.ok).toBe(false);
    if (!wrongKey.ok) {
      expect(JSON.stringify(wrongKey.issues)).not.toContain(PRIVATE_KEY);
    }
    if (!wrongAccount.ok) {
      expect(JSON.stringify(wrongAccount.issues)).not.toContain("express-mode-api-key-sentinel");
    }
  });
});
