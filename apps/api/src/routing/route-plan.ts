import type { RoutingStrategy } from "@gateway/contracts";

export interface RouteCandidate {
  upstreamId: string;
  upstreamName: string;
  routePriority: number;
  upstreamPriority: number;
  enabled: boolean;
  status: string;
}

export interface RoutePlanInput {
  strategy: RoutingStrategy;
  candidates: RouteCandidate[];
  defaultUpstreamId: string;
  roundRobinCounter: number;
}

export interface RoutePlan {
  order: string[];
}

export function planRoute(input: RoutePlanInput): RoutePlan {
  const enabledCandidates = input.candidates.filter((candidate) => candidate.enabled);

  if (enabledCandidates.length === 0) {
    return {
      order: hasEnabledDefaultCandidate(input.candidates, input.defaultUpstreamId)
        ? [input.defaultUpstreamId]
        : [],
    };
  }

  const ordered = priorityOrder(enabledCandidates);

  switch (input.strategy) {
    case "manual":
      return { order: [ordered[0].upstreamId] };
    case "round_robin":
      return { order: rotate(ordered, input.roundRobinCounter).map((candidate) => candidate.upstreamId) };
    case "priority":
    case "fallback":
      // Fallback shares priority order so selection stays predictable; only the
      // execution pipeline may advance after a retryable pre-response failure.
      return { order: ordered.map((candidate) => candidate.upstreamId) };
  }
}

function hasEnabledDefaultCandidate(
  candidates: readonly RouteCandidate[],
  defaultUpstreamId: string,
): boolean {
  return candidates.some(
    (candidate) => candidate.upstreamId === defaultUpstreamId && candidate.enabled,
  );
}

function priorityOrder(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const comparison = compareCandidates(left.candidate, right.candidate);
      return comparison !== 0 ? comparison : left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

function compareCandidates(left: RouteCandidate, right: RouteCandidate): number {
  const byStatus = unavailableLastRank(left.status) - unavailableLastRank(right.status);
  if (byStatus !== 0) {
    return byStatus;
  }

  const byRoutePriority = left.routePriority - right.routePriority;
  if (byRoutePriority !== 0) {
    return byRoutePriority;
  }

  const byUpstreamPriority = left.upstreamPriority - right.upstreamPriority;
  if (byUpstreamPriority !== 0) {
    return byUpstreamPriority;
  }

  return compareStrings(left.upstreamName, right.upstreamName);
}

function unavailableLastRank(status: string): number {
  // Credential and permission failures rarely heal during one request, but retaining
  // these routes preserves a last-resort option if every otherwise healthy route fails.
  return status === "authentication_failed" || status === "permission_denied" ? 1 : 0;
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

function rotate<T>(values: readonly T[], counter: number): T[] {
  const offset = ((counter % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}
