import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { RoutingStrategy } from "@gateway/contracts";
import { Model, ModelAlias, ModelRoute, Upstream } from "@gateway/database";
import type { Repository } from "typeorm";
import { buildRouteCandidates, type RouteCandidate } from "../routing/index.js";
import { canonicalRequestedModelName, isModelName } from "./model-name.js";

export interface ResolvedModel {
  model: Model;
  aliases: string[];
  upstream: Upstream;
  strategy: RoutingStrategy;
  candidates: RouteCandidate[];
  upstreamsById: Map<string, Upstream>;
}

@Injectable()
export class ModelResolver {
  constructor(
    @InjectRepository(Model)
    private readonly models: Repository<Model>,
    @InjectRepository(ModelAlias)
    private readonly aliases: Repository<ModelAlias>,
    @InjectRepository(ModelRoute)
    private readonly routes: Repository<ModelRoute>,
  ) {}

  async resolve(requestedName: string): Promise<ResolvedModel | null> {
    const name = canonicalRequestedModelName(requestedName);
    // Stored names cannot contain "/", so a name that fails the pattern cannot match.
    if (!isModelName(name)) {
      return null;
    }

    const byPublicName = await this.models.findOne({
      where: { publicName: name },
      relations: { upstream: true },
    });
    const model = byPublicName ?? (await this.modelForAlias(name));
    if (model === null) {
      return null;
    }

    if (
      !model.enabled ||
      model.availabilityStatus !== "available" ||
      model.upstream === undefined
    ) {
      return null;
    }

    const routes = await this.routes.find({
      where: { modelId: model.id },
      relations: { upstream: true },
    });

    const candidates = buildRouteCandidates({
      defaultUpstream: {
        id: model.upstream.id,
        name: model.upstream.name,
        priority: model.upstream.priority,
        enabled: model.upstream.enabled,
        status: model.upstream.status,
      },
      routes: routes.map((r) => ({
        upstreamId: r.upstreamId,
        priority: r.priority,
        enabled: r.enabled,
        upstream: {
          id: r.upstream.id,
          name: r.upstream.name,
          priority: r.upstream.priority,
          enabled: r.upstream.enabled,
          status: r.upstream.status,
        },
      })),
    });

    // Zero usable candidates makes the model unresolvable (404), even if the model
    // row itself is enabled. A disabled default upstream is accepted if another route is usable.
    const hasUsableCandidate = candidates.some((candidate) => candidate.enabled);
    if (!hasUsableCandidate) {
      return null;
    }

    const upstreamsById = new Map<string, Upstream>();
    upstreamsById.set(model.upstream.id, model.upstream);
    for (const r of routes) {
      if (r.upstream) {
        upstreamsById.set(r.upstream.id, r.upstream);
      }
    }

    const strategy: RoutingStrategy = routes.length > 0 ? routes[0].strategy : "priority";

    const aliasRows = await this.aliases.find({
      where: { modelId: model.id },
    });
    const aliases = aliasRows.map((r) => r.alias);

    return {
      model,
      aliases,
      upstream: model.upstream,
      strategy,
      candidates,
      upstreamsById,
    };
  }

  private async modelForAlias(alias: string): Promise<Model | null> {
    const row = await this.aliases.findOne({
      where: { alias },
      relations: { model: { upstream: true } },
    });
    return row?.model ?? null;
  }
}
