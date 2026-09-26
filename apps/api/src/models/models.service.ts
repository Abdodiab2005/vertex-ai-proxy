import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ADMIN_AUDIT_ACTIONS, type RoutingStrategy } from "@gateway/contracts";
import { Model, ModelAlias, ModelRoute, PricingRule, Upstream } from "@gateway/database";
import {
  Brackets,
  DataSource,
  In,
  QueryFailedError,
  type EntityManager,
  type Repository,
} from "typeorm";
import { AuditService } from "../audit/audit.service.js";
import { UpstreamError } from "../upstreams/providers/upstream-errors.js";
import { UpstreamProviderFactory } from "../upstreams/upstream-provider.factory.js";
import {
  modelSyncSummary,
  planModelSync,
  type ModelSyncSummary,
  type SyncModelRecord,
} from "./model-sync-plan.js";
import type {
  AddPricingRuleInput,
  CreateModelInput,
  ListModelsQuery,
  UpdateModelInput,
  UpdateModelRoutesInput,
} from "./models.schemas.js";
import {
  toCurrentPricing,
  toModelView,
  toPricingRuleView,
  type ModelRouteItemView,
  type ModelRoutesView,
  type ModelView,
  type PricingRuleView,
} from "./model-view.js";
import { isModelName } from "./model-name.js";
import {
  effectiveFromIsTooFarInPast,
  planPricingInsertion,
  pricingRuleHasTakenEffect,
} from "./pricing-schedule.js";

export interface ModelMutationActor {
  adminUserId: string;
  ipAddress: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_CONFLICT = "A model or alias with that name already exists.";
const UPSTREAM_MISSING = "Upstream not found.";
const EFFECTIVE_FROM_TOO_OLD = "effectiveFrom cannot be more than 60 seconds in the past.";
const PRICING_OVERLAP = "Pricing rule overlaps an existing rule for the same billing dimension.";
const PRICING_ALREADY_EFFECTIVE = "Pricing rules that have taken effect cannot be deleted.";

@Injectable()
export class ModelsService {
  constructor(
    @InjectRepository(Model)
    private readonly models: Repository<Model>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly providerFactory: UpstreamProviderFactory,
  ) {}

  async list(query: ListModelsQuery): Promise<ModelView[]> {
    const found = await this.findModels(query);
    return this.attachViews(this.dataSource.manager, found, new Date());
  }

  async get(id: string): Promise<ModelView> {
    return this.viewFor(this.dataSource.manager, id, new Date());
  }

  async sync(upstreamId: string, actor: ModelMutationActor): Promise<ModelSyncSummary> {
    const upstream = await this.dataSource.getRepository(Upstream).findOne({
      where: { id: upstreamId },
    });
    if (upstream === null) {
      throw new NotFoundException(UPSTREAM_MISSING);
    }
    // Google's model catalog rejects API keys ("API keys are not supported by this API"), so an
    // express-mode upstream can serve models but never list them; asking would only fail as a 502.
    if (upstream.authMethod === "api-key") {
      throw new BadRequestException(
        "Vertex express API keys can't list models: Google's model catalog only accepts OAuth credentials. Add models by name, or sync through an upstream that uses a service account or application default credentials.",
      );
    }

    let discoveredIds: string[];
    try {
      const listed = await this.providerFactory.forUpstream(upstream).listModels();
      discoveredIds = listed.models.map((model) => model.id);
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw new BadGatewayException(`Model discovery failed: ${error.kind}.`);
      }
      throw error;
    }

