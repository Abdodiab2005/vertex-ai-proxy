import { describe, expect, it } from "vitest";
import type { RoutingStrategy } from "@gateway/contracts";
import { planRoute, type RouteCandidate } from "./route-plan.js";

function candidate(
  upstreamId: string,
  overrides: Partial<Omit<RouteCandidate, "upstreamId">> = {},
): RouteCandidate {
  return {
    upstreamId,
    upstreamName: upstreamId,
    routePriority: 0,
    upstreamPriority: 0,
    enabled: true,
    status: "connected",
    ...overrides,
  };
}

function plan(
  strategy: RoutingStrategy,
  candidates: RouteCandidate[],
  roundRobinCounter = 0,
  defaultUpstreamId = "default",
): string[] {
  return planRoute({ strategy, candidates, roundRobinCounter, defaultUpstreamId }).order;
}

const priorityCandidates = [
  candidate("higher-route-priority", {
    upstreamName: "Delta",
    routePriority: 0,
    upstreamPriority: 9,
  }),
  candidate("name-tie-zulu", {
    upstreamName: "Zulu",
    routePriority: 1,
    upstreamPriority: 1,
  }),
  candidate("name-tie-alpha", {
    upstreamName: "Alpha",
    routePriority: 1,
    upstreamPriority: 1,
  }),
  candidate("lower-upstream-priority", {
    upstreamName: "Bravo",
    routePriority: 1,
    upstreamPriority: 2,
  }),
];

const strategyCases: Array<{
  name: string;
  strategy: RoutingStrategy;
  expected: string[];
}> = [
  {
    name: "priority orders route priority, upstream priority, and upstream name",
    strategy: "priority",
    expected: ["higher-route-priority", "name-tie-alpha", "name-tie-zulu", "lower-upstream-priority"],
  },
  {
    name: "fallback uses the same order as priority",
    strategy: "fallback",
    expected: ["higher-route-priority", "name-tie-alpha", "name-tie-zulu", "lower-upstream-priority"],
  },
  {
    name: "manual selects only the highest-priority candidate",
    strategy: "manual",
    expected: ["higher-route-priority"],
  },
];

describe("planRoute", () => {
  it.each(strategyCases)("$name", ({ strategy, expected }) => {
    expect(plan(strategy, priorityCandidates)).toEqual(expected);
  });

  it("keeps input order when all priority fields and names tie", () => {
    const candidates = [
      candidate("first", { upstreamName: "same" }),
      candidate("second", { upstreamName: "same" }),
    ];

    expect(plan("priority", candidates)).toEqual(["first", "second"]);
  });

  it("excludes disabled candidates before ordering", () => {
    expect(
      plan("priority", [
        candidate("disabled", { enabled: false, routePriority: -1 }),
        candidate("enabled", { routePriority: 10 }),
      ]),
    ).toEqual(["enabled"]);
  });

  it("selects the default upstream when it is the sole enabled candidate", () => {
    expect(
      plan("priority", [
        candidate("disabled-route", { enabled: false }),
        candidate("default", { enabled: true }),
      ]),
    ).toEqual(["default"]);
  });

  it.each([
    { name: "there are no candidates", candidates: [], defaultUpstreamId: "default" },
    {
      name: "the default candidate is disabled",
      candidates: [candidate("default", { enabled: false })],
      defaultUpstreamId: "default",
    },
    {
      name: "only a different candidate is disabled",
      candidates: [candidate("other", { enabled: false })],
      defaultUpstreamId: "default",
    },
  ])("returns no plan when $name", ({ candidates, defaultUpstreamId }) => {
    expect(plan("priority", candidates, 0, defaultUpstreamId)).toEqual([]);
  });

  it.each([
    [0, ["first", "second", "third"]],
    [1, ["second", "third", "first"]],
    [2, ["third", "first", "second"]],
    [3, ["first", "second", "third"]],
    [4, ["second", "third", "first"]],
    [-1, ["third", "first", "second"]],
  ])("round-robin counter %s rotates the priority order", (roundRobinCounter, expected) => {
    const candidates = [
      candidate("first", { routePriority: 0 }),
      candidate("second", { routePriority: 1 }),
      candidate("third", { routePriority: 2 }),
    ];

    expect(plan("round_robin", candidates, roundRobinCounter)).toEqual(expected);
  });

  it("moves authentication and permission failures behind otherwise usable candidates", () => {
    expect(
      plan("priority", [
        candidate("authentication-failed", {
          routePriority: 0,
          status: "authentication_failed",
        }),
        candidate("permission-denied", {
          routePriority: 1,
          status: "permission_denied",
        }),
        candidate("unknown-status", { routePriority: 2, status: "unknown" }),
        candidate("connected", { routePriority: 3 }),
      ]),
    ).toEqual(["unknown-status", "connected", "authentication-failed", "permission-denied"]);
  });
});
