/**
 * Pricing Engine Tests
 *
 * Data-driven tests using Vitest's it.each for comprehensive coverage.
 * All assertions use exact string comparisons — no float-based oracles.
 */

import { describe, it, expect } from 'vitest';
import {
  PricingConfigurationError,
  PricingInputError,
  selectEffectiveRules,
  calculateCost,
  calculateCostFromSnapshot,
  type PricingRuleInput,
  type UsageQuantities,
} from './pricing-engine.js';

// ──────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ──────────────────────────────────────────────────────────────────────────────

function rule(overrides: Partial<PricingRuleInput> = {}): PricingRuleInput {
  return {
    id: 'r1',
    billingDimension: 'tokens',
    unitSize: '1000000',
    price: '0.30',
    currency: 'USD',
    effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
    effectiveTo: null,
    ...overrides,
  };
}

function usage(quantities: UsageQuantities): UsageQuantities {
  return quantities;
}

// ──────────────────────────────────────────────────────────────────────────────
// selectEffectiveRules
// ──────────────────────────────────────────────────────────────────────────────

describe('selectEffectiveRules', () => {
  it('returns empty map when no rules match', () => {
    const rules = [rule({ effectiveFrom: new Date('2025-01-01T00:00:00.000Z') })];
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = selectEffectiveRules(rules, at);
    expect(result.size).toBe(0);
  });

  it('includes rule when at === effectiveFrom', () => {
    const rules = [rule({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') })];
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = selectEffectiveRules(rules, at);
    expect(result.size).toBe(1);
    expect(result.get('tokens')?.id).toBe('r1');
  });

  it('excludes rule when at === effectiveTo', () => {
    const rules = [rule({ effectiveTo: new Date('2024-01-01T00:00:00.000Z') })];
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = selectEffectiveRules(rules, at);
    expect(result.size).toBe(0);
  });

  it('picks correct rule when rule replaced mid-way', () => {
    const rules = [
      rule({ id: 'old', effectiveTo: new Date('2024-06-01T00:00:00.000Z') }),
      rule({ id: 'new', effectiveFrom: new Date('2024-06-01T00:00:00.000Z') }),
    ];
    const before = new Date('2024-05-31T23:59:59.999Z');
    const after = new Date('2024-06-01T00:00:00.000Z');

    expect(selectEffectiveRules(rules, before).get('tokens')?.id).toBe('old');
    expect(selectEffectiveRules(rules, after).get('tokens')?.id).toBe('new');
  });

  it('throws PricingConfigurationError on overlapping rules for same dimension', () => {
    const rules = [
      rule({ id: 'r1', effectiveFrom: new Date('2024-01-01T00:00:00.000Z'), effectiveTo: new Date('2025-01-01T00:00:00.000Z') }),
      rule({ id: 'r2', effectiveFrom: new Date('2024-06-01T00:00:00.000Z'), effectiveTo: null }),
    ];
    const at = new Date('2024-07-01T00:00:00.000Z');
    expect(() => selectEffectiveRules(rules, at)).toThrow(PricingConfigurationError);
    expect(() => selectEffectiveRules(rules, at)).toThrow('Overlapping effective rules for dimension "tokens"');
  });

  it('allows multiple rules for different dimensions', () => {
    const rules = [
      rule({ id: 'r1', billingDimension: 'input_tokens' }),
      rule({ id: 'r2', billingDimension: 'output_tokens' }),
    ];
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = selectEffectiveRules(rules, at);
    expect(result.size).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// calculateCost - Basic per-million pricing
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - per-million pricing', () => {
  it('1,234,567 input @ 0.30/M + 89,000 output @ 2.50/M', () => {
    // Manual verification:
    // input: 1_234_567 * 0.30 / 1_000_000 = 0.3703701 -> rounded to 6dp = 0.370370
    // output: 89_000 * 2.50 / 1_000_000 = 0.2225 -> rounded to 6dp = 0.222500
    // total: 0.370370 + 0.222500 = 0.592870
    const rules = [
      rule({ id: 'r-in', billingDimension: 'input_tokens', price: '0.30', unitSize: '1000000' }),
      rule({ id: 'r-out', billingDimension: 'output_tokens', price: '2.50', unitSize: '1000000' }),
    ];
    const u = usage({ input_tokens: '1234567', output_tokens: '89000' });
    const at = new Date('2024-01-01T00:00:00.000Z');

    const result = calculateCost(rules, u, at);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      dimension: 'input_tokens',
      quantity: '1234567',
      unitSize: '1000000',
      price: '0.30',
      currency: 'USD',
      ruleId: 'r-in',
      cost: '0.370370',
    });
    expect(result.lines[1]).toMatchObject({
      dimension: 'output_tokens',
      quantity: '89000',
      unitSize: '1000000',
      price: '2.50',
      currency: 'USD',
      ruleId: 'r-out',
      cost: '0.222500',
    });
    expect(result.total).toBe('0.592870');
    expect(result.currency).toBe('USD');
    expect(result.unpricedDimensions).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rounding half-up at 7th digit boundary
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - rounding half-up', () => {
  // Test case: quantity=1, unitSize=3, price=1.00
  // cost = 1 * 1.00 / 3 = 0.333333333... (10^8 scale)
  // At 10^6 scale: 333333.33... -> rounds to 333333 (0.333333)

  it('rounds down when 7th digit < 5', () => {
    // 1/3 = 0.33333333... 7th digit is 3, rounds down
    const rules = [rule({ id: 'r1', price: '1.00', unitSize: '3' })];
    const u = usage({ tokens: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('0.333333');
  });

  it('rounds up at exact .5 boundary (7th digit = 5)', () => {
    // We need a case where the 7th digit is exactly 5
    // cost = quantity * price / unitSize
    // Let's use: quantity=1, price=0.12345675, unitSize=1
    // cost = 0.12345675 -> at 6dp: 0.123457 (7th digit 5, rounds up)
    const rules = [rule({ id: 'r1', price: '0.12345675', unitSize: '1' })];
    const u = usage({ tokens: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('0.123457');
  });

  it('rounds up when 7th digit > 5', () => {
    // price=0.12345676, 7th digit=7, rounds up
    const rules = [rule({ id: 'r1', price: '0.12345676', unitSize: '1' })];
    const u = usage({ tokens: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('0.123457');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Huge values - no precision loss
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - huge values', () => {
  it('10^15 quantity at price 123.45678901 per unit -> 123456789010000000.000000', () => {
    // 1_000_000_000_000_000 * 123.45678901 / 1
    // = 123_456_789_010_000_000.000000
    const rules = [rule({ id: 'r1', price: '123.45678901', unitSize: '1' })];
    const u = usage({ tokens: '1000000000000000' }); // 10^15 as string
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('123456789010000000.000000');
    expect(result.total).toBe('123456789010000000.000000');
  });

  it('large quantity with per-million pricing', () => {
    // 10^12 tokens at $0.30 per 1M = 300,000.00
    const rules = [rule({ id: 'r1', price: '0.30', unitSize: '1000000' })];
    const u = usage({ tokens: '1000000000000' }); // 10^12
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('300000.000000');
    expect(result.total).toBe('300000.000000');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Effective dating
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - effective dating', () => {
  it('at === effectiveFrom includes rule', () => {
    const rules = [rule({ billingDimension: 'tokens', effectiveFrom: new Date('2024-06-15T00:00:00.000Z') })];
    const at = new Date('2024-06-15T00:00:00.000Z');
    const u = usage({ tokens: '1000000' });
    const result = calculateCost(rules, u, at);
    expect(result.lines).toHaveLength(1);
  });

  it('at === effectiveTo excludes rule', () => {
    const rules = [rule({ billingDimension: 'tokens', effectiveTo: new Date('2024-06-15T00:00:00.000Z') })];
    const at = new Date('2024-06-15T00:00:00.000Z');
    const u = usage({ tokens: '1000000' });
    const result = calculateCost(rules, u, at);
    expect(result.lines).toHaveLength(0);
    expect(result.unpricedDimensions).toEqual(['tokens']);
  });

  it('rule replaced mid-way picks right one on each side', () => {
    const rules = [
      rule({ id: 'old', billingDimension: 'tokens', price: '1.00', effectiveTo: new Date('2024-07-01T00:00:00.000Z') }),
      rule({ id: 'new', billingDimension: 'tokens', price: '2.00', effectiveFrom: new Date('2024-07-01T00:00:00.000Z') }),
    ];
    const u = usage({ tokens: '1000000' });

    const before = calculateCost(rules, u, new Date('2024-06-30T23:59:59.999Z'));
    expect(before.lines[0].cost).toBe('1.000000');
    expect(before.lines[0].ruleId).toBe('old');

    const after = calculateCost(rules, u, new Date('2024-07-01T00:00:00.000Z'));
    expect(after.lines[0].cost).toBe('2.000000');
    expect(after.lines[0].ruleId).toBe('new');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Overlapping rules
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - overlapping rules', () => {
  it('throws PricingConfigurationError for overlapping rules on same dimension', () => {
    const rules = [
      rule({ id: 'r1', billingDimension: 'tokens', effectiveFrom: new Date('2024-01-01T00:00:00.000Z'), effectiveTo: new Date('2025-01-01T00:00:00.000Z') }),
      rule({ id: 'r2', billingDimension: 'tokens', effectiveFrom: new Date('2024-06-01T00:00:00.000Z'), effectiveTo: null }),
    ];
    const u = usage({ tokens: '1000000' });
    const at = new Date('2024-07-01T00:00:00.000Z');
    expect(() => calculateCost(rules, u, at)).toThrow(PricingConfigurationError);
    expect(() => calculateCost(rules, u, at)).toThrow('Overlapping effective rules for dimension "tokens"');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Mixed currencies
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - mixed currencies', () => {
  it('throws PricingConfigurationError when priced lines have different currencies', () => {
    const rules = [
      rule({ id: 'r1', billingDimension: 'input_tokens', currency: 'USD' }),
      rule({ id: 'r2', billingDimension: 'output_tokens', currency: 'EUR' }),
    ];
    const u = usage({ input_tokens: '1000000', output_tokens: '1000000' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    expect(() => calculateCost(rules, u, at)).toThrow(PricingConfigurationError);
    expect(() => calculateCost(rules, u, at)).toThrow('Mixed currencies in priced lines: USD and EUR');
  });

  it('allows same currency across dimensions', () => {
    const rules = [
      rule({ id: 'r1', billingDimension: 'input_tokens', currency: 'USD' }),
      rule({ id: 'r2', billingDimension: 'output_tokens', currency: 'USD' }),
    ];
    const u = usage({ input_tokens: '1000000', output_tokens: '1000000' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.currency).toBe('USD');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unpriced dimensions and zero quantities
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - unpriced and zero quantities', () => {
  it('unpriced dimensions are listed and do not affect total', () => {
    const rules = [rule({ id: 'r1', billingDimension: 'input_tokens' })];
    const u = usage({ input_tokens: '1000000', output_tokens: '1000000', image_units: '3' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].dimension).toBe('input_tokens');
    expect(result.unpricedDimensions).toEqual(['image_units', 'output_tokens']);
    expect(result.total).toBe('0.300000'); // only input_tokens priced
  });

  it.each([
    ['reasoning_tokens', 'output_tokens'],
    ['audio_output_tokens', 'output_tokens'],
    ['audio_input_tokens', 'input_tokens'],
    ['cached_input_tokens', 'input_tokens'],
  ])('bills %s without a rule at the %s price', (dimension, base) => {
    const rules = [
      rule({ id: 'in', billingDimension: 'input_tokens', price: '0.30' }),
      rule({ id: 'out', billingDimension: 'output_tokens', price: '2.50' }),
    ];
    const result = calculateCost(rules, usage({ [dimension]: '1000000' }), new Date('2024-01-01T00:00:00.000Z'));

    expect(result.unpricedDimensions).toEqual([]);
    expect(result.lines).toEqual([
      expect.objectContaining({ dimension, pricedAs: base, ruleId: base === 'input_tokens' ? 'in' : 'out' }),
    ]);
    expect(result.total).toBe(base === 'input_tokens' ? '0.300000' : '2.500000');
  });

  it('prefers a dimension\'s own price over the fallback', () => {
    const rules = [
      rule({ id: 'out', billingDimension: 'output_tokens', price: '2.50' }),
      rule({ id: 'think', billingDimension: 'reasoning_tokens', price: '3.50' }),
    ];
    const result = calculateCost(rules, usage({ reasoning_tokens: '1000000' }), new Date('2024-01-01T00:00:00.000Z'));

    expect(result.lines).toEqual([expect.objectContaining({ ruleId: 'think' })]);
    expect(result.lines[0].pricedAs).toBeUndefined();
    expect(result.total).toBe('3.500000');
  });

  it('zero quantities produce no line', () => {
    const rules = [rule({ id: 'r1', billingDimension: 'input_tokens' })];
    const u = usage({ input_tokens: '0', output_tokens: '1000000' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);

    expect(result.lines).toHaveLength(0);
    expect(result.unpricedDimensions).toEqual(['output_tokens']);
    expect(result.total).toBe('0.000000');
    expect(result.currency).toBeNull();
  });

  it('currency is null when no lines are priced', () => {
    const rules = [rule({ id: 'r1', billingDimension: 'input_tokens' })];
    const u = usage({ output_tokens: '1000000' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.currency).toBeNull();
    expect(result.total).toBe('0.000000');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot round-trip
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCostFromSnapshot - round trip', () => {
  it('deep-equals calculateCost for same usage even after live rules change', () => {
    const originalRules = [
      rule({ id: 'r1', billingDimension: 'input_tokens', price: '0.30' }),
      rule({ id: 'r2', billingDimension: 'output_tokens', price: '2.50' }),
    ];
    const u = usage({ input_tokens: '1234567', output_tokens: '89000' });
    const at = new Date('2024-01-01T00:00:00.000Z');

    const original = calculateCost(originalRules, u, at);
    const snapshot = original.snapshot;

    // Simulate live rules changing (price increase)
    const newRules = [
      rule({ id: 'r1', billingDimension: 'input_tokens', price: '0.50' }),
      rule({ id: 'r2', billingDimension: 'output_tokens', price: '3.00' }),
    ];

    const fromSnapshot = calculateCostFromSnapshot(snapshot, u);

    // Should match original exactly, ignoring newRules
    expect(fromSnapshot).toEqual(original);
    // Verify it differs from what newRules would produce
    const withNewRules = calculateCost(newRules, u, at);
    expect(withNewRules.total).not.toBe(original.total);
  });

  it('snapshot contains only rules used for lines', () => {
    const rules = [
      rule({ id: 'r1', billingDimension: 'input_tokens' }),
      rule({ id: 'r2', billingDimension: 'output_tokens' }),
      rule({ id: 'r3', billingDimension: 'cached_input_tokens' }),
    ];
    const u = usage({ input_tokens: '1000000', output_tokens: '1000000' }); // no cached
    const at = new Date('2024-01-01T00:00:00.000Z');

    const result = calculateCost(rules, u, at);
    expect(result.snapshot.rules).toHaveLength(2);
    const dims = result.snapshot.rules.map((r) => r.billingDimension).sort();
    expect(dims).toEqual(['input_tokens', 'output_tokens']);
  });

  it('throws on unsupported snapshot version', () => {
    const snapshot = {
      version: 2,
      pricedAt: '2024-01-01T00:00:00.000Z',
      rules: [],
    } as const;
    expect(() => calculateCostFromSnapshot(snapshot as never, {})).toThrow(PricingInputError);
    expect(() => calculateCostFromSnapshot(snapshot as never, {})).toThrow('Unsupported snapshot version');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Input validation - PricingInputError
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - input validation', () => {
  const rules = [rule({ id: 'r1' })];
  const at = new Date('2024-01-01T00:00:00.000Z');

  describe('invalid price', () => {
    const invalidPrices = [
      ['1.123456789', 'too many fractional digits (9)'],
      ['-1', 'negative'],
      ['abc', 'non-numeric'],
      ['1.', 'trailing dot'],
      ['.5', 'leading dot'],
      ['10000000000', 'too many integer digits (11)'],
    ] as const;

    it.each(invalidPrices)('rejects price "%s" (%s)', (price, _desc) => {
      const badRules = [rule({ id: 'r1', price })];
      expect(() => calculateCost(badRules, usage({ tokens: '1' }), at)).toThrow(PricingInputError);
      expect(() => calculateCost(badRules, usage({ tokens: '1' }), at)).toThrow(`rule r1: price`);
    });
  });

  describe('invalid unitSize', () => {
    const invalidUnitSizes = [
      ['0', 'zero'],
      ['1.5', 'fractional'],
      ['-1', 'negative'],
      ['abc', 'non-numeric'],
      ['', 'empty'],
    ] as const;

    it.each(invalidUnitSizes)('rejects unitSize "%s" (%s)', (unitSize, _desc) => {
      const badRules = [rule({ id: 'r1', unitSize })];
      expect(() => calculateCost(badRules, usage({ tokens: '1' }), at)).toThrow(PricingInputError);
      expect(() => calculateCost(badRules, usage({ tokens: '1' }), at)).toThrow(`rule r1: unitSize`);
    });
  });

  describe('invalid quantity', () => {
    const invalidQuantities = [
      [-1, 'negative number'],
      [1.5, 'fractional number'],
      [Number.MAX_SAFE_INTEGER + 1, 'unsafe number (> 2^53-1)'],
      [Number.MAX_SAFE_INTEGER + 2, 'unsafe number 2'],
      [NaN, 'NaN'],
      ['-1', 'negative string'],
      ['1.5', 'fractional string'],
      ['12a', 'non-digit string'],
      ['', 'empty string'],
    ] as const;

    it.each(invalidQuantities)('rejects quantity %j (%s)', (qty, _desc) => {
      expect(() => calculateCost(rules, usage({ tokens: qty }), at)).toThrow(PricingInputError);
      expect(() => calculateCost(rules, usage({ tokens: qty }), at)).toThrow(`usage.tokens: quantity`);
    });
  });

  it('accepts valid quantities: bigint, safe integer, digit string', () => {
    // Note: quantity 0 produces no line (per spec), so we test only positive quantities here
    const validQuantities = [
      [1n, '1'],
      [BigInt(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
      [1, '1'],
      [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
      ['1', '1'],
      [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
    ] as const;

    for (const [qty, expectedStr] of validQuantities) {
      const result = calculateCost(rules, usage({ tokens: qty }), at);
      expect(result.lines[0]?.quantity).toBe(expectedStr);
    }
  });

  it('valid price formats accepted', () => {
    const validPrices = ['0', '1', '0.1', '0.01', '0.00000001', '1234567890.12345678', '1000000000'];
    for (const price of validPrices) {
      const r = [rule({ id: 'r1', price })];
      const result = calculateCost(r, usage({ tokens: '1' }), at);
      expect(result.lines[0].price).toBe(price);
    }
  });

  it('valid unitSize formats accepted', () => {
    const validUnitSizes = ['1', '1000000', '12345678901234567890'];
    for (const unitSize of validUnitSizes) {
      const r = [rule({ id: 'r1', unitSize })];
      const result = calculateCost(r, usage({ tokens: '1' }), at);
      expect(result.lines[0].unitSize).toBe(unitSize);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Output normalization
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - output normalization', () => {
  it('quantity and unitSize as plain integer strings (no decimal point)', () => {
    const rules = [rule({ id: 'r1', unitSize: '1000000' })];
    const u = usage({ tokens: '1234567' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].quantity).toBe('1234567');
    expect(result.lines[0].unitSize).toBe('1000000');
    expect(result.lines[0].quantity).not.toContain('.');
    expect(result.lines[0].unitSize).not.toContain('.');
  });

  it('price preserved as given (validated)', () => {
    const rules = [rule({ id: 'r1', price: '0.30000000' })];
    const u = usage({ tokens: '1000000' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].price).toBe('0.30000000');
  });

  it('cost and total always have exactly 6 fractional digits', () => {
    const rules = [rule({ id: 'r1', price: '1.00', unitSize: '1' })];
    const u = usage({ tokens: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toMatch(/^\d+\.\d{6}$/);
    expect(result.total).toMatch(/^\d+\.\d{6}$/);
  });

  it('lines ordered by dimension name', () => {
    const rules = [
      rule({ id: 'r3', billingDimension: 'zebra' }),
      rule({ id: 'r1', billingDimension: 'alpha' }),
      rule({ id: 'r2', billingDimension: 'beta' }),
    ];
    const u = usage({ zebra: '1', alpha: '1', beta: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines.map((l) => l.dimension)).toEqual(['alpha', 'beta', 'zebra']);
  });

  it('unpricedDimensions sorted', () => {
    const rules = [rule({ id: 'r1', billingDimension: 'alpha' })];
    const u = usage({ zebra: '1', beta: '1', alpha: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.unpricedDimensions).toEqual(['beta', 'zebra']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('calculateCost - edge cases', () => {
  it('empty usage -> empty lines, zero total, null currency', () => {
    const rules = [rule({ id: 'r1' })];
    const u = usage({});
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines).toEqual([]);
    expect(result.total).toBe('0.000000');
    expect(result.currency).toBeNull();
    expect(result.unpricedDimensions).toEqual([]);
  });

  it('usage with only zero quantities -> empty lines, zero total, null currency', () => {
    const rules = [rule({ id: 'r1', billingDimension: 'input_tokens' })];
    const u = usage({ input_tokens: '0', output_tokens: '0' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines).toEqual([]);
    expect(result.total).toBe('0.000000');
    expect(result.currency).toBeNull();
    expect(result.unpricedDimensions).toEqual([]);
  });

  it('price with 8 fractional digits works correctly', () => {
    // price = 0.12345678, unitSize = 1, quantity = 1
    // cost = 0.12345678 -> rounded to 6dp = 0.123457
    const rules = [rule({ id: 'r1', price: '0.12345678', unitSize: '1' })];
    const u = usage({ tokens: '1' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('0.123457');
  });

  it('price with no fractional digits works', () => {
    const rules = [rule({ id: 'r1', price: '5', unitSize: '1' })];
    const u = usage({ tokens: '3' });
    const at = new Date('2024-01-01T00:00:00.000Z');
    const result = calculateCost(rules, u, at);
    expect(result.lines[0].cost).toBe('15.000000');
  });
});