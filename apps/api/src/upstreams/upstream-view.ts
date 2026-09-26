import { InternalServerErrorException } from "@nestjs/common";
import { KNOWN_UPSTREAM_CONNECTION_STATUSES } from "@gateway/contracts";
import { isKnownUpstreamAuthMethod } from "./upstream-credentials.js";

export type UpstreamViewStatus = (typeof KNOWN_UPSTREAM_CONNECTION_STATUSES)[number];
export type UpstreamProbeStatus = Exclude<UpstreamViewStatus, "unknown">;

export interface UpstreamView {
  id: string;
  name: string;
  provider: "vertex-ai";
  enabled: boolean;
  projectId: string;
  location: string;
  authMethod: "application-default-credentials" | "service-account" | "api-key";
  hasCredentials: boolean;
  credentialSummary: string | null;
  priority: number;
  status: UpstreamViewStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpstreamSnapshot {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  projectId: string;
  location: string;
  authMethod: string;
  encryptedCredentials: string | null;
  credentialSummary: string | null;
  priority: number;
  status: string;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const VIEW_KEYS = [
  "id",
  "name",
  "provider",
  "enabled",
  "projectId",
  "location",
  "authMethod",
  "hasCredentials",
  "credentialSummary",
  "priority",
  "status",
  "lastCheckedAt",
  "createdAt",
  "updatedAt",
] as const;

export function toUpstreamView(upstream: UpstreamSnapshot): UpstreamView {
  const view: UpstreamView = {
    id: upstream.id,
    name: upstream.name,
    provider: providerOf(upstream.provider),
    enabled: upstream.enabled,
    projectId: upstream.projectId,
    location: upstream.location,
    authMethod: authMethodOf(upstream.authMethod),
    hasCredentials: upstream.encryptedCredentials !== null,
    credentialSummary:
      upstream.authMethod === "service-account" ? upstream.credentialSummary : null,
    priority: upstream.priority,
    status: statusOf(upstream.status),
    lastCheckedAt: upstream.lastCheckedAt?.toISOString() ?? null,
    createdAt: upstream.createdAt.toISOString(),
    updatedAt: upstream.updatedAt.toISOString(),
  };

  return view;
}

export function toAuditRecord(
  view: UpstreamView,
  credentialsChanged = false,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of VIEW_KEYS) {
    record[key] = view[key];
  }
  if (credentialsChanged) {
    record.credentialsChanged = true;
  }
  return record;
}

function providerOf(provider: string): "vertex-ai" {
  if (provider !== "vertex-ai") {
    throw new InternalServerErrorException("Upstream provider is not supported.");
  }
  return "vertex-ai";
}

function authMethodOf(authMethod: string): UpstreamView["authMethod"] {
  if (!isKnownUpstreamAuthMethod(authMethod)) {
    throw new InternalServerErrorException("Upstream auth method is not supported.");
  }
  return authMethod;
}

function statusOf(status: string): UpstreamViewStatus {
  switch (status) {
    case "unknown":
    case "connected":
    case "authentication_failed":
    case "permission_denied":
    case "model_unavailable":
    case "quota_exhausted":
    case "network_error":
    case "upstream_error":
      return status;
    default:
      throw new InternalServerErrorException("Upstream status is not supported.");
  }
}
