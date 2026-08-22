export type JsonObject = Record<string, unknown>;

/**
 * Canonical JSON compatible with RFC 8785/JCS for JSON-parsed values.
 *
 * JSON input cannot contain undefined, NaN, or infinities.  Keep the explicit
 * checks so callers cannot accidentally hash a non-JSON in-memory value.
 * JavaScript's JSON.stringify supplies the ECMAScript number and string
 * serialization required by JCS; object keys are sorted by UTF-16 code unit.
 */
export function jcsStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JCS cannot encode a non-finite number");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("JCS number encoding failed");
    return encoded;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("JCS scalar encoding failed");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jcsStringify(item)).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`JCS cannot encode ${typeof value}`);
  }
  const object = value as JsonObject;
  return `{${
    Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jcsStringify(object[key])}`)
      .join(",")
  }}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function publishRecordWrapper(row: JsonObject): JsonObject {
  return {
    ticker: row.ticker,
    source: row.source,
    scanOrder: row.scanOrder,
    record: row.record,
    summary: row.summary ?? {},
  };
}

export async function publishRecordHash(row: JsonObject): Promise<string> {
  return sha256Hex(jcsStringify(publishRecordWrapper(row)));
}
