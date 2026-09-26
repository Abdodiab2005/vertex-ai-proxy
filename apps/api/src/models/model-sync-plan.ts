import type { ModelAvailabilityStatus } from "@gateway/contracts";

// Vertex's publisher catalog also lists Imagen, Veo, and other families.
// Only Gemini and text-embedding ids are merged; an admin can still register
// any other model by hand.
const IMPORTABLE_UPSTREAM_MODEL_ID =
  /^(gemini-|text-embedding-|text-multilingual-embedding-)/;

export interface SyncModelRecord {
  id: string;
  upstreamId: string;
  upstreamModelName: string;
  publicName: string;
  availabilityStatus: ModelAvailabilityStatus;
  aliases: readonly string[];
}

export interface PlannedModelCreate {
  id: string;
  supportsText: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsFiles: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
}

export interface PlannedAvailabilityChange {
  modelId: string;
  name: string;
}

export interface ModelSyncPlan {
  discovered: number;
  create: PlannedModelCreate[];
  markAvailable: PlannedAvailabilityChange[];
  markUnavailable: PlannedAvailabilityChange[];
  conflicts: string[];
}

export interface ModelSyncSummary {
  discovered: number;
  created: string[];
  markedAvailable: string[];
  markedUnavailable: string[];
  conflicts: string[];
}

export function planModelSync(
  upstreamId: string,
  models: readonly SyncModelRecord[],
  discoveredIds: readonly string[],
): ModelSyncPlan {
  const distinct = distinctIds(discoveredIds);
  const importable = distinct.filter(isImportableUpstreamModelId).sort(compareStrings);
  const importableSet = new Set(importable);

  const takenNames = new Set<string>();
  for (const model of models) {
    takenNames.add(model.publicName);
    for (const alias of model.aliases) {
      takenNames.add(alias);
    }
  }

  // Flip availability only when discovery disagrees. A no-op update would still
  // race an admin edit of the same row.
  const matchedNames = new Set<string>();
  const markAvailable: PlannedAvailabilityChange[] = [];
  const markUnavailable: PlannedAvailabilityChange[] = [];
  for (const model of models) {
    if (model.upstreamId !== upstreamId || !isImportableUpstreamModelId(model.upstreamModelName)) {
      continue;
    }
    if (importableSet.has(model.upstreamModelName)) {
      matchedNames.add(model.upstreamModelName);
      if (model.availabilityStatus === "unavailable") {
        markAvailable.push({ modelId: model.id, name: model.upstreamModelName });
      }
      continue;
    }
    if (model.availabilityStatus === "available") {
      markUnavailable.push({ modelId: model.id, name: model.upstreamModelName });
    }
  }

  const create: PlannedModelCreate[] = [];
  const conflicts: string[] = [];
  for (const id of importable) {
    if (matchedNames.has(id)) {
      continue;
    }
    if (takenNames.has(id)) {
      conflicts.push(id);
      continue;
    }
    create.push({ id, ...capabilitiesFor(id) });
    takenNames.add(id);
  }

  markAvailable.sort(compareChanges);
  markUnavailable.sort(compareChanges);
  conflicts.sort(compareStrings);

  return {
    discovered: distinct.length,
    create,
    markAvailable,
    markUnavailable,
    conflicts,
  };
}

export function modelSyncSummary(plan: ModelSyncPlan): ModelSyncSummary {
  return {
    discovered: plan.discovered,
    created: plan.create.map((item) => item.id),
    markedAvailable: plan.markAvailable.map((item) => item.name),
    markedUnavailable: plan.markUnavailable.map((item) => item.name),
    conflicts: [...plan.conflicts],
  };
}

function isImportableUpstreamModelId(id: string): boolean {
  return IMPORTABLE_UPSTREAM_MODEL_ID.test(id);
}

function capabilitiesFor(id: string): Omit<PlannedModelCreate, "id"> {
  const embedding = id.includes("embedding");
  return {
    supportsText: !embedding,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsFiles: false,
    supportsTools: false,
    supportsStreaming: !embedding,
    supportsEmbeddings: embedding,
  };
}

function distinctIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    distinct.push(id);
  }
  return distinct;
}

function compareChanges(left: PlannedAvailabilityChange, right: PlannedAvailabilityChange): number {
  const byName = compareStrings(left.name, right.name);
  if (byName !== 0) {
    return byName;
  }
  return compareStrings(left.modelId, right.modelId);
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
