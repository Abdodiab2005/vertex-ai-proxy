import type { ModelAvailabilityStatus } from "@gateway/contracts";
import {
  planModelSync,
  type ModelSyncPlan,
  type PlannedModelCreate,
  type SyncModelRecord,
} from "./model-sync-plan.js";

const UPSTREAM = "upstream-a";
const OTHER = "upstream-b";

const textFlags = {
  supportsText: true,
  supportsVision: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsFiles: false,
  supportsTools: false,
  supportsStreaming: true,
  supportsEmbeddings: false,
} as const;

const embeddingFlags = {
  supportsText: false,
  supportsVision: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsFiles: false,
  supportsTools: false,
  supportsStreaming: false,
  supportsEmbeddings: true,
} as const;

function textModel(id: string): PlannedModelCreate {
  return { id, ...textFlags };
}

function embeddingModel(id: string): PlannedModelCreate {
  return { id, ...embeddingFlags };
}

function model(
  overrides: Partial<SyncModelRecord> &
    Pick<SyncModelRecord, "id" | "upstreamModelName" | "publicName">,
): SyncModelRecord {
  return {
    upstreamId: UPSTREAM,
    availabilityStatus: "available",
    aliases: [],
    ...overrides,
  };
}

function plan(overrides: Partial<ModelSyncPlan> & Pick<ModelSyncPlan, "discovered">): ModelSyncPlan {
  return {
    create: [],
    markAvailable: [],
    markUnavailable: [],
    conflicts: [],
    ...overrides,
  };
}

const cases: Array<{
  name: string;
  models: SyncModelRecord[];
  discoveredIds: string[];
  expected: ModelSyncPlan;
}> = [
  {
    name: "creates text and embedding models and ignores ids that are not importable",
    models: [
      model({
        id: "manual",
        upstreamModelName: "my-custom-model",
        publicName: "my-custom-model",
      }),
    ],
    discoveredIds: [
      "imagen-3.0-generate-002",
      "publishers/google/models/gemini-2.5-flash",
      "GEMINI-2.5-flash",
      "text-embedding-004",
      "gemini-2.5-flash",
      "gemini-2.5-flash",
      "text-multilingual-embedding-002",
      "gemini-embedding-001",
    ],
    expected: plan({
      discovered: 7,
      create: [
        textModel("gemini-2.5-flash"),
        embeddingModel("gemini-embedding-001"),
        embeddingModel("text-embedding-004"),
        embeddingModel("text-multilingual-embedding-002"),
      ],
    }),
  },
  {
    name: "reactivates an unavailable model on this upstream without renaming it",
    models: [
      model({
        id: "flash",
        upstreamModelName: "gemini-2.5-flash",
        publicName: "flash-renamed",
        availabilityStatus: "unavailable",
        aliases: ["flash-latest"],
      }),
    ],
    discoveredIds: ["gemini-2.5-flash"],
    expected: plan({
      discovered: 1,
      markAvailable: [{ modelId: "flash", name: "gemini-2.5-flash" }],
    }),
  },
  {
    name: "leaves availability alone when it already matches discovery",
    models: [
      model({
        id: "kept-available",
        upstreamModelName: "gemini-2.5-flash",
        publicName: "gemini-2.5-flash",
        availabilityStatus: "available",
      }),
      model({
        id: "kept-unavailable",
        upstreamModelName: "gemini-2.5-pro",
        publicName: "gemini-2.5-pro",
        availabilityStatus: "unavailable" satisfies ModelAvailabilityStatus,
      }),
    ],
    discoveredIds: ["gemini-2.5-flash"],
    expected: plan({ discovered: 1 }),
  },
  {
    name: "marks a missing importable model unavailable and does not touch other upstreams",
    models: [
      model({
        id: "local",
        upstreamModelName: "gemini-2.5-flash",
        publicName: "custom-flash",
      }),
      model({
        id: "other",
        upstreamId: OTHER,
        upstreamModelName: "gemini-2.5-pro",
        publicName: "gemini-2.5-pro",
      }),
      model({
        id: "manual",
        upstreamModelName: "my-custom-model",
        publicName: "my-custom-model",
      }),
    ],
    discoveredIds: [],
    expected: plan({
      discovered: 0,
      markUnavailable: [{ modelId: "local", name: "gemini-2.5-flash" }],
    }),
  },
  {
    name: "skips a public name taken by another upstream's model",
    models: [
      model({
        id: "other",
        upstreamId: OTHER,
        upstreamModelName: "gemini-2.0-flash",
        publicName: "gemini-2.0-flash",
      }),
    ],
    discoveredIds: ["gemini-2.0-flash", "gemini-2.5-flash"],
    expected: plan({
      discovered: 2,
      create: [textModel("gemini-2.5-flash")],
      conflicts: ["gemini-2.0-flash"],
    }),
  },
  {
    name: "skips a public name taken by an alias and does not rename",
    models: [
      model({
        id: "other",
        upstreamId: OTHER,
        upstreamModelName: "gemini-2.5-pro",
        publicName: "gemini-2.5-pro",
        aliases: ["gemini-2.0-flash"],
      }),
    ],
    discoveredIds: ["gemini-2.0-flash"],
    expected: plan({
      discovered: 1,
      conflicts: ["gemini-2.0-flash"],
    }),
  },
  {
    name: "skips a public name taken on this upstream by a different upstream model name",
    models: [
      model({
        id: "custom",
        upstreamModelName: "gemini-custom",
        publicName: "gemini-2.5-flash",
      }),
    ],
    discoveredIds: ["gemini-2.5-flash"],
    expected: plan({
      discovered: 1,
      markUnavailable: [{ modelId: "custom", name: "gemini-custom" }],
      conflicts: ["gemini-2.5-flash"],
    }),
  },
];

describe("planModelSync", () => {
  it.each(cases)("$name", ({ models, discoveredIds, expected }) => {
    expect(planModelSync(UPSTREAM, models, discoveredIds)).toEqual(expected);
  });
});
