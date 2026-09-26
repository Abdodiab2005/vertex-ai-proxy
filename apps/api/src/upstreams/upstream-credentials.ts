import { z } from "zod";

export const UPSTREAM_AUTH_METHODS = [
  "application-default-credentials",
  "service-account",
  "api-key",
] as const;

export type KnownUpstreamAuthMethod = (typeof UPSTREAM_AUTH_METHODS)[number];

export interface CredentialIssue {
  path: string;
  message: string;
}

export type ParsedCredentials =
  | { kind: "none" }
  | { kind: "service-account"; credentials: Record<string, unknown>; summary: string }
  | { kind: "api-key"; apiKey: string };

export type CredentialPlan =
  | { action: "keep" }
  | { action: "clear" }
  | {
      action: "replace";
      plaintext: string;
      summary: string | null;
    };

type CredentialResult<T> = { ok: true; value: T } | { ok: false; issues: CredentialIssue[] };

export function isKnownUpstreamAuthMethod(value: string): value is KnownUpstreamAuthMethod {
  return (
    value === "application-default-credentials" ||
    value === "service-account" ||
    value === "api-key"
  );
}

// Bound as AES-GCM associated data so a ciphertext copied onto another upstream
// row does not decrypt.
export function upstreamCredentialAssociatedData(upstreamId: string): string {
  return `upstream:${upstreamId}`;
}

export function credentialIssueMessages(issues: CredentialIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

export function parseCredentials(
  authMethod: KnownUpstreamAuthMethod,
  credentials: unknown,
  credentialsProvided: boolean,
): CredentialResult<ParsedCredentials> {
  if (authMethod === "application-default-credentials") {
    if (credentialsProvided) {
      return fail("credentials", "must be omitted for application-default-credentials");
    }
    return { ok: true, value: { kind: "none" } };
  }

  if (!credentialsProvided) {
    return fail("credentials", `required for ${authMethod}`);
  }

  if (authMethod === "service-account") {
    return parseServiceAccount(credentials);
  }

  return parseApiKey(credentials);
}

export function planCredentialUpdate(input: {
  currentAuthMethod: KnownUpstreamAuthMethod;
  nextAuthMethod: KnownUpstreamAuthMethod;
  credentials: unknown;
  credentialsProvided: boolean;
}): CredentialResult<CredentialPlan> {
  const { currentAuthMethod, nextAuthMethod, credentials, credentialsProvided } = input;

  if (nextAuthMethod === "application-default-credentials") {
    if (credentialsProvided) {
      return fail("credentials", "must be omitted for application-default-credentials");
    }
    if (currentAuthMethod === "application-default-credentials") {
      return { ok: true, value: { action: "keep" } };
    }
    return { ok: true, value: { action: "clear" } };
  }

  if (!credentialsProvided) {
    if (nextAuthMethod === currentAuthMethod) {
      return { ok: true, value: { action: "keep" } };
    }
    return fail("credentials", "required when changing auth method");
  }

  const parsed = parseCredentials(nextAuthMethod, credentials, true);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }

  if (parsed.value.kind === "api-key") {
    return {
      ok: true,
      value: {
        action: "replace",
        plaintext: JSON.stringify(parsed.value.apiKey),
        summary: null,
      },
    };
  }

  if (parsed.value.kind === "service-account") {
    return {
      ok: true,
      value: {
        action: "replace",
        plaintext: JSON.stringify(parsed.value.credentials),
        summary: parsed.value.summary,
      },
    };
  }

  return fail("credentials", "must be omitted for application-default-credentials");
}

function parseServiceAccount(credentials: unknown): CredentialResult<ParsedCredentials> {
  if (!isRecord(credentials)) {
    return fail("credentials", "must be a service account key object");
  }

  const issues: CredentialIssue[] = [];
  if (credentials.type !== "service_account") {
    issues.push({ path: "credentials.type", message: 'must be "service_account"' });
  }

  const clientEmail = credentials.client_email;
  const privateKey = credentials.private_key;
  if (typeof clientEmail !== "string" || !z.email().safeParse(clientEmail).success) {
    issues.push({ path: "credentials.client_email", message: "must be an email address" });
  }
  if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    issues.push({ path: "credentials.private_key", message: "must be a private key" });
  }

  if (issues.length > 0 || typeof clientEmail !== "string" || typeof privateKey !== "string") {
    return {
      ok: false,
      issues:
        issues.length > 0
          ? issues
          : [{ path: "credentials", message: "must be a service account key object" }],
    };
  }

  return {
    ok: true,
    value: {
      kind: "service-account",
      credentials: { ...credentials },
      summary: clientEmail,
    },
  };
}

function parseApiKey(credentials: unknown): CredentialResult<ParsedCredentials> {
  if (typeof credentials !== "string") {
    return fail("credentials", "must be an API key string");
  }
  if (credentials.length < 10 || credentials.length > 512 || /\s/.test(credentials)) {
    return fail("credentials", "must be 10 to 512 characters with no whitespace");
  }
  return { ok: true, value: { kind: "api-key", apiKey: credentials } };
}

function fail(path: string, message: string): { ok: false; issues: CredentialIssue[] } {
  return { ok: false, issues: [{ path, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
