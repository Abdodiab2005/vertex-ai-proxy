/**
 * Pricing Engine
 *
 * Pure functions for calculating costs from pricing rules and usage quantities.
 * Uses BigInt fixed-point arithmetic exclusively — no floating point.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export class PricingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigurationError';
  }
}

export class PricingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingInputError';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface PricingRuleInput {
  id: string;
  billingDimension: string;
  unitSize: string; // positive integer string
  price: string; // decimal with up to 8 fractional digits
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export type UsageQuantities = Record<string, string | number | bigint>;

export interface CostLine {
  dimension: string;
  quantity: string; // integer string
  unitSize: string; // integer string
  price: string; // as given (validated)
  currency: string;
  ruleId: string;
  cost: string; // exactly 6 fractional digits
  /** Set when the dimension had no price of its own and was billed at this dimension's price. */
  pricedAs?: string;
}

export interface PricingSnapshot {
  version: 1;
  pricedAt: string; // ISO string
  rules: Array<{
    id: string;
    billingDimension: string;
    unitSize: string;
    price: string;
    currency: string;
    effectiveFrom: string; // ISO string
    effectiveTo: string | null; // ISO string or null
  }>;
  /**
   * Present when the quantities were estimated by the gateway because the upstream never reported
   * usage (a stream cut before its final event); the usage record's token columns stay empty.
   */
  estimate?: { basis: string; quantities: Record<string, string> };
}

export interface CostBreakdown {
  currency: string | null;
  total: string; // exactly 6 fractional digits
  lines: CostLine[];
  unpricedDimensions: string[];
  snapshot: PricingSnapshot;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
const SCALE_6 = 1000000n; // 10^6 for 6 fractional digits
const SCALE_8 = 100000000n; // 10^8 for 8 fractional digits (price precision)
const PRICE_REGEX = /^\d{1,10}(\.\d{1,8})?$/;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parses a decimal string into a BigInt scaled by the given factor.
 * Validates format: up to 10 integer digits, up to 8 fractional digits.
 */
function parseDecimal(value: string, scale: bigint, fieldName: string): bigint {
  if (!PRICE_REGEX.test(value)) {
    throw new PricingInputError(`${fieldName}: invalid decimal format "${value}"`);
  }
  const [intPart, fracPart = ''] = value.split('.');
  const fracPadded = (fracPart + '00000000').slice(0, Number(scale.toString().length) - 1);
  return BigInt(intPart) * scale + BigInt(fracPadded);
}

/**
 * Parses a positive integer string.
 */
function parsePositiveInteger(value: string, fieldName: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new PricingInputError(`${fieldName}: must be a positive integer string, got "${value}"`);
  }
  const n = BigInt(value);
  if (n <= 0n) {
    throw new PricingInputError(`${fieldName}: must be positive, got "${value}"`);
  }
  return n;
}

/**
 * Parses and validates a quantity (non-negative integer).
 * Accepts bigint, safe-integer number, or digit string.
 */
function parseQuantity(value: string | number | bigint, dimension: string): bigint {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new PricingInputError(
        `usage.${dimension}: quantity must be a non-negative safe integer, got ${value}`
      );
    }
    n = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new PricingInputError(
        `usage.${dimension}: quantity must be a non-negative integer string, got "${value}"`
      );
    }
    n = BigInt(value);
    if (n > MAX_SAFE_INTEGER) {
      throw new PricingInputError(
        `usage.${dimension}: quantity exceeds safe integer range, got "${value}"`
      );
    }
  } else {
    throw new PricingInputError(`usage.${dimension}: invalid quantity type`);
  }
  return n;
}

/**
 * Formats a BigInt scaled by 10^6 as a string with exactly 6 fractional digits
 * WITHOUT additional rounding (assumes value is already scaled to 6 digits).
 */
function formatExact6(value: bigint): string {
  const intPart = value / SCALE_6;
  const fracPart = value % SCALE_6;
  return `${intPart}.${fracPart.toString().padStart(6, '0')}`;
}

/**
 * Validates a pricing rule input.
 */
function validateRule(rule: PricingRuleInput): void {
  // price: up to 10 integer digits, up to 8 fractional digits
  if (!PRICE_REGEX.test(rule.price)) {
    throw new PricingInputError(`rule ${rule.id}: price must match /^\\d{1,10}(\\.\\d{1,8})?$/, got "${rule.price}"`);
  }
  // unitSize: positive integer string
  if (!/^\d+$/.test(rule.unitSize) || BigInt(rule.unitSize) <= 0n) {
    throw new PricingInputError(`rule ${rule.id}: unitSize must be a positive integer string, got "${rule.unitSize}"`);
  }
}

/**
 * Converts a Date to ISO string for snapshot.
 */
