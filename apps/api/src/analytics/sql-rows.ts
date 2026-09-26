import { InternalServerErrorException } from "@nestjs/common";

export function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new InternalServerErrorException("Analytics query returned an unexpected result.");
  }
  return value.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new InternalServerErrorException("Analytics query returned an unexpected row.");
    }
    return row as Record<string, unknown>;
  });
}

export function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new InternalServerErrorException(`Analytics field ${key} was not text.`);
  }
  return value;
}

export function readInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new InternalServerErrorException(`Analytics field ${key} was not an integer.`);
}

export function readIntOrNull(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  return readInt(row, key);
}

export function readBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new InternalServerErrorException(`Analytics field ${key} was not a boolean.`);
  }
  return value;
}

export function readIsoTimestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  throw new InternalServerErrorException("Analytics timestamp was not a datetime.");
}

export function readIsoTimestampOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readIsoTimestamp(value);
}