    return this.transaction(async (manager) => {
      // Same lock as public-name and alias writes, taken before any model row
      // lock. Discovery stays outside so a slow upstream does not hold it.
      await lockModelNameRegistry(manager);

      const current = await manager.findOne(Upstream, {
        where: { id: upstreamId },
        select: { id: true },
      });
      if (current === null) {
        throw new NotFoundException(UPSTREAM_MISSING);
      }

      const allModels = await manager.find(Model, {
        lock: { mode: "pessimistic_write" },
      });
      const aliases = await manager.find(ModelAlias);
      const aliasesByModel = groupBy(aliases, (alias) => alias.modelId);
      const records: SyncModelRecord[] = allModels.map((model) => ({
        id: model.id,
        upstreamId: model.upstreamId,
        upstreamModelName: model.upstreamModelName,
        publicName: model.publicName,
        availabilityStatus: model.availabilityStatus,
        aliases: (aliasesByModel.get(model.id) ?? []).map((alias) => alias.alias),
      }));
      const plan = planModelSync(upstreamId, records, discoveredIds);

      await setAvailability(
        manager,
        plan.markAvailable.map((item) => item.modelId),
        "available",
      );
      await setAvailability(
        manager,
        plan.markUnavailable.map((item) => item.modelId),
        "unavailable",
      );

      if (plan.create.length > 0) {
        await manager.save(
          plan.create.map((item) =>
            manager.create(Model, {
              publicName: item.id,
              upstreamModelName: item.id,
              displayName: item.id,
              provider: "vertex-ai",
              upstreamId,
              // The column default is enabled. An unpriced discovered model
              // must stay out of the resolver until an admin turns it on.
              enabled: false,
              availabilityStatus: "available",
              supportsText: item.supportsText,
              supportsVision: item.supportsVision,
              supportsAudio: item.supportsAudio,
              supportsVideo: item.supportsVideo,
              supportsFiles: item.supportsFiles,
              supportsTools: item.supportsTools,
              supportsStreaming: item.supportsStreaming,
              supportsEmbeddings: item.supportsEmbeddings,
              inputTokenLimit: null,
              outputTokenLimit: null,
            }),
          ),
        );
      }

      const summary = modelSyncSummary(plan);
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_SYNCED,
          adminUserId: actor.adminUserId,
          entityType: "upstream",
          entityId: upstreamId,
          ipAddress: actor.ipAddress,
          after: syncAuditAfter(summary),
        },
        manager,
      );
      return summary;
    });
  }

  async create(input: CreateModelInput, actor: ModelMutationActor): Promise<ModelView> {
    return this.transaction(async (manager) => {
      await lockModelNameRegistry(manager);
      await assertNameAvailable(manager, input.publicName);
      await this.requireUpstream(manager, input.upstreamId);

      let model: Model;
      try {
        model = await manager.save(
          manager.create(Model, {
            publicName: input.publicName,
            upstreamModelName: input.upstreamModelName,
            displayName: input.displayName,
            provider: input.provider,
            upstreamId: input.upstreamId,
            enabled: input.enabled,
            availabilityStatus: input.availabilityStatus,
            supportsText: input.supportsText,
            supportsVision: input.supportsVision,
            supportsAudio: input.supportsAudio,
            supportsVideo: input.supportsVideo,
            supportsFiles: input.supportsFiles,
            supportsTools: input.supportsTools,
            supportsStreaming: input.supportsStreaming,
            supportsEmbeddings: input.supportsEmbeddings,
            inputTokenLimit: input.inputTokenLimit ?? null,
            outputTokenLimit: input.outputTokenLimit ?? null,
          }),
        );
      } catch (error) {
        if (postgresCode(error) === "23503") {
          throw new BadRequestException(UPSTREAM_MISSING);
        }
        throw error;
      }

      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_CREATED,
          adminUserId: actor.adminUserId,
          entityType: "model",
          entityId: model.id,
          ipAddress: actor.ipAddress,
          after: modelSnapshot(model),
        },
        manager,
      );
      return this.viewFor(manager, model.id, new Date());
    });
  }

  async update(id: string, input: UpdateModelInput, actor: ModelMutationActor): Promise<ModelView> {
    if (Object.keys(input).length === 0) {
      return this.get(id);
    }

    return this.transaction(async (manager) => {
      if (input.publicName !== undefined) {
        await lockModelNameRegistry(manager);
      }
      const model = await this.lockModel(manager, id);
      if (input.publicName !== undefined && input.publicName !== model.publicName) {
        await assertNameAvailable(manager, input.publicName, model.id);
      }
      if (input.upstreamId !== undefined && input.upstreamId !== model.upstreamId) {
        await this.requireUpstream(manager, input.upstreamId);
      }

      const before = modelSnapshot(model);
      applyModelPatch(model, input);
      let saved: Model;
      try {
        saved = await manager.save(model);
      } catch (error) {
        if (postgresCode(error) === "23503") {
          throw new BadRequestException(UPSTREAM_MISSING);
        }
        throw error;
      }

      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_UPDATED,
          adminUserId: actor.adminUserId,
          entityType: "model",
          entityId: saved.id,
          ipAddress: actor.ipAddress,
          before,
          after: modelSnapshot(saved),
        },
        manager,
      );
      return this.viewFor(manager, saved.id, new Date());
    });
  }

  async addAlias(id: string, alias: string, actor: ModelMutationActor): Promise<ModelView> {
    return this.transaction(async (manager) => {
      await lockModelNameRegistry(manager);
      const model = await this.lockModel(manager, id);
      await assertNameAvailable(manager, alias);
      const saved = await manager.save(
        manager.create(ModelAlias, { alias, modelId: model.id }),
      );
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_ALIAS_ADDED,
          adminUserId: actor.adminUserId,
          entityType: "model",
          entityId: model.id,
          ipAddress: actor.ipAddress,
          after: { alias: saved.alias, aliasId: saved.id },
        },
        manager,
      );
      return this.viewFor(manager, model.id, new Date());
    });
  }

  async removeAlias(id: string, alias: string, actor: ModelMutationActor): Promise<ModelView> {
    if (!isModelName(alias)) {
      throw new NotFoundException("Not Found");
    }

    return this.transaction(async (manager) => {
      await lockModelNameRegistry(manager);
      const model = await this.lockModel(manager, id);
      const existing = await manager.findOne(ModelAlias, {
        where: { modelId: model.id, alias },
        lock: { mode: "pessimistic_write" },
      });
      if (existing === null) {
        throw new NotFoundException("Not Found");
      }
      await manager.delete(ModelAlias, { id: existing.id });
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_ALIAS_REMOVED,
          adminUserId: actor.adminUserId,
          entityType: "model",
          entityId: model.id,
          ipAddress: actor.ipAddress,
          before: { alias: existing.alias, aliasId: existing.id },
        },
        manager,
      );
      return this.viewFor(manager, model.id, new Date());
    });
  }

  async listPricing(id: string): Promise<PricingRuleView[]> {
    assertUuid(id);
    const model = await this.models.findOne({ where: { id }, select: { id: true } });
    if (model === null) {
      throw new NotFoundException("Not Found");
    }
    return this.pricingHistory(this.dataSource.manager, id);
  }

  async addPricingRule(
    id: string,
    input: AddPricingRuleInput,
    actor: ModelMutationActor,
  ): Promise<PricingRuleView[]> {
    const requestedFrom =
      input.effectiveFrom === undefined ? null : new Date(input.effectiveFrom);
    if (requestedFrom !== null && Number.isNaN(requestedFrom.getTime())) {
      throw new BadRequestException("effectiveFrom must be an ISO-8601 timestamp.");
    }

    return this.transaction(async (manager) => {
      await this.requireModel(manager, id);
      const effectiveFrom = requestedFrom ?? new Date();
      if (effectiveFromIsTooFarInPast(effectiveFrom, new Date())) {
        throw new BadRequestException(EFFECTIVE_FROM_TOO_OLD);
      }

      await lockPricingDimension(manager, id, input.billingDimension);
      const existing = await manager.find(PricingRule, {
        where: { modelId: id, billingDimension: input.billingDimension },
        lock: { mode: "pessimistic_write" },
      });
      const plan = planPricingInsertion(
        existing.map((rule) => ({
          id: rule.id,
          effectiveFrom: rule.effectiveFrom,
          effectiveTo: rule.effectiveTo,
        })),
        effectiveFrom,
      );
      if (plan.overlaps) {
        throw new ConflictException(PRICING_OVERLAP);
      }

      const closed = existing.filter((rule) => plan.closeIds.includes(rule.id));
      if (plan.closeIds.length > 0) {
        await manager.update(PricingRule, { id: In(plan.closeIds) }, { effectiveTo: effectiveFrom });
      }

      let saved: PricingRule;
      try {
        saved = await manager.save(
          manager.create(PricingRule, {
            modelId: id,
            billingDimension: input.billingDimension,
            unitSize: input.unitSize,
            price: input.price,
            currency: input.currency,
            effectiveFrom,
            effectiveTo: null,
          }),
        );
      } catch (error) {
        if (postgresCode(error) === "23503") {
          throw new NotFoundException("Not Found");
        }
        throw error;
      }

      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.PRICING_RULE_ADDED,
          adminUserId: actor.adminUserId,
          entityType: "pricing_rule",
          entityId: saved.id,
          ipAddress: actor.ipAddress,
          before: closed.length === 0 ? null : { closed: closed.map((rule) => pricingSnapshot(rule)) },
          after: {
            rule: pricingSnapshot(saved),
            closed: closed.map((rule) => ({
              id: rule.id,
              effectiveTo: effectiveFrom.toISOString(),
            })),
          },
        },
        manager,
      );
      return this.pricingHistory(manager, id);
    });
  }

  async deletePricingRule(id: string, ruleId: string, actor: ModelMutationActor): Promise<void> {
    assertUuid(ruleId);
    return this.transaction(async (manager) => {
      await this.requireModel(manager, id);
      // The dimension is immutable, so an unlocked read is enough to pick the
      // same advisory key add uses. The row lock comes after that key.
      const located = await manager.findOne(PricingRule, {
        where: { id: ruleId, modelId: id },
      });
      if (located === null) {
        throw new NotFoundException("Not Found");
      }
      await lockPricingDimension(manager, id, located.billingDimension);
      const rule = await manager.findOne(PricingRule, {
        where: { id: ruleId, modelId: id },
        lock: { mode: "pessimistic_write" },
      });
      if (rule === null) {
        throw new NotFoundException("Not Found");
      }
      if (pricingRuleHasTakenEffect(rule.effectiveFrom, new Date())) {
        throw new ConflictException(PRICING_ALREADY_EFFECTIVE);
      }

      await manager.delete(PricingRule, { id: rule.id });
      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.PRICING_RULE_DELETED,
          adminUserId: actor.adminUserId,
          entityType: "pricing_rule",
          entityId: rule.id,
          ipAddress: actor.ipAddress,
          before: pricingSnapshot(rule),
        },
        manager,
      );
    });
  }

  async getRoutes(id: string): Promise<ModelRoutesView> {
    assertUuid(id);
    const model = await this.dataSource.getRepository(Model).findOne({
      where: { id },
      relations: { upstream: true },
    });
    if (model === null) {
      throw new NotFoundException("Not Found");
    }

    const routes = await this.dataSource.getRepository(ModelRoute).find({
      where: { modelId: model.id },
      relations: { upstream: true },
      order: { priority: "ASC", createdAt: "ASC" },
    });

    return formatModelRoutes(model, routes);
  }

  async updateRoutes(
    id: string,
    input: UpdateModelRoutesInput,
    actor: ModelMutationActor,
  ): Promise<ModelRoutesView> {
    assertUuid(id);

    return this.transaction(async (manager) => {
      const model = await this.lockModel(manager, id);
      // The row lock can't take an outer join, so the default upstream is loaded separately.
      model.upstream = await manager.findOneOrFail(Upstream, { where: { id: model.upstreamId } });

      if (input.routes.length > 0) {
        const uniqueUpstreamIds = [...new Set(input.routes.map((r) => r.upstreamId))];
        const existingUpstreams = await manager.find(Upstream, {
          where: { id: In(uniqueUpstreamIds) },
        });
        if (existingUpstreams.length !== uniqueUpstreamIds.length) {
          throw new BadRequestException("One or more upstreams not found.");
        }
      }

      const existingRoutes = await manager.find(ModelRoute, {
        where: { modelId: model.id },
        relations: { upstream: true },
        order: { priority: "ASC", createdAt: "ASC" },
      });
      const existingStrategy: RoutingStrategy =
        existingRoutes.length > 0 ? existingRoutes[0].strategy : "priority";

      const before = {
        strategy: existingStrategy,
        routes: existingRoutes.map((r) => ({
          id: r.id,
          upstreamId: r.upstreamId,
          priority: r.priority,
          enabled: r.enabled,
          strategy: r.strategy,
        })),
      };

      await manager.delete(ModelRoute, { modelId: model.id });

      for (const routeInput of input.routes) {
        const routeEntity = manager.create(ModelRoute, {
          modelId: model.id,
          upstreamId: routeInput.upstreamId,
          priority: routeInput.priority,
          strategy: input.strategy,
          enabled: routeInput.enabled,
        });
        await manager.save(routeEntity);
      }

      const after = {
        strategy: input.strategy,
        routes: input.routes.map((r) => ({
          upstreamId: r.upstreamId,
          priority: r.priority,
          enabled: r.enabled,
        })),
      };

      await this.audit.record(
        {
          action: ADMIN_AUDIT_ACTIONS.MODEL_ROUTES_UPDATED,
          adminUserId: actor.adminUserId,
          entityType: "model",
          entityId: model.id,
          ipAddress: actor.ipAddress,
          before,
          after,
        },
        manager,
      );

      const reloadedRoutes = await manager.find(ModelRoute, {
        where: { modelId: model.id },
        relations: { upstream: true },
        order: { priority: "ASC", createdAt: "ASC" },
      });

      return formatModelRoutes(model, reloadedRoutes, input.strategy);
    });
  }

  private async findModels(query: ListModelsQuery): Promise<Model[]> {
    const qb = this.models
      .createQueryBuilder("model")
      .innerJoinAndSelect("model.upstream", "upstream")
      .orderBy("model.publicName", "ASC");

    if (query.search !== undefined && query.search.length > 0) {
      const search = `%${escapeLike(query.search)}%`;
      qb.leftJoin(ModelAlias, "alias", "alias.modelId = model.id")
        .andWhere(
          new Brackets((where) => {
            where
              .where("model.publicName ILIKE :search ESCAPE '\\'", { search })
              .orWhere("model.displayName ILIKE :search ESCAPE '\\'")
              .orWhere("model.upstreamModelName ILIKE :search ESCAPE '\\'")
              .orWhere("alias.alias ILIKE :search ESCAPE '\\'");
          }),
        )
        .distinct(true);
    }

    if (query.enabled !== undefined) {
      qb.andWhere("model.enabled = :enabled", { enabled: query.enabled === "true" });
    }
    if (query.availability !== undefined) {
      qb.andWhere("model.availabilityStatus = :availability", {
        availability: query.availability,
      });
    }

    return qb.getMany();
  }

  private async attachViews(
    manager: EntityManager,
    models: readonly Model[],
    now: Date,
  ): Promise<ModelView[]> {
    if (models.length === 0) {
      return [];
    }

    const ids = models.map((model) => model.id);
    const aliases = await manager.find(ModelAlias, {
      where: { modelId: In(ids) },
      order: { alias: "ASC" },
    });
    const rules = await manager
      .createQueryBuilder(PricingRule, "rule")
      .where("rule.modelId IN (:...ids)", { ids })
      .andWhere("rule.effectiveFrom <= :now", { now })
      .andWhere("(rule.effectiveTo IS NULL OR rule.effectiveTo > :now)")
      .getMany();
    const routes = await manager.find(ModelRoute, {
      where: { modelId: In(ids) },
    });

    const aliasesByModel = groupBy(aliases, (alias) => alias.modelId);
    const pricingByModel = groupBy(rules, (rule) => rule.modelId);
    const routesByModel = groupBy(routes, (route) => route.modelId);

    return models.map((model) => {
      const modelRoutes = routesByModel.get(model.id) ?? [];
      const strategy: RoutingStrategy =
        modelRoutes.length > 0 ? modelRoutes[0].strategy : "priority";
      const hasDefault = modelRoutes.some((r) => r.upstreamId === model.upstreamId);
      const routeCount = hasDefault ? modelRoutes.length : modelRoutes.length + 1;
      return toModelView(
        model,
        (aliasesByModel.get(model.id) ?? []).map((alias) => alias.alias),
        (pricingByModel.get(model.id) ?? []).map(toCurrentPricing),
        { routeCount, strategy },
      );
    });
  }

  private async viewFor(manager: EntityManager, id: string, now: Date): Promise<ModelView> {
    assertUuid(id);
    const model = await manager.findOne(Model, {
      where: { id },
      relations: { upstream: true },
    });
    if (model === null) {
      throw new NotFoundException("Not Found");
    }
    const [view] = await this.attachViews(manager, [model], now);
    if (view === undefined) {
      throw new NotFoundException("Not Found");
    }
    return view;
  }

  private async pricingHistory(manager: EntityManager, modelId: string): Promise<PricingRuleView[]> {
    const rules = await manager.find(PricingRule, { where: { modelId } });
    rules.sort((left, right) => {
      const byFrom = right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
      if (byFrom !== 0) {
        return byFrom;
      }
      return right.createdAt.getTime() - left.createdAt.getTime();
    });
    return rules.map(toPricingRuleView);
  }

  private async lockModel(manager: EntityManager, id: string): Promise<Model> {
    assertUuid(id);
    const model = await manager.findOne(Model, {
      where: { id },
      lock: { mode: "pessimistic_write" },
    });
    if (model === null) {
      throw new NotFoundException("Not Found");
    }
    return model;
  }

  private async requireModel(manager: EntityManager, id: string): Promise<void> {
    assertUuid(id);
    const model = await manager.findOne(Model, { where: { id }, select: { id: true } });
    if (model === null) {
      throw new NotFoundException("Not Found");
    }
  }

  private async requireUpstream(manager: EntityManager, upstreamId: string): Promise<void> {
    const upstream = await manager.findOne(Upstream, { where: { id: upstreamId } });
    if (upstream === null) {
      throw new BadRequestException(UPSTREAM_MISSING);
    }
  }

  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw new ConflictException(NAME_CONFLICT);
      }
      throw error;
    }
  }
}

