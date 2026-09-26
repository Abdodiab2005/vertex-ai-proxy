import {
  effectiveFromIsTooFarInPast,
  intervalsOverlap,
  isPositiveBigintString,
  isPriceString,
  planPricingInsertion,
  pricingRuleHasTakenEffect,
  type DatedInterval,
} from "./pricing-schedule.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(t0.getTime() + offsetMs);
}

function interval(id: string, from: number, to: number | null): DatedInterval {
  return {
    id,
    effectiveFrom: at(from),
    effectiveTo: to === null ? null : at(to),
  };
}

describe("pricing intervals", () => {
  it("treats effectiveTo as exclusive, including an empty [t, t)", () => {
    const point = at(0);
    const empty = { id: "empty", effectiveFrom: point, effectiveTo: point };
    const covering = interval("covering", -1_000, 1_000);
    const openAtPoint = interval("open", 0, null);
    const adjacent = interval("adjacent", 0, 100);

    expect(intervalsOverlap(empty, covering)).toBe(false);
    expect(intervalsOverlap(covering, empty)).toBe(false);
    expect(intervalsOverlap(empty, openAtPoint)).toBe(false);
    expect(intervalsOverlap(interval("left", 0, 100), interval("right", 100, null))).toBe(false);
    expect(intervalsOverlap(interval("left", 0, 100), interval("overlap", 99, 200))).toBe(true);
    expect(intervalsOverlap(adjacent, interval("inside", 0, 50))).toBe(true);
  });

  it.each([
    {
      name: "no history",
      existing: [],
      at: 0,
      closeIds: [],
      overlaps: false,
    },
    {
      name: "closes an open rule that started earlier and does not overlap it",
      existing: [interval("open", -1_000, null)],
      at: 0,
      closeIds: ["open"],
      overlaps: false,
    },
    {
      name: "closes an open rule that starts at the same instant into an empty interval",
      existing: [interval("open", 0, null)],
      at: 0,
      closeIds: ["open"],
      overlaps: false,
    },
    {
      name: "an open rule that starts later overlaps an open-ended insert",
      existing: [interval("future", 1_000, null)],
      at: 0,
      closeIds: [],
      overlaps: true,
    },
    {
      name: "a closed rule ending at the insert instant does not overlap",
      existing: [interval("closed", -1_000, 0)],
      at: 0,
      closeIds: [],
      overlaps: false,
    },
    {
      name: "a closed rule ending one millisecond later overlaps",
      existing: [interval("closed", -1_000, 1)],
      at: 0,
      closeIds: [],
      overlaps: true,
    },
    {
      name: "a closed rule that starts at the insert instant overlaps",
      existing: [interval("closed", 0, 1_000)],
      at: 0,
      closeIds: [],
      overlaps: true,
    },
    {
      name: "a closed rule entirely before the insert does not overlap",
      existing: [interval("closed", -2_000, -1_000)],
      at: 0,
      closeIds: [],
      overlaps: false,
    },
    {
      name: "a later closed rule overlaps because the new rule is open-ended",
      existing: [interval("later", 500, 1_500)],
      at: 0,
      closeIds: [],
      overlaps: true,
    },
    {
      name: "closes the open rule and keeps an earlier adjacent closed rule",
      existing: [interval("closed", -2_000, -1_000), interval("open", -1_000, null)],
      at: 0,
      closeIds: ["open"],
      overlaps: false,
    },
    {
      name: "does not close a future open rule, which the new rule would cover",
      existing: [interval("closed", -1_000, 0), interval("open", 1_000, null)],
      at: 0,
      closeIds: [],
      overlaps: true,
    },
    {
      name: "closes every open rule that has already started",
      existing: [interval("older", -2_000, null), interval("newer", -500, null)],
      at: 0,
      closeIds: ["older", "newer"],
      overlaps: false,
    },
    {
      name: "adjacent closed and open rules accept an insert on the boundary",
      existing: [interval("closed", 0, 100), interval("open", 100, null)],
      at: 100,
      closeIds: ["open"],
      overlaps: false,
    },
    {
      name: "one millisecond before that boundary overlaps the closed rule",
      existing: [interval("closed", 0, 100), interval("open", 100, null)],
      at: 99,
      closeIds: [],
      overlaps: true,
    },
  ])("$name", ({ existing, at: offset, closeIds, overlaps }) => {
    expect(planPricingInsertion(existing, at(offset))).toEqual({ closeIds, overlaps });
  });
});

describe("pricing effective dates", () => {
  const now = new Date("2026-09-25T00:00:00.000Z");

  it.each([
    [0, false],
    [60_000, false],
    [60_001, true],
    [-1_000, false],
  ])("effectiveFrom %d ms before now is too far in the past: %s", (ageMs, tooFar) => {
    expect(effectiveFromIsTooFarInPast(new Date(now.getTime() - ageMs), now)).toBe(tooFar);
  });

  it.each([
    [0, true],
    [-1, true],
    [1, false],
  ])("effectiveFrom %d ms from now has taken effect: %s", (offsetMs, takenEffect) => {
    expect(pricingRuleHasTakenEffect(new Date(now.getTime() + offsetMs), now)).toBe(takenEffect);
  });
});

describe("pricing value strings", () => {
  it.each(["0", "0.1", "1", "1.25", "1.12345678", "9999999999.99999999"])(
    "accepts price %j",
    (price) => {
      expect(isPriceString(price)).toBe(true);
    },
  );

  it.each(["", "01", "1.", ".5", "-1", "+1", "1e2", "1.123456789", "10000000000", "1.2.3"])(
    "rejects price %j",
    (price) => {
      expect(isPriceString(price)).toBe(false);
    },
  );

  it.each(["1", "1000000", "9223372036854775807"])("accepts unit size %j", (unitSize) => {
    expect(isPositiveBigintString(unitSize)).toBe(true);
  });

  it.each(["0", "01", "-1", "1.5", "9223372036854775808", ""])(
    "rejects unit size %j",
    (unitSize) => {
      expect(isPositiveBigintString(unitSize)).toBe(false);
    },
  );
});
