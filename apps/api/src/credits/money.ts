const MICROS_PER_UNIT = 1_000_000n;
const MONEY_FORMAT = /^-?\d{1,12}(\.\d{1,6})?$/;

export class MoneyFormatError extends Error {
  constructor(amount: string) {
    super(`Invalid money amount: "${amount}"`);
    this.name = "MoneyFormatError";
  }
}

export function toMicros(amount: string): bigint {
  if (!MONEY_FORMAT.test(amount)) {
    throw new MoneyFormatError(amount);
  }

  const negative = amount.startsWith("-");
  const unsignedAmount = negative ? amount.slice(1) : amount;
  const [integerPart = "0", fractionalPart = ""] = unsignedAmount.split(".");
  const fractionalMicros = (fractionalPart + "000000").slice(0, 6);
  const micros = BigInt(integerPart) * MICROS_PER_UNIT + BigInt(fractionalMicros);

  return negative && micros !== 0n ? -micros : micros;
}

export function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const absoluteMicros = negative ? -micros : micros;
  const integerPart = absoluteMicros / MICROS_PER_UNIT;
  const fractionalPart = absoluteMicros % MICROS_PER_UNIT;
  const sign = negative ? "-" : "";

  return `${sign}${integerPart}.${fractionalPart.toString().padStart(6, "0")}`;
}

export function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError("ceilDivide requires a non-negative numerator and a positive denominator");
  }

  return (numerator + denominator - 1n) / denominator;
}
