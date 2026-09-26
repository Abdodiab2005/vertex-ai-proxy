import { formatMicros, toMicros } from "../credits/money.js";

export const SPEND_TRACKED_LABEL = "Gateway tracked / estimated upstream spend";

export function usableTargetFor(budget: string | null, reserve: string): string | null {
  if (budget === null) {
    return null;
  }
  return formatMicros(toMicros(budget) - toMicros(reserve));
}

export function isThresholdReached(trackedSpend: string, usableTarget: string | null): boolean {
  if (usableTarget === null) {
    return false;
  }
  return toMicros(trackedSpend) >= toMicros(usableTarget);
}
