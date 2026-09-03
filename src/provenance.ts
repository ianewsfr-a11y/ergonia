// src/provenance.ts
//
// The `provenance` block that public read endpoints carry on their
// response. A reader who lands cold on the endpoint should be able to
// re-derive every claim in the body from external, independently
// hostable evidence, WITHOUT calling us again.
//
// The block is a fixed shape:
//   {
//     attest:        url of /api/attest (re-verifies the whole chain)
//     witness:       raw URL of the public witness's HEADS.jsonl
//                    (checkpointed daily outside our infrastructure)
//     official:      url of /api/official (anti-impersonation registry)
//     response_hash: sha256(canonical(body_without_provenance))
//     generated_at:  ISO-8601 UTC timestamp of this response
//   }
//
// The response hash is computed on the body WITHOUT the provenance
// field, so that adding provenance does not create a self-referential
// hash. `now`/`now_utc` are added AFTER provenance by the `json()`
// helper in util.ts, so they are also excluded from the hash. This
// means the same underlying data returns the same hash across
// requests, and any change to the data changes the hash. A caller can
// save today's hash and diff against tomorrow's.
//
// Canonicalisation: JSON.stringify with sorted keys, no whitespace,
// standard escaping. That is enough for byte-stable equality between
// two calls that return the same data. It is NOT a formal JCS
// (RFC 8785) implementation; if a downstream check ever needs strict
// JCS the switch is local to `canonicalJson()` here.
//
// The three URLs are read from BRAND. There are no relative paths in
// the response: a stranger reading a copy of this response offline
// still has absolute pointers to the evidence.

import { BRAND } from "./brand.js";
import { sha256Hex } from "./hash.js";
import { nowUtcISO } from "./util.js";

// URL to the raw HEADS.jsonl file on the public witness repo. The
// witness repo itself is BRAND.witness (a browsable GitHub URL); this
// is the direct byte-stream a script can diff without HTML parsing.
const WITNESS_HEADS_URL =
  "https://raw.githubusercontent.com/ianewsfr-a11y/ergonia-witness/main/HEADS.jsonl";

export interface Provenance {
  readonly attest: string;
  readonly witness: string;
  readonly official: string;
  readonly response_hash: string;
  readonly generated_at: string;
}

export async function buildProvenance(
  body: Record<string, unknown>,
): Promise<Provenance> {
  const canonical = canonicalJson(body);
  const hash = await sha256Hex(canonical);
  return {
    attest: `${BRAND.api}/attest`,
    witness: WITNESS_HEADS_URL,
    official: `${BRAND.api}/official`,
    response_hash: hash,
    generated_at: nowUtcISO(),
  };
}

// Attach a `provenance` field to `body` and return the new object.
// The hash is computed over `body` as-is; do NOT include a placeholder
// provenance field in `body` yourself.
export async function withProvenance<T extends Record<string, unknown>>(
  body: T,
): Promise<T & { provenance: Provenance }> {
  const provenance = await buildProvenance(body);
  return { ...body, provenance };
}

// Deterministic JSON: sort keys recursively, no whitespace, standard
// escaping. Sufficient for byte-stable equality across two calls that
// return the same data.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortDeep);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortDeep((v as Record<string, unknown>)[k]);
  return out;
}
