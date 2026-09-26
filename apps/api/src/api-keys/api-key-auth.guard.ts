import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ApiKey } from "@gateway/database";
import { ApiKeyStatus } from "@gateway/contracts";
import { Request } from "express";
import { BlockList } from "node:net";
import { GeminiApiException } from "../public-api/gemini-errors.js";
import { hashApiKey, looksLikeApiKey } from "./api-key-material.js";

export interface ApiKeyAuthenticatedRequest extends Request {
  apiKey: ApiKey;
}

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeys: Repository<ApiKey>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyAuthenticatedRequest>();
    
    let rawKey = request.headers["x-goog-api-key"];
    if (Array.isArray(rawKey)) {
      rawKey = rawKey[0];
    }
    
    if (!rawKey && typeof request.query["key"] === "string") {
      rawKey = request.query["key"];
    }

    if (!rawKey || !looksLikeApiKey(rawKey)) {
      throw new GeminiApiException(401, "UNAUTHENTICATED", "API key not valid. Please pass a valid API key.");
    }

    const keyHash = hashApiKey(rawKey);
    const apiKey = await this.apiKeys.findOne({ where: { keyHash } });

    if (!apiKey) {
      throw new GeminiApiException(401, "UNAUTHENTICATED", "API key not valid. Please pass a valid API key.");
    }

    if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
      if (apiKey.status !== ApiKeyStatus.EXPIRED) {
        await this.apiKeys.update({ keyHash }, { status: ApiKeyStatus.EXPIRED });
        apiKey.status = ApiKeyStatus.EXPIRED;
      }
    }

    if (apiKey.status === ApiKeyStatus.REVOKED) {
      throw new GeminiApiException(403, "PERMISSION_DENIED", "API key has been revoked.");
    } else if (apiKey.status === ApiKeyStatus.SUSPENDED) {
      throw new GeminiApiException(403, "PERMISSION_DENIED", "API key is suspended.");
    } else if (apiKey.status === ApiKeyStatus.EXPIRED) {
      throw new GeminiApiException(403, "PERMISSION_DENIED", "API key has expired.");
    } else if (apiKey.status === ApiKeyStatus.CREDIT_EXHAUSTED) {
      throw new GeminiApiException(429, "RESOURCE_EXHAUSTED", "API key credit has been exhausted.");
    }

    // IP restrictions
    const clientIp = request.ip;
    if (clientIp) {
      if (apiKey.blockedIPs && apiKey.blockedIPs.length > 0) {
        if (this.ipMatches(clientIp, apiKey.blockedIPs)) {
          throw new GeminiApiException(403, "PERMISSION_DENIED", "Requests from this IP address are not allowed for this API key.");
        }
      }

      if (apiKey.allowedIPs && apiKey.allowedIPs.length > 0) {
        if (!this.ipMatches(clientIp, apiKey.allowedIPs)) {
          throw new GeminiApiException(403, "PERMISSION_DENIED", "Requests from this IP address are not allowed for this API key.");
        }
      }
    } else {
      if (apiKey.allowedIPs && apiKey.allowedIPs.length > 0) {
        throw new GeminiApiException(403, "PERMISSION_DENIED", "Requests from this IP address are not allowed for this API key.");
      }
    }

    request.apiKey = apiKey;

    // Update lastUsedAt if null or older than 1 minute
    this.apiKeys.query(
      `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [keyHash]
    ).catch(err => {
      this.logger.error(`Failed to update last_used_at for key ${apiKey.id}`, err instanceof Error ? err.stack : undefined);
    });

    return true;
  }

  private ipMatches(ip: string, list: string[]): boolean {
    const isIPv6 = ip.includes(":");
    const blockList = new BlockList();
    for (const rule of list) {
      if (rule.includes("/")) {
        const [baseIp, prefix] = rule.split("/");
        const type = baseIp?.includes(":") ? "ipv6" : "ipv4";
        blockList.addSubnet(baseIp!, parseInt(prefix!, 10), type);
      } else {
        const type = rule.includes(":") ? "ipv6" : "ipv4";
        blockList.addAddress(rule, type);
      }
    }
    return blockList.check(ip, isIPv6 ? "ipv6" : "ipv4");
  }
}

export function assertModelAllowed(
  apiKey: ApiKey,
  modelNames: string | readonly string[],
  requestedName?: string,
): void {
  const names = typeof modelNames === "string" ? [modelNames] : modelNames;
  const displayName = requestedName ?? (names[0] ?? "");

  // A model is blocked if any name in its identity set (public name or aliases) appears in blockedModels.
  if (apiKey.blockedModels && apiKey.blockedModels.length > 0) {
    if (names.some((name) => apiKey.blockedModels!.includes(name))) {
      throw new GeminiApiException(
        403,
        "PERMISSION_DENIED",
        `This API key is not allowed to use model ${displayName}.`,
      );
    }
  }

  // When an allowlist is configured, a model is allowed if any name in its identity set matches.
  if (apiKey.allowedModels && apiKey.allowedModels.length > 0) {
    if (!names.some((name) => apiKey.allowedModels!.includes(name))) {
      throw new GeminiApiException(
        403,
        "PERMISSION_DENIED",
        `This API key is not allowed to use model ${displayName}.`,
      );
    }
  }
}

export const PUBLIC_ENDPOINTS = [
  "generateContent",
  "streamGenerateContent",
  "countTokens",
  "embedContent",
  "batchEmbedContents",
  "models.list",
  "models.get",
] as const;

export type PublicEndpoint = (typeof PUBLIC_ENDPOINTS)[number];

export function assertEndpointAllowed(apiKey: ApiKey, endpoint: PublicEndpoint): void {
  if (apiKey.allowedEndpoints && apiKey.allowedEndpoints.length > 0) {
    if (!endpointPermitted(apiKey.allowedEndpoints, endpoint)) {
      throw new GeminiApiException(403, "PERMISSION_DENIED", `This API key is not allowed to use ${endpoint}.`);
    }
  }
}

// Keys issued before batchEmbedContents existed only list embedContent. The official SDKs
// implement embedContent by calling batchEmbedContents, so that grant covers both.
function endpointPermitted(allowed: readonly string[], endpoint: PublicEndpoint): boolean {
  if (allowed.includes(endpoint)) {
    return true;
  }
  return endpoint === "batchEmbedContents" && allowed.includes("embedContent");
}
