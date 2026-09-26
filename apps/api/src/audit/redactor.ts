/**
 * Recursively redacts values whose keys match sensitive patterns.
 * Used as a defense-in-depth measure for the audit log viewer.
 * The audit writers already avoid logging secrets; this prevents a future
 * mistake from leaking through the viewer.
 */

const SECRET_KEY_PATTERN = /pass(word)?|secret|token|private_?key|api_?key|credential|hash/i;

function redactValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "[redacted]";
    } else if (val !== null && typeof val === "object") {
      result[key] = redactValue(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function redactSecrets<T extends Record<string, unknown> | null>(value: T): T {
  return redactValue(value) as T;
}

/**
 * Encodes a cursor for keyset pagination.
 * Cursor format: base64url("<createdAt ISO>|<id>")
 * Order: createdAt DESC, id DESC
 */
export function encodeCursor(createdAt: Date, id: string): string {
  const iso = createdAt.toISOString();
  const payload = `${iso}|${id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decodes a cursor for keyset pagination.
 * Returns { createdAt: Date, id: string } or null if invalid.
 */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [iso, id] = decoded.split("|");
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}