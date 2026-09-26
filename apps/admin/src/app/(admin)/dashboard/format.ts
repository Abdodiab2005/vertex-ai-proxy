import type { AnalyticsBucket } from "../../../lib/types";

export function formatUsd(value: string): string {
  if (value.startsWith("-")) {
    return `-$${value.slice(1)}`;
  }
  return `$${value}`;
}

export function groupInteger(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) {
    return value;
  }
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatRate(rate: string): string {
  return `${rate} (${shiftDecimal(rate, 2)}%)`;
}

export function formatAxisTime(iso: string, bucket: AnalyticsBucket): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (bucket === "day") {
    return `${month}-${day}`;
  }
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${month}-${day} ${hour}:00`;
}

export function formatUtcInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day} ${hour}:${minute} UTC`;
}

function shiftDecimal(value: string, places: number): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (!/^\d+$/.test(whole) || (fraction.length > 0 && !/^\d+$/.test(fraction))) {
    return value;
  }
  const digits = `${whole}${fraction}`;
  const point = whole.length + places;
  const padded = point > digits.length ? digits.padEnd(point, "0") : digits;
  const leftRaw = padded.slice(0, point).replace(/^0+(?=\d)/, "");
  const left = leftRaw.length === 0 ? "0" : leftRaw;
  const right = padded.slice(point).replace(/0+$/, "");
  const body = right.length > 0 ? `${left}.${right}` : left;
  return negative && body !== "0" ? `-${body}` : body;
}
