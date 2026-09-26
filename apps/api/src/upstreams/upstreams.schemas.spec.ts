import { createUpstreamSchema, patchUpstreamSchema, testUpstreamSchema } from "./upstreams.schemas.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";

const adc = {
  name: "prod",
  projectId: "gw-upstream-test",
  location: "us-central1",
  authMethod: "application-default-credentials" as const,
};

describe("upstream request schemas", () => {
  it("defaults provider, enabled, and priority", () => {
    const parsed = createUpstreamSchema.parse(adc);

    expect(parsed).toMatchObject({
      provider: "vertex-ai",
      enabled: true,
      priority: 0,
    });
    expect(parsed.credentials).toBeUndefined();
  });

  it("rejects unknown keys and credentials that do not match the auth method", () => {
    expect(createUpstreamSchema.safeParse({ ...adc, encryptedCredentials: "leak" }).success).toBe(
      false,
    );
    expect(createUpstreamSchema.safeParse({ ...adc, credentials: { any: true } }).success).toBe(
      false,
    );
    expect(
      createUpstreamSchema.safeParse({
        ...adc,
        authMethod: "service-account",
        credentials: {
          type: "service_account",
          client_email: "gateway@example.iam.gserviceaccount.com",
          private_key: "missing-marker",
        },
      }).success,
    ).toBe(false);
    expect(
      createUpstreamSchema.safeParse({
        ...adc,
        authMethod: "api-key",
        credentials: "short",
      }).success,
    ).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, projectId: "NOPE" }).success).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, location: "US" }).success).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, priority: 1.5 }).success).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, priority: 1001 }).success).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, name: "" }).success).toBe(false);
    expect(createUpstreamSchema.safeParse({ ...adc, provider: "openai" }).success).toBe(false);
  });

  it("accepts a service account key without dropping extra fields", () => {
    const credentials = {
      type: "service_account",
      client_email: "gateway@example.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY,
      project_id: "gw-upstream-test",
    };
    const parsed = createUpstreamSchema.parse({
      ...adc,
      authMethod: "service-account",
      credentials,
    });

    expect(parsed.credentials).toEqual(credentials);
  });

  it("lets a patch omit credentials and rejects unknown keys", () => {
    expect(patchUpstreamSchema.parse({})).toEqual({});
    expect(patchUpstreamSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(patchUpstreamSchema.safeParse({ status: "connected" }).success).toBe(false);
    expect(testUpstreamSchema.safeParse({ model: "" }).success).toBe(false);
    expect(testUpstreamSchema.safeParse({ model: "a".repeat(201) }).success).toBe(false);
    expect(testUpstreamSchema.parse({ model: "gemini-2.5-flash" })).toEqual({
      model: "gemini-2.5-flash",
    });
  });
});