function dateToISO(date: Date): string {
  return date.toISOString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Selects effective rules at a given time.
 * Returns a Map from billingDimension to the single effective rule.
 * Throws PricingConfigurationError if two or more rules are effective for the same dimension.
 */
export function selectEffectiveRules(
  rules: PricingRuleInput[],
  at: Date
): Map<string, PricingRuleInput> {
  const effective = new Map<string, PricingRuleInput>();
  const time = at.getTime();

  for (const rule of rules) {
    validateRule(rule);
    const from = rule.effectiveFrom.getTime();
    const to = rule.effectiveTo?.getTime() ?? Infinity;

    if (from <= time && time < to) {
      const existing = effective.get(rule.billingDimension);
      if (existing) {
        throw new PricingConfigurationError(
          `Overlapping effective rules for dimension "${rule.billingDimension}": ${existing.id} and ${rule.id}`
        );
      }
      effective.set(rule.billingDimension, rule);
    }
  }

  return effective;
}

/**
 * Calculates cost breakdown from rules and usage at a specific time.
 */
/**
 * Token dimensions without a price of their own are billed at a base token price, the way Google
 * bills thinking as output. Without this a missing rule made the whole request free: every Gemini
 * 2.5 answer carries reasoning tokens, and a client can add audio at will. An admin who prices the
 * dimension explicitly gets that exact price instead.
 */
export const TOKEN_PRICE_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  reasoning_tokens: "output_tokens",
  audio_output_tokens: "output_tokens",
  audio_input_tokens: "input_tokens",
  cached_input_tokens: "input_tokens",
});

export function calculateCost(
  rules: PricingRuleInput[],
  usage: UsageQuantities,
  at: Date
): CostBreakdown {
  const effectiveRules = selectEffectiveRules(rules, at);
  const lines: CostLine[] = [];
  const unpricedDimensions: string[] = [];
  let currency: string | null = null;
  let totalScaled = 0n; // scaled by 10^6

  // Process dimensions in sorted order for deterministic output
  const dimensions = Object.keys(usage).sort();

  for (const dimension of dimensions) {
    const quantity = parseQuantity(usage[dimension], dimension);
    if (quantity === 0n) {
      continue; // Zero quantities produce no line
    }

    const fallbackDimension = TOKEN_PRICE_FALLBACKS[dimension];
    const ownRule = effectiveRules.get(dimension);
    const rule = ownRule ?? (fallbackDimension === undefined ? undefined : effectiveRules.get(fallbackDimension));
    if (!rule) {
      unpricedDimensions.push(dimension);
      continue;
    }
    const pricedAs = ownRule === undefined ? fallbackDimension : undefined;

    // Validate currency consistency
    if (currency === null) {
      currency = rule.currency;
    } else if (currency !== rule.currency) {
      throw new PricingConfigurationError(
        `Mixed currencies in priced lines: ${currency} and ${rule.currency}`
      );
    }

    // Calculate cost: quantity * price / unitSize
    // All in fixed-point: quantity (integer) * price (scaled 10^8) / unitSize (integer) = cost scaled 10^8
    // Then convert to 10^6 scale for storage
    const quantityBN = quantity;
    const priceScaled8 = parseDecimal(rule.price, SCALE_8, `rule ${rule.id}.price`);
    const unitSizeBN = parsePositiveInteger(rule.unitSize, `rule ${rule.id}.unitSize`);

    // cost = quantity * price / unitSize
    // We compute at higher precision (10^8) then round to 10^6
    const costScaled8 = (quantityBN * priceScaled8) / unitSizeBN;

    // Convert from 10^8 scale to 10^6 scale with rounding
    // costScaled8 is in 10^8 units, we want 10^6 units
    // So we divide by 100 and round half-up
    const costScaled6 = (costScaled8 + 50n) / 100n; // Round half-up from 10^8 to 10^6

    const costStr = formatExact6(costScaled6);
    totalScaled += costScaled6;

    lines.push({
      dimension,
      quantity: quantityBN.toString(),
      unitSize: rule.unitSize,
      price: rule.price,
      currency: rule.currency,
      ruleId: rule.id,
      cost: costStr,
      ...(pricedAs === undefined ? {} : { pricedAs }),
    });
  }

  unpricedDimensions.sort();

  const total = formatExact6(totalScaled);

  // Build snapshot with only rules used for lines, once each: a fallback line shares its base
  // dimension's rule.
  const usedRules = [...new Map(lines.map((line) => {
    const rule = effectiveRules.get(line.pricedAs ?? line.dimension)!;
    return [rule.id, rule] as const;
  })).values()];
  const snapshotRules = usedRules.map((rule) => {
    return {
      id: rule.id,
      billingDimension: rule.billingDimension,
      unitSize: rule.unitSize,
      price: rule.price,
      currency: rule.currency,
      effectiveFrom: dateToISO(rule.effectiveFrom),
      effectiveTo: rule.effectiveTo ? dateToISO(rule.effectiveTo) : null,
    };
  });

  const snapshot: PricingSnapshot = {
    version: 1,
    pricedAt: dateToISO(at),
    rules: snapshotRules,
  };

  return {
    currency,
    total,
    lines,
    unpricedDimensions,
    snapshot,
  };
}

/**
 * Recomputes cost breakdown from a stored snapshot.
 * Provides historical reproducibility.
 */
export function calculateCostFromSnapshot(
  snapshot: PricingSnapshot,
  usage: UsageQuantities
): CostBreakdown {
  if (snapshot.version !== 1) {
    throw new PricingInputError(`Unsupported snapshot version: ${snapshot.version}`);
  }

  // Reconstruct rules from snapshot
  const rules: PricingRuleInput[] = snapshot.rules.map((r) => ({
    id: r.id,
    billingDimension: r.billingDimension,
    unitSize: r.unitSize,
    price: r.price,
    currency: r.currency,
    effectiveFrom: new Date(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? new Date(r.effectiveTo) : null,
  }));

  const at = new Date(snapshot.pricedAt);
  return calculateCost(rules, usage, at);
}