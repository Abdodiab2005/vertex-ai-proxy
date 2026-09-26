export function decideReservation(input: {
  balanceMicros: bigint;
  activeReservationsMicros: bigint;
  estimateMicros: bigint;
}): { allowed: false } | { allowed: true; reserveMicros: bigint } {
  const availableMicros = input.balanceMicros - input.activeReservationsMicros;

  if (availableMicros <= 0n) {
    return { allowed: false };
  }

  if (input.estimateMicros <= availableMicros) {
    return { allowed: true, reserveMicros: input.estimateMicros };
  }

  // Estimates assume the longest possible answer, so refusing every request that doesn't fit would
  // lock out a low balance that real requests could still pay for. A lone request may run on what
  // is left (it can overspend by at most itself); one that would share credit already held by
  // requests in flight is refused, or concurrent requests could jointly spend the same money.
  if (input.activeReservationsMicros > 0n) {
    return { allowed: false };
  }

  return { allowed: true, reserveMicros: availableMicros };
}

/**
 * After reserve, active holds include the new one. They must still fit a
 * balance re-read from the ledger: a settlement between the snapshot and the
 * reserve debits that balance and then drops its own hold, so the snapshot is
 * too high. A lone hold clamped to whatever remained still fits.
 */
export function holdsFitFreshBalance(
  activeReservedMicros: bigint,
  freshBalanceMicros: bigint,
): boolean {
  return activeReservedMicros <= freshBalanceMicros;
}
