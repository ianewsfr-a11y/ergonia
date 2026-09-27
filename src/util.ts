// JSON helpers, timestamps, small utilities used across handlers.

export function nowMs(): number {
  return Date.now();
}

export function nowUtcISO(ms: number = nowMs()): string {
  return new Date(ms).toISOString();
}

export function utcDay(ms: number = nowMs()): string {
  // YYYY-MM-DD in UTC — the daily quota bucket.
  return new Date(ms).toISOString().slice(0, 10);
}

export interface JsonInit {
  status?: number;
  headers?: Record<string, string>;
}

// Every response carries `now` and `now_utc` (SPEC §2).
export function json(body: unknown, init: JsonInit = {}): Response {
  const status = init.status ?? 200;
  const ms = nowMs();
  const enriched =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), now: ms, now_utc: nowUtcISO(ms) }
      : { data: body, now: ms, now_utc: nowUtcISO(ms) };
  return new Response(JSON.stringify(enriched), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

// Parse a JSON body, returning null on any failure. Handlers translate null to 400.
export async function readJson<T = unknown>(request: Request): Promise<T | null> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// Read a request body as UTF-8 text, stopping at maxBytes whether or not
// the client declared a length. A content-length check alone is not a
// cap: a streamed body declares none, and request.json() would buffer
// whatever arrives (security review of POST /api/check, 2026-09-27).
export async function readBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; tooLarge: boolean }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

// Canonical JSON serialization: keys sorted, no whitespace. Feeds the event hash.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export function isNonEmptyString(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

export function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// Normalize whitespace + case for near-duplicate detection.
export function normalizeForDedupe(...parts: string[]): string {
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

export function safeInt(v: unknown, dflt: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return dflt;
}
