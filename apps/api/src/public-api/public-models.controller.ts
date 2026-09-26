import { Controller, Get, Param, Query, UseGuards, UseFilters, Req } from "@nestjs/common";
import { ApiKeyAuthGuard, ApiKeyAuthenticatedRequest, assertModelAllowed, assertEndpointAllowed } from "../api-keys/api-key-auth.guard.js";
import { GatewayAvailabilityGuard } from "../settings/gateway-availability.guard.js";
import { GeminiExceptionFilter, GeminiApiException } from "./gemini-errors.js";
import { ModelResolver } from "../models/model-resolver.js";
import { canonicalRequestedModelName } from "../models/model-name.js";
import { InjectRepository } from "@nestjs/typeorm";
import { Model } from "@gateway/database";
import { Brackets, Repository } from "typeorm";

@Controller("v1beta/models")
@UseFilters(GeminiExceptionFilter)
// Availability runs first so a kill switch rejects the request before any API-key lookup.
@UseGuards(GatewayAvailabilityGuard, ApiKeyAuthGuard)
export class PublicModelsController {
  constructor(
    private readonly modelResolver: ModelResolver,
    @InjectRepository(Model)
    private readonly models: Repository<Model>,
  ) {}

  @Get()
  async listModels(
    @Req() req: ApiKeyAuthenticatedRequest,
    @Query("pageSize") pageSizeQuery?: string,
    @Query("pageToken") pageToken?: string,
  ) {
    assertEndpointAllowed(req.apiKey, "models.list");

    let pageSize = 50;
    if (pageSizeQuery !== undefined) {
      const parsed = parseInt(pageSizeQuery, 10);
      if (!isNaN(parsed)) {
        pageSize = Math.min(Math.max(parsed, 1), 1000);
      }
    }

    let lastPublicName = "";
    if (pageToken) {
      if (!/^[A-Za-z0-9\-_]+={0,2}$/.test(pageToken)) {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", "Invalid pageToken.");
      }
      try {
        lastPublicName = Buffer.from(pageToken, "base64url").toString("utf-8");
      } catch {
        throw new GeminiApiException(400, "INVALID_ARGUMENT", "Invalid pageToken.");
      }
    }

    const qb = this.models.createQueryBuilder("model")
      .innerJoin("model.upstream", "upstream")
      .where("model.enabled = :enabled", { enabled: true })
      .andWhere("model.availabilityStatus = :status", { status: "available" })
      .andWhere(
        new Brackets((sub) => {
          sub.where("upstream.enabled = true").orWhere(
            `EXISTS (
              SELECT 1 FROM model_routes mr
              INNER JOIN upstreams u ON mr.upstream_id = u.id
              WHERE mr.model_id = model.id AND mr.enabled = true AND u.enabled = true
            )`,
          );
        }),
      );

    if (lastPublicName) {
      qb.andWhere("model.publicName > :lastPublicName", { lastPublicName });
    }

    if (req.apiKey.allowedModels && req.apiKey.allowedModels.length > 0) {
      qb.andWhere(
        new Brackets((sub) => {
          sub.where("model.publicName IN (:...allowed)", { allowed: req.apiKey.allowedModels }).orWhere(
            `EXISTS (
              SELECT 1 FROM model_aliases ma
              WHERE ma.model_id = model.id AND ma.alias IN (:...allowed)
            )`,
            { allowed: req.apiKey.allowedModels },
          );
        }),
      );
    }
    if (req.apiKey.blockedModels && req.apiKey.blockedModels.length > 0) {
      qb.andWhere(
        new Brackets((sub) => {
          sub.where("model.publicName NOT IN (:...blocked)", { blocked: req.apiKey.blockedModels }).andWhere(
            `NOT EXISTS (
              SELECT 1 FROM model_aliases ma
              WHERE ma.model_id = model.id AND ma.alias IN (:...blocked)
            )`,
            { blocked: req.apiKey.blockedModels },
          );
        }),
      );
    }

    qb.orderBy("model.publicName", "ASC");
    qb.take(pageSize + 1);

    const models = await qb.getMany();

    const hasNextPage = models.length > pageSize;
    const returnedModels = hasNextPage ? models.slice(0, pageSize) : models;

    let nextPageToken: string | undefined;
    if (hasNextPage) {
      const last = returnedModels[returnedModels.length - 1]!;
      nextPageToken = Buffer.from(last.publicName).toString("base64url");
    }

    return {
      models: returnedModels.map(m => this.mapToResource(m, m.publicName)),
      ...(nextPageToken ? { nextPageToken } : {})
    };
  }

  @Get(":model")
  async getModel(
    @Req() req: ApiKeyAuthenticatedRequest,
    @Param("model") requestedName: string,
  ) {
    assertEndpointAllowed(req.apiKey, "models.get");
    
    const canonicalName = canonicalRequestedModelName(requestedName);
    
    const resolved = await this.modelResolver.resolve(canonicalName);
    if (!resolved) {
      throw new GeminiApiException(404, "NOT_FOUND", `Model ${canonicalName} is not found.`);
    }

    assertModelAllowed(
      req.apiKey,
      [resolved.model.publicName, ...(resolved.aliases ?? [])],
      canonicalName,
    );

    return this.mapToResource(resolved.model, canonicalName);
  }

  private mapToResource(model: Model, clientRequestedName: string) {
    const supportedGenerationMethods: string[] = [];
    if (model.supportsText) {
      supportedGenerationMethods.push("generateContent", "countTokens");
    }
    if (model.supportsEmbeddings) {
      supportedGenerationMethods.push("embedContent");
    }

    const resource: Record<string, unknown> = {
      name: `models/${clientRequestedName}`,
      baseModelId: model.publicName,
      displayName: model.displayName,
      supportedGenerationMethods,
    };

    if (model.inputTokenLimit !== null) {
      resource.inputTokenLimit = model.inputTokenLimit;
    }
    if (model.outputTokenLimit !== null) {
      resource.outputTokenLimit = model.outputTokenLimit;
    }

    return resource;
  }
}
