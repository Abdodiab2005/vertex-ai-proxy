import type { ModelAvailabilityStatus, RoutingStrategy } from "@gateway/contracts";
import type { Model, PricingRule } from "@gateway/database";

export interface CurrentPricingView {
  billingDimension: string;
  unitSize: string;
  price: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ModelUpstreamView {
  id: string;
  name: string;
}

export interface ModelRouteItemView {
  id: string | null;
  upstreamId: string;
  upstreamName: string;
  priority: number;
  enabled: boolean;
  upstreamEnabled: boolean;
  upstreamStatus: string;
  isDefault: boolean;
}

export interface ModelRoutesView {
  strategy: RoutingStrategy;
  routes: ModelRouteItemView[];
}

export interface ModelView {
  id: string;
  publicName: string;
  upstreamModelName: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  availabilityStatus: ModelAvailabilityStatus;
  supportsText: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsFiles: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
  upstreamId: string;
  createdAt: string;
  updatedAt: string;
  aliases: string[];
  currentPricing: CurrentPricingView[];
  upstream: ModelUpstreamView;
  routeCount: number;
  strategy: RoutingStrategy;
}

export interface PricingRuleView {
  id: string;
  modelId: string;
  billingDimension: string;
  unitSize: string;
  price: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toModelView(
  model: Model,
  aliases: readonly string[],
  currentPricing: readonly CurrentPricingView[],
  routing: { routeCount: number; strategy: RoutingStrategy },
): ModelView {
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
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
    aliases: [...aliases].sort(compareStrings),
    currentPricing: [...currentPricing].sort(compareCurrentPricing),
    upstream: {
      id: model.upstream.id,
      name: model.upstream.name,
    },
    routeCount: routing.routeCount,
    strategy: routing.strategy,
  };
}

export function toCurrentPricing(rule: PricingRule): CurrentPricingView {
  return {
    billingDimension: rule.billingDimension,
    unitSize: rule.unitSize,
    price: rule.price,
    currency: rule.currency,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    effectiveTo: rule.effectiveTo?.toISOString() ?? null,
  };
}

export function toPricingRuleView(rule: PricingRule): PricingRuleView {
  return {
    id: rule.id,
    modelId: rule.modelId,
    billingDimension: rule.billingDimension,
    unitSize: rule.unitSize,
    price: rule.price,
    currency: rule.currency,
    effectiveFrom: rule.effectiveFrom.toISOString(),
    effectiveTo: rule.effectiveTo?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareCurrentPricing(left: CurrentPricingView, right: CurrentPricingView): number {
  const byDimension = compareStrings(left.billingDimension, right.billingDimension);
  if (byDimension !== 0) {
    return byDimension;
  }
  return compareStrings(left.effectiveFrom, right.effectiveFrom);
}
