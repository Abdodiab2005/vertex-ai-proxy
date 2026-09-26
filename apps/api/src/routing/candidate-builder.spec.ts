import { describe, expect, it } from "vitest";
import {
  buildRouteCandidates,
  type CandidateSourceRoute,
  type CandidateSourceUpstream,
} from "./candidate-builder.js";

function upstream(
  id: string,
  overrides: Partial<CandidateSourceUpstream> = {},
): CandidateSourceUpstream {
  return {
    id,
    name: id,
    priority: 0,
    enabled: true,
    status: "connected",
    ...overrides,
  };
}

function route(
  upstreamId: string,
  overrides: Partial<CandidateSourceRoute> = {},
  upstreamOverrides: Partial<CandidateSourceUpstream> = {},
): CandidateSourceRoute {
  return {
    upstreamId,
    priority: 10,
    enabled: true,
    upstream: upstream(upstreamId, upstreamOverrides),
    ...overrides,
  };
}

describe("buildRouteCandidates", () => {
  it("creates default candidate with priority 0 when no route row exists", () => {
    const defaultUp = upstream("default-up");
    const candidates = buildRouteCandidates({
      defaultUpstream: defaultUp,
      routes: [],
    });

    expect(candidates).toEqual([
      {
        upstreamId: "default-up",
        upstreamName: "default-up",
        routePriority: 0,
        upstreamPriority: 0,
        enabled: true,
        status: "connected",
      },
    ]);
  });

  it("overrides default candidate priority and enabled when route row matches default upstream", () => {
    const defaultUp = upstream("default-up");
    const overrideRoute = route("default-up", { priority: 25, enabled: true });
    const candidates = buildRouteCandidates({
      defaultUpstream: defaultUp,
      routes: [overrideRoute],
    });

    expect(candidates).toEqual([
      {
        upstreamId: "default-up",
        upstreamName: "default-up",
        routePriority: 25,
        upstreamPriority: 0,
        enabled: true,
        status: "connected",
      },
    ]);
  });

  it("marks default candidate disabled if its upstream is disabled even if route is enabled", () => {
    const defaultUp = upstream("default-up", { enabled: false });
    const overrideRoute = route("default-up", { priority: 5, enabled: true });
    const candidates = buildRouteCandidates({
      defaultUpstream: defaultUp,
      routes: [overrideRoute],
    });

    expect(candidates[0].enabled).toBe(false);
  });

  it("marks default candidate disabled if route row is disabled even if upstream is enabled", () => {
    const defaultUp = upstream("default-up", { enabled: true });
    const overrideRoute = route("default-up", { priority: 5, enabled: false });
    const candidates = buildRouteCandidates({
      defaultUpstream: defaultUp,
      routes: [overrideRoute],
    });

    expect(candidates[0].enabled).toBe(false);
  });

  it("includes additional route rows as candidates", () => {
    const defaultUp = upstream("default-up", { priority: 5 });
    const extraRoute1 = route("extra-1", { priority: 1 }, { priority: 2, status: "connected" });
    const extraRoute2 = route("extra-2", { priority: 2, enabled: false }, { priority: 1 });
    const extraRoute3 = route("extra-3", { priority: 3 }, { enabled: false });

    const candidates = buildRouteCandidates({
      defaultUpstream: defaultUp,
      routes: [extraRoute1, extraRoute2, extraRoute3],
    });

    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toEqual({
      upstreamId: "default-up",
      upstreamName: "default-up",
      routePriority: 0,
      upstreamPriority: 5,
      enabled: true,
      status: "connected",
    });
    expect(candidates[1]).toEqual({
      upstreamId: "extra-1",
      upstreamName: "extra-1",
      routePriority: 1,
      upstreamPriority: 2,
      enabled: true,
      status: "connected",
    });
    // extra-2 route is disabled
    expect(candidates[2].enabled).toBe(false);
    // extra-3 upstream is disabled
    expect(candidates[3].enabled).toBe(false);
  });
});
