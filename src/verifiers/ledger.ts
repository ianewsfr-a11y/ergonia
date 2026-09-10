// Replay of the credit ledger from the chain, inside the Worker.
//
// The same rules as scripts/arena/lib/chain.mjs (the public replay a T1
// submitter may cite), extended with the two onboarding kinds. Every rule
// is stated in docs/arena/EVENTS_SCHEMA.md; a change here is a change
// there in the same commit, because chain-replay@1 judges T1 with this
// function and a submitter must be able to reproduce it from the doc.
//
//   register        mints `credits` to the member
//   founder_grant   mints `amount` to the member
//   task_created    moves the escrow from the author's balance: the
//                   reward for a bounty, `pool_credits` for an onboarding task
//   task_funded     moves `amount` more from the author into the pool
//   task_closed     returns `refunded_credits` to the author, escrow released
//   verdict         accepted: pays `credits_transferred` to the submitter;
//                   a bounty's escrow is released (the task closed), an
//                   onboarding pool shrinks by the amount paid
//   credit_transfer the accepted payout recorded a second time: skipped
//   everything else moves nothing; expiry is not an event

import type { Env } from "../types.js";

export interface ChainEvent {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface Ledger {
  head: number;
  total: number;
  circulating: number;
  escrow: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function loadEventsUpTo(env: Env, head: number): Promise<ChainEvent[]> {
  if (!Number.isInteger(head) || head < 1) return [];
  const rs = await env.DB
    .prepare("SELECT id, kind, payload FROM events WHERE id <= ? ORDER BY id ASC")
    .bind(head)
    .all<{ id: number; kind: string; payload: string }>();
  return (rs.results ?? []).map((r) => ({ id: r.id, kind: r.kind, payload: parse(r.payload) }));
}

function parse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function replayLedger(events: readonly ChainEvent[], head: number = Number.POSITIVE_INFINITY): Ledger {
  const balances = new Map<number, number>();
  const escrowOf = new Map<number, number>();
  const kindOf = new Map<number, string>();
  const add = (id: number, delta: number): void => {
    balances.set(id, (balances.get(id) ?? 0) + delta);
  };
  let last = 0;
  for (const e of events) {
    if (e.id > head) break;
    last = e.id;
    const p = e.payload;
    switch (e.kind) {
      case "register":
        add(num(p.member_id), num(p.credits));
        break;
      case "founder_grant":
        add(num(p.member_id), num(p.amount));
        break;
      case "task_created": {
        const kind = p.kind === "onboarding" ? "onboarding" : "bounty";
        const escrow = kind === "onboarding" ? num(p.pool_credits) : num(p.reward_credits);
        add(num(p.author_id), -escrow);
        escrowOf.set(num(p.task_id), escrow);
        kindOf.set(num(p.task_id), kind);
        break;
      }
      case "task_funded": {
        const t = num(p.task_id);
        add(num(p.author_id), -num(p.amount));
        escrowOf.set(t, (escrowOf.get(t) ?? 0) + num(p.amount));
        break;
      }
      case "task_closed":
        add(num(p.author_id), num(p.refunded_credits));
        escrowOf.delete(num(p.task_id));
        break;
      case "verdict":
        if (p.status === "accepted") {
          const t = num(p.task_id);
          const paid = num(p.credits_transferred);
          add(num(p.submitter_id), paid);
          if (kindOf.get(t) === "onboarding") escrowOf.set(t, Math.max(0, (escrowOf.get(t) ?? 0) - paid));
          else escrowOf.delete(t);
        }
        break;
      default:
        break;
    }
  }
  let escrow = 0;
  for (const v of escrowOf.values()) escrow += v;
  let circulating = 0;
  for (const v of balances.values()) circulating += v;
  return { head: Math.min(head, last), total: circulating + escrow, circulating, escrow };
}
