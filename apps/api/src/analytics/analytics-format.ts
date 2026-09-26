export const USAGE_EXPORT_MAX_ROWS = 100_000;

const ERROR_RATE_SCALE = 10_000n;

// Integer ratio rounded half up (away from zero) at 4 decimal places. Counts
// stay integers so the displayed rate is not a binary float.
export function formatErrorRate(errors: bigint, total: bigint): string {
  if (errors < 0n || total < 0n) {
    throw new RangeError("error rate counts must be non-negative");
  }
  if (total === 0n || errors === 0n) {
    return "0.0000";
  }
  const rounded = (errors * ERROR_RATE_SCALE + total / 2n) / total;
  const whole = rounded / ERROR_RATE_SCALE;
  const fraction = rounded % ERROR_RATE_SCALE;
  return `${whole.toString()}.${fraction.toString().padStart(4, "0")}`;
}

export function exportExceedsRowLimit(rowCount: number): boolean {
  return rowCount > USAGE_EXPORT_MAX_ROWS;
}

export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return "";
  }
  return `${rows.map((row) => row.map((field) => escapeCsvField(field)).join(",")).join("\r\n")}\r\n`;
}

export function stableDimensionJson(dimensions: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(dimensions).sort()) {
    const total = dimensions[key];
    if (total !== undefined) {
      sorted[key] = total;
    }
  }
  return JSON.stringify(sorted);
}
