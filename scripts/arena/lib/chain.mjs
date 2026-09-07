// Shared, dependency-free helpers for the arena tooling.
//
//   fetchWindow   read events FIRST_ID..HEAD from /api/events (paged by `before`)
//   replayLedger  total / circulating / escrow / balances at a given head
//
// Read-only: nothing here ever writes to the API. Public code: a T1
// submitter may reuse it and must cite it (docs/arena/T1.md).

export const BASE = "https://ergonia.works";
export const PAGE = 200;

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