function applyModelPatch(model: Model, input: UpdateModelInput): void {
  if (input.publicName !== undefined) {
    model.publicName = input.publicName;
  }
  if (input.upstreamModelName !== undefined) {
    model.upstreamModelName = input.upstreamModelName;
  }
  if (input.displayName !== undefined) {
    model.displayName = input.displayName;
  }
  if (input.provider !== undefined) {
    model.provider = input.provider;
  }
  if (input.upstreamId !== undefined) {
    model.upstreamId = input.upstreamId;
  }
  if (input.enabled !== undefined) {
    model.enabled = input.enabled;
  }
  if (input.availabilityStatus !== undefined) {
    model.availabilityStatus = input.availabilityStatus;
  }
  if (input.supportsText !== undefined) {
    model.supportsText = input.supportsText;
  }
  if (input.supportsVision !== undefined) {
    model.supportsVision = input.supportsVision;
  }
  if (input.supportsAudio !== undefined) {
    model.supportsAudio = input.supportsAudio;
  }
  if (input.supportsVideo !== undefined) {
    model.supportsVideo = input.supportsVideo;
  }
  if (input.supportsFiles !== undefined) {
    model.supportsFiles = input.supportsFiles;
  }
  if (input.supportsTools !== undefined) {
    model.supportsTools = input.supportsTools;
  }
  if (input.supportsStreaming !== undefined) {
    model.supportsStreaming = input.supportsStreaming;
  }
  if (input.supportsEmbeddings !== undefined) {
    model.supportsEmbeddings = input.supportsEmbeddings;
  }
  if (input.inputTokenLimit !== undefined) {
    model.inputTokenLimit = input.inputTokenLimit;
  }
  if (input.outputTokenLimit !== undefined) {
    model.outputTokenLimit = input.outputTokenLimit;
  }
}

