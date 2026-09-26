import { InternalServerErrorException } from "@nestjs/common";
import { toAuditRecord, toUpstreamView, type UpstreamSnapshot } from "./upstream-view.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----\n";
const API_KEY = "express-mode-api-key-sentinel";

function snapshot(overrides: Partial<UpstreamSnapshot> = {}): UpstreamSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "prod",
    provider: "vertex-ai",
    enabled: true,
    projectId: "gw-upstream-test",
    location: "us-central1",
    authMethod: "service-account",
    encryptedCredentials: `v1.payload.${PRIVATE_KEY}`,
    credentialSummary: "gateway@example.iam.gserviceaccount.com",
    priority: 2,
    status: "unknown",
    lastCheckedAt: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toUpstreamView", () => {
  it("returns the admin view and leaves secret material out", () => {
    const view = toUpstreamView(
      snapshot({ lastCheckedAt: new Date("2026-03-03T04:05:06.000Z") }),
    );

    expect(view).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "prod",
      provider: "vertex-ai",
      enabled: true,
      projectId: "gw-upstream-test",
      location: "us-central1",
      authMethod: "service-account",
      hasCredentials: true,
      credentialSummary: "gateway@example.iam.gserviceaccount.com",
      priority: 2,
      status: "unknown",
      lastCheckedAt: "2026-03-03T04:05:06.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    expect(Object.keys(view).sort()).toEqual(
      [
        "authMethod",
        "createdAt",
        "credentialSummary",
        "enabled",
        "hasCredentials",
        "id",
        "lastCheckedAt",
        "location",
        "name",
        "priority",
        "projectId",
        "provider",
        "status",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(view)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(view)).not.toContain("secret-key-material");
    expect(view).not.toHaveProperty("encryptedCredentials");
    expect(view).not.toHaveProperty("credentials");
  });

  it("hides the summary for api keys and application default credentials", () => {
    const apiKeyView = toUpstreamView(
      snapshot({
        authMethod: "api-key",
        encryptedCredentials: `stored-plaintext:${API_KEY}`,
        credentialSummary: "should-not-be-shown@example.com",
      }),
    );
    const adcView = toUpstreamView(
      snapshot({
        authMethod: "application-default-credentials",
        encryptedCredentials: null,
        credentialSummary: "should-not-be-shown@example.com",
      }),
    );

    expect(apiKeyView.hasCredentials).toBe(true);
    expect(apiKeyView.credentialSummary).toBeNull();
    expect(JSON.stringify(apiKeyView)).not.toContain(API_KEY);
    expect(adcView.hasCredentials).toBe(false);
    expect(adcView.credentialSummary).toBeNull();
  });

  it("rejects a status outside the known set", () => {
    expect(() => toUpstreamView(snapshot({ status: "on-fire" }))).toThrow(
      InternalServerErrorException,
    );
  });
});

describe("toAuditRecord", () => {
  it("copies the view and records credentialsChanged only when asked", () => {
    const view = toUpstreamView(snapshot());
    const plain = toAuditRecord(view);
    const changed = toAuditRecord(view, true);

    expect(plain).not.toHaveProperty("credentialsChanged");
    expect(changed.credentialsChanged).toBe(true);
    expect(JSON.stringify(plain)).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify(changed)).not.toContain("secret-key-material");
    expect(plain).not.toHaveProperty("encryptedCredentials");
  });
});
