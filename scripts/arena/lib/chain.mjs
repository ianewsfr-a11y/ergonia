// Shared, dependency-free helpers for the arena benchmark tooling.
//
//   fetchWindow   read events FIRST_ID..HEAD from /api/events (paged by `before`)
//   replayLedger  total / circulating / escrow / balances at a given head
//   canonicalJson the server's canonical form (sorted keys, no whitespace)
//   windowText    the T2 canonical text for a window of events
//   sha256Hex     SHA-256 over UTF-8 bytes, WebCrypto only (works in Node and Workers)
//
// Read-only: nothing here ever writes to the API.

export const BASE = "https://ergonia.works";
export const PAGE = 200;

// ---------------------------------------------------------------- fetch

/**
 * Events with FIRST_ID <= id <= HEAD, ascending by id. Pages backwards
 * with `before` (exclusive), so the first request uses before = HEAD + 1.
 */
export async function fetchWindow(firstId, head, base = BASE, fetchImpl = fetch) {
  const out = [];
  let before = head + 1;
  for (;;) {
    const url = `${base}/api/events?limit=${PAGE}&before=${before}`;
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    const page = (await r.json()).events;
    if (!page.length) break;
    for (const e of page) if (e.id >= firstId) out.push(e);
    const min = page[page.length - 1].id;
    if (min <= firstId || page.length < PAGE) break;
    before = min;
  }
  out.sort((a, b) => a.id - b.id);
  const expected = head - firstId + 1;
  if (out.length !== expected) {
    throw new Error(`window ${firstId}..${head} has ${out.length} events, expected ${expected} (chain ids are dense)`);
  }
  return out;
}

/** Event id of the `submission` event whose payload.submission_id equals the given id, or null. */
export async function findSubmissionEventId(submissionId, base = BASE, fetchImpl = fetch) {
  let before = 0;
  for (;;) {
    const url = `${base}/api/events?kind=submission&limit=${PAGE}${before ? `&before=${before}` : ""}`;
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    const page = (await r.json()).events;
    for (const e of page) if (e.payload && e.payload.submission_id === submissionId) return e.id;
    if (page.length < PAGE) return null;
    before = page[page.length - 1].id;
  }
}

// ---------------------------------------------------------------- ledger

/**
 * Replay every credit movement up to and including `head`.
 * Rules (docs/arena/EVENTS_SCHEMA.md): register and founder_grant mint;
 * task_created escrows; task_closed refunds; an accepted verdict pays the
 * submitter and releases the escrow; credit_transfer is the same payout
 * recorded twice and is skipped; expiry moves nothing.
 */
export function replayLedger(events, head = Infinity) {
  const balances = new Map();
  const handles = new Map();
  const rewardOf = new Map();
  const open = new Set();
  const add = (id, delta) => balances.set(id, (balances.get(id) ?? 0) + delta);
  for (const e of events) {
    if (e.id > head) break;
    const p = e.payload;
    switch (e.kind) {
      case "register":
        add(p.member_id, p.credits);
        handles.set(p.member_id, p.handle);
        break;
      case "founder_grant":
        add(p.member_id, p.amount);
        break;
      case "task_created":
        add(p.author_id, -p.reward_credits);
        rewardOf.set(p.task_id, p.reward_credits);
        open.add(p.task_id);
        break;
      case "task_closed":
        add(p.author_id, p.refunded_credits);
        open.delete(p.task_id);
        break;
      case "verdict":
        if (p.status === "accepted") {
          add(p.submitter_id, p.credits_transferred);
          open.delete(p.task_id);
        }
        break;
      default:
        break;
    }
  }
  let escrow = 0;
  for (const t of open) escrow += rewardOf.get(t) ?? 0;
  let circulating = 0;
  for (const v of balances.values()) circulating += v;
  return {
    head: Math.min(head, events.length ? events[events.length - 1].id : 0),
    total: circulating + escrow,
    circulating,
    escrow,
    open_tasks: [...open].sort((a, b) => a - b),
    balances: Object.fromEntries([...balances].map(([id, v]) => [handles.get(id) ?? String(id), v])),
  };
}

// ---------------------------------------------------------------- canonical form (T2)

/** Same algorithm as src/util.ts canonicalJson: sorted keys at every depth, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/** Epoch milliseconds to ISO 8601 UTC truncated (not rounded) to the second: 2026-09-07T18:59:49Z */
export function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * One event as the T2 rules record it. ASSUMED until the T2 brief text is
 * on file (see docs/arena/HANDOFF.md): the six served fields, created_at
 * truncated to the second, payload kept as an object (re-canonicalized).
 */
export function eventRecord(e) {
  return { id: e.id, kind: e.kind, created_at: isoSeconds(e.created_at), payload: e.payload, prev_hash: e.prev_hash, hash: e.hash };
}

/** Canonical text of a window: one canonical record per line, ascending id, LF separators, no trailing newline. */
export function windowText(events) {
  return [...events].sort((a, b) => a.id - b.id).map((e) => canonicalJson(eventRecord(e))).join("\n");
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse an artifact of the form  FIRST_ID=<n>\nHEAD=<n>\nSHA256=<hex>  (any order, other lines ignored). */
export function parseArtifact(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(FIRST_ID|HEAD|SHA256)\s*=\s*(\S+)\s*$/i.exec(line);
    if (m) out[m[1].toUpperCase()] = m[2];
  }
  return {
    first_id: out.FIRST_ID ? Number(out.FIRST_ID) : null,
    head: out.HEAD ? Number(out.HEAD) : null,
    sha256: out.SHA256 ? out.SHA256.toLowerCase() : null,
  };
}
