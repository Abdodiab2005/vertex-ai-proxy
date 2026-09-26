import { describe, expect, it } from "vitest";
import { decideReservation, holdsFitFreshBalance } from "./reservation-decision.js";

describe("decideReservation", () => {
  it.each([
    {
      name: "rejects an exhausted balance",
      balanceMicros: 100n,
      activeReservationsMicros: 100n,
      estimateMicros: 1n,
      expected: { allowed: false },
    },
    {
      name: "reserves the full estimate when available credit covers it",
      balanceMicros: 1_000n,
      activeReservationsMicros: 200n,
      estimateMicros: 300n,
      expected: { allowed: true, reserveMicros: 300n },
    },
    {
      name: "refuses a request that would share credit held by requests in flight",
      balanceMicros: 1_000n,
      activeReservationsMicros: 900n,
      estimateMicros: 500n,
      expected: { allowed: false },
    },
    {
      name: "lets a lone request run on less than its estimate",
      balanceMicros: 100n,
      activeReservationsMicros: 0n,
      estimateMicros: 500n,
      expected: { allowed: true, reserveMicros: 100n },
    },
    {
      name: "allows a zero estimate while credit remains",
      balanceMicros: 1n,
      activeReservationsMicros: 0n,
      estimateMicros: 0n,
      expected: { allowed: true, reserveMicros: 0n },
    },
  ])("$name", ({ balanceMicros, activeReservationsMicros, estimateMicros, expected }) => {
    expect(
      decideReservation({ balanceMicros, activeReservationsMicros, estimateMicros }),
    ).toEqual(expected);
  });
});

describe("holdsFitFreshBalance", () => {
  it("accepts a hold that still fits, including one clamped to the remaining balance", () => {
    expect(holdsFitFreshBalance(40_000n, 50_000n)).toBe(true);
    expect(holdsFitFreshBalance(40_000n, 40_000n)).toBe(true);
  });

  it("rejects when active holds exceed the balance re-read after reserve", () => {
    expect(holdsFitFreshBalance(40_000n, 10_000n)).toBe(false);
  });
});
