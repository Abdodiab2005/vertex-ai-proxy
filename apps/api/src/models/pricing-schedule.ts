// numeric(18, 8) stores 10 digits before the decimal and 8 after. Anything wider
// is rounded or rejected by Postgres, so the submitted price would not round-trip.
export const PRICE_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;

const SIGNED_BIGINT_MAX = "9223372036854775807";

// Clock skew between the admin client and this API. A larger backdate would
// rewrite an interval that historical cost calculations already depend on.
export const PRICING_PAST_TOLERANCE_MS = 60_000;

export interface DatedInterval {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface PricingInsertionPlan {
  closeIds: string[];
  overlaps: boolean;
}

export function isPriceString(value: string): boolean {
  return PRICE_PATTERN.test(value);
}

export function isPositiveBigintString(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) {
    return false;
  }
  if (value.length !== SIGNED_BIGINT_MAX.length) {
    return value.length < SIGNED_BIGINT_MAX.length;
  }
  return value <= SIGNED_BIGINT_MAX;
}

export function effectiveFromIsTooFarInPast(effectiveFrom: Date, now: Date): boolean {
  return now.getTime() - effectiveFrom.getTime() > PRICING_PAST_TOLERANCE_MS;
}

export function pricingRuleHasTakenEffect(effectiveFrom: Date, now: Date): boolean {
  return effectiveFrom.getTime() <= now.getTime();
}

// effectiveTo is exclusive: a rule covers [effectiveFrom, effectiveTo).
// An empty [t, t) covers no instant, including t, so it overlaps nothing.
export function intervalsOverlap(left: DatedInterval, right: DatedInterval): boolean {
  if (isEmptyInterval(left) || isEmptyInterval(right)) {
    return false;
  }
  return (
    startsBeforeEnd(left.effectiveFrom, right.effectiveTo) &&
    startsBeforeEnd(right.effectiveFrom, left.effectiveTo)
  );
}

export function planPricingInsertion(
  existing: readonly DatedInterval[],
  effectiveFrom: Date,
): PricingInsertionPlan {
  const closeIds = existing
    .filter(
      (rule) =>
        rule.effectiveTo === null && rule.effectiveFrom.getTime() <= effectiveFrom.getTime(),
    )
    .map((rule) => rule.id);
  const closing = new Set(closeIds);
  const candidate: DatedInterval = {
    id: "",
    effectiveFrom,
    effectiveTo: null,
  };

  const overlaps = existing.some((rule) => {
    const adjusted = closing.has(rule.id) ? { ...rule, effectiveTo: effectiveFrom } : rule;
    return intervalsOverlap(adjusted, candidate);
  });

  return { closeIds, overlaps };
}

function isEmptyInterval(interval: DatedInterval): boolean {
  return (
    interval.effectiveTo !== null &&
    interval.effectiveFrom.getTime() >= interval.effectiveTo.getTime()
  );
}

function startsBeforeEnd(start: Date, end: Date | null): boolean {
  return end === null || start.getTime() < end.getTime();
}
