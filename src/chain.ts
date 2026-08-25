// Hash-chained append-only event log.
//
// Design:
//   - Every mutation calls appendEvent(kind, payload). No mutation may run
//     without one — that's the rule of the register (SPEC §3).
//   - `payload` is serialized with canonicalJson() (sorted keys, no whitespace)
//     so the hash is stable across restarts, JS engines, and reviewers.
//   - hash = SHA-256(prev_hash || canonical_payload). The very first event
//     uses the string "GENESIS" as its prev_hash.
//   - GET /api/attest recomputes the whole chain in a single scan.

import { sha256Hex } from "./hash.js";
import type { Env, EventKind, EventRow } from "./types.js";
import { canonicalJson, nowMs } from "./util.js";

const GENESIS_PREV = "GENESIS";

export interface AppendedEvent {
  id: number;
  kind: EventKind;
  hash: string;
  prev_hash: string;
  created_at: number;
}

export async function appendEvent(
  env: Env,
  kind: EventKind,
  payload: Record<string, unknown>,
): Promise<AppendedEvent> {
  const prepared = await prepareEvent(env, kind, payload);
  const result = await prepared.statement.run();
  const id = Number(result.meta.last_row_id);
  return { id, kind, hash: prepared.hash, prev_hash: prepared.prev_hash, created_at: prepared.created_at };
}

export interface PreparedEvent {
  statement: D1PreparedStatement;
  kind: EventKind;
  hash: string;
  prev_hash: string;
  created_at: number;
}

// Build the INSERT for an event without running it, so a caller can put
// it in the SAME D1 batch as the state change it records. D1 batches are
// one transaction: if the event INSERT is rejected (e.g. by the partial
// UNIQUE index that permits a single founder_grant chain-wide), the state
// change rolls back with it. That is how we make "record + mutate" atomic
// instead of merely adjacent.
export async function prepareEvent(
  env: Env,
  kind: EventKind,
  payload: Record<string, unknown>,
): Promise<PreparedEvent> {
  const canonical = canonicalJson(payload);
  const prev = await env.DB
    .prepare("SELECT hash FROM events ORDER BY id DESC LIMIT 1")
    .first<{ hash: string }>();
  const prevHash = prev?.hash ?? GENESIS_PREV;
  const hash = await sha256Hex(prevHash + canonical);
  const createdAt = nowMs();
  const statement = env.DB
    .prepare(
      "INSERT INTO events (kind, payload, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(kind, canonical, prevHash, hash, createdAt);
  return { statement, kind, hash, prev_hash: prevHash, created_at: createdAt };
}

export interface AttestReport {
  ok: boolean;
  count: number;
  head?: { id: number; hash: string; kind: EventKind } | undefined;
  broken_at?: number | undefined;
  broken_reason?: string | undefined;
}

// Walk every event, recompute each hash, and verify links. Returns
// ok=false and pinpoints the first broken link if any.
export async function attestChain(env: Env): Promise<AttestReport> {
  const rs = await env.DB
    .prepare(
      "SELECT id, kind, payload, prev_hash, hash, created_at FROM events ORDER BY id ASC",
    )
    .all<EventRow>();
  const rows = rs.results ?? [];
  let prev = GENESIS_PREV;
  let head: AttestReport["head"];
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        count: rows.length,
        broken_at: row.id,
        broken_reason: `prev_hash mismatch (expected ${prev}, got ${row.prev_hash})`,
      };
    }
    const expected = await sha256Hex(row.prev_hash + row.payload);
    if (expected !== row.hash) {
      return {
        ok: false,
        count: rows.length,
        broken_at: row.id,
        broken_reason: "hash mismatch",
      };
    }
    prev = row.hash;
    head = { id: row.id, hash: row.hash, kind: row.kind };
  }
  return { ok: true, count: rows.length, head };
}
