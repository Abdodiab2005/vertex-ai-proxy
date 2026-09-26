import { describe, expect, it } from "vitest";
import { ceilDivide, formatMicros, MoneyFormatError, toMicros } from "./money.js";

describe("money conversion", () => {
  const roundTripCases = [
    { amount: "0", micros: 0n, formatted: "0.000000" },
    { amount: "1", micros: 1_000_000n, formatted: "1.000000" },
    { amount: "1.2", micros: 1_200_000n, formatted: "1.200000" },
    { amount: "1.000001", micros: 1_000_001n, formatted: "1.000001" },
    { amount: "-1.5", micros: -1_500_000n, formatted: "-1.500000" },
    { amount: "-0", micros: 0n, formatted: "0.000000" },
    { amount: "-0.000000", micros: 0n, formatted: "0.000000" },
    {
      amount: "999999999999.999999",
      micros: 999_999_999_999_999_999n,
      formatted: "999999999999.999999",
    },
  ];

  it.each(roundTripCases)("converts $amount without losing precision", ({ amount, micros, formatted }) => {
    expect(toMicros(amount)).toBe(micros);
    expect(formatMicros(micros)).toBe(formatted);
  });

  it.each([
    [-1n, "-0.000001"],
    [-1_500_000n, "-1.500000"],
    [1_500_000n, "1.500000"],
  ])("formats %s as %s", (micros, formatted) => {
    expect(formatMicros(micros)).toBe(formatted);
  });

  it.each(["1.0000000", "1.", "", "abc", "--1", ".1", "+1", "1234567890123"])(
    "rejects malformed amount %s",
    (amount) => {
      expect(() => toMicros(amount)).toThrow(MoneyFormatError);
    },
  );
});

describe("ceilDivide", () => {
  it.each([
    [0n, 1n, 0n],
    [1n, 2n, 1n],
    [9n, 3n, 3n],
    [10n, 3n, 4n],
  ])("ceilDivide(%s, %s) is %s", (numerator, denominator, expected) => {
    expect(ceilDivide(numerator, denominator)).toBe(expected);
  });

  it.each([
    [-1n, 1n],
    [1n, -1n],
    [1n, 0n],
  ])("rejects invalid inputs (%s, %s)", (numerator, denominator) => {
    expect(() => ceilDivide(numerator, denominator)).toThrow(RangeError);
  });
});