function modelSnapshot(model: Model): Record<string, unknown> {
  return {
    id: model.id,
    publicName: model.publicName,
    upstreamModelName: model.upstreamModelName,
    displayName: model.displayName,
    provider: model.provider,
    enabled: model.enabled,
    availabilityStatus: model.availabilityStatus,
    supportsText: model.supportsText,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio,
    supportsVideo: model.supportsVideo,
    supportsFiles: model.supportsFiles,
    supportsTools: model.supportsTools,
    supportsStreaming: model.supportsStreaming,
    supportsEmbeddings: model.supportsEmbeddings,
    inputTokenLimit: model.inputTokenLimit,
    outputTokenLimit: model.outputTokenLimit,
    upstreamId: model.upstreamId,
  };
}

function pricingSnapshot(rule: PricingRule): Record<string, unknown> {
  return {
    id: rule.id,
    modelId: rule.modelId,
    billingDimension: rule.billingDimension,
    unitSize: rule.unitSize,
    price: rule.price,
    currency: rule.currency,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    effectiveTo: rule.effectiveTo?.toISOString() ?? null,
  };
}

// One lock for every public-name and alias write. Taking a per-name lock after
// the model row is locked deadlocks with the unique index: the rename holds the
// row while waiting for the name, and the insert holds the name while waiting on
// that same index entry. The cross-table check has to run in this transaction.
async function lockModelNameRegistry(manager: EntityManager): Promise<void> {
  await manager.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('model-name-registry', 0))`,
  );
}

async function lockPricingDimension(
  manager: EntityManager,
  modelId: string,
  billingDimension: string,
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `pricing:${modelId}:${billingDimension}`,
  ]);
}

async function assertNameAvailable(
  manager: EntityManager,
  name: string,
  exceptModelId?: string,
): Promise<void> {
  const modelRows = await manager.query<Array<{ id: string }>>(
    exceptModelId === undefined
      ? `SELECT id FROM models WHERE public_name = $1 LIMIT 1`
      : `SELECT id FROM models WHERE public_name = $1 AND id <> $2 LIMIT 1`,
    exceptModelId === undefined ? [name] : [name, exceptModelId],
  );
  if (modelRows.length > 0) {
    throw new ConflictException(NAME_CONFLICT);
  }

  const aliasRows = await manager.query<Array<{ id: string }>>(
    `SELECT id FROM model_aliases WHERE alias = $1 LIMIT 1`,
    [name],
  );
  if (aliasRows.length > 0) {
    throw new ConflictException(NAME_CONFLICT);
  }
}

function assertUuid(value: string): void {
  if (!isUuid(value)) {
    throw new NotFoundException("Not Found");
  }
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

async function setAvailability(
  manager: EntityManager,
  ids: readonly string[],
  availabilityStatus: Model["availabilityStatus"],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await manager.update(Model, { id: In([...ids]) }, { availabilityStatus });
}

function syncAuditAfter(summary: ModelSyncSummary): Record<string, unknown> {
  return {
    discovered: summary.discovered,
    created: summary.created,
    markedAvailable: summary.markedAvailable,
    markedUnavailable: summary.markedUnavailable,
    conflicts: summary.conflicts,
  };
}

function postgresCode(error: unknown): string | undefined {
  if (!(error instanceof QueryFailedError)) {
    return undefined;
  }
  const driverError: unknown = error.driverError;
  if (typeof driverError !== "object" || driverError === null || !("code" in driverError)) {
    return undefined;
  }
  const code = driverError.code;
  return typeof code === "string" ? code : undefined;
}

function formatModelRoutes(
  model: Model,
  routes: ModelRoute[],
  strategyOverride?: RoutingStrategy,
): ModelRoutesView {
  const strategy: RoutingStrategy =
    strategyOverride ?? (routes.length > 0 ? routes[0].strategy : "priority");

  const defaultOverride = routes.find((r) => r.upstreamId === model.upstreamId);
  const defaultRouteItem: ModelRouteItemView = {
    id: defaultOverride ? defaultOverride.id : null,
    upstreamId: model.upstreamId,
    upstreamName: model.upstream.name,
    priority: defaultOverride ? defaultOverride.priority : 0,
    enabled: defaultOverride ? defaultOverride.enabled : true,
    upstreamEnabled: model.upstream.enabled,
    upstreamStatus: model.upstream.status,
    isDefault: true,
  };

  const additionalItems: ModelRouteItemView[] = routes
    .filter((r) => r.upstreamId !== model.upstreamId)
    .map((r) => ({
      id: r.id,
      upstreamId: r.upstreamId,
      upstreamName: r.upstream.name,
      priority: r.priority,
      enabled: r.enabled,
      upstreamEnabled: r.upstream.enabled,
      upstreamStatus: r.upstream.status,
      isDefault: false,
    }));

  return {
    strategy,
    routes: [defaultRouteItem, ...additionalItems],
  };
}

