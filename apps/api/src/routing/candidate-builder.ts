import type { RouteCandidate } from "./route-plan.js";

export interface CandidateSourceUpstream {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  status: string;
}

export interface CandidateSourceRoute {
  upstreamId: string;
  priority: number;
  enabled: boolean;
  upstream: CandidateSourceUpstream;
}

export interface BuildCandidatesInput {
  defaultUpstream: CandidateSourceUpstream;
  routes: readonly CandidateSourceRoute[];
}

/**
 * The model's own upstream is the implicit default candidate with routePriority 0,
 * unless overridden by an explicit route row for that same upstream. Additional
 * routes are included, and each candidate is enabled only if its upstream is enabled.
 */
export function buildRouteCandidates(input: BuildCandidatesInput): RouteCandidate[] {
  const { defaultUpstream, routes } = input;
  const defaultOverride = routes.find((r) => r.upstreamId === defaultUpstream.id);

  const defaultCandidate: RouteCandidate = {
    upstreamId: defaultUpstream.id,
    upstreamName: defaultUpstream.name,
    routePriority: defaultOverride !== undefined ? defaultOverride.priority : 0,
    upstreamPriority: defaultUpstream.priority,
    enabled:
      defaultOverride !== undefined
        ? defaultOverride.enabled && defaultUpstream.enabled
        : defaultUpstream.enabled,
    status: defaultUpstream.status,
  };

  const additionalCandidates: RouteCandidate[] = routes
    .filter((r) => r.upstreamId !== defaultUpstream.id)
    .map((r) => ({
      upstreamId: r.upstreamId,
      upstreamName: r.upstream.name,
      routePriority: r.priority,
      upstreamPriority: r.upstream.priority,
      enabled: r.enabled && r.upstream.enabled,
      status: r.upstream.status,
    }));

  return [defaultCandidate, ...additionalCandidates];
}
