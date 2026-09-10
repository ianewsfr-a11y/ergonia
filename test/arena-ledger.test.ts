// Ledger replay used by scripts/arena/leaderboard.mjs (and by anyone
// verifying a T1 artifact), checked on fixture events, never live.
import { describe, expect, it } from "vitest";
import { replayLedger, type ChainEvent } from "../scripts/arena/lib/chain.mjs";

const ev = (id: number, kind: string, payload: Record<string, unknown>): ChainEvent => ({
  id,
  kind,
  payload,
  prev_hash: id === 1 ? "GENESIS" : "p".repeat(64),
  hash: "h".repeat(64),
  created_at: 1788000000000 + id,
});

const chain: ChainEvent[] = [
  ev(1, "register", { credits: 100, handle: "a", member_id: 1, model: "m" }),
  ev(2, "register", { credits: 100, handle: "b", member_id: 2, model: "m" }),
  ev(3, "founder_grant", { amount: 50, handle: "a", member_id: 1, reason: "seed" }),
  ev(4, "task_created", { author: "a", author_id: 1, expiry: null, guild: "arena", reward_credits: 30, task_id: 1, title: "t" }),
  ev(5, "task_created", { author: "a", author_id: 1, expiry: 1, guild: "arena", reward_credits: 20, task_id: 2, title: "u" }),
  ev(6, "submission", { artifact: "x", handle: "b", member_id: 2, submission_id: 1, task_id: 1 }),
  ev(7, "verdict", { author_id: 1, credits_transferred: 30, karma_delta: 10, reason: "ok", status: "accepted", submission_id: 1, submitter_id: 2, task_id: 1 }),
  ev(8, "credit_transfer", { amount: 30, from_member_id: 1, reason: "task_reward", submission_id: 1, task_id: 1, to_member_id: 2 }),
  ev(9, "verdict", { author_id: 1, credits_transferred: 0, karma_delta: 0, reason: "no", status: "rejected", submission_id: 2, submitter_id: 2, task_id: 2 }),
  ev(10, "comment", { comment_id: 1, handle: "b", member_id: 2, task_id: 2 }),
  ev(11, "task_closed", { author_id: 1, refunded_credits: 20, task_id: 2 }),
];

describe("ledger replay", () => {
  it("conserves the total and counts the accepted payout once", () => {
    const l = replayLedger(chain);
    expect(l).toMatchObject({ head: 11, total: 250, circulating: 250, escrow: 0, open_tasks: [] });
    expect(l.balances).toEqual({ a: 120, b: 130 });
  });

  it("holds escrow while tasks are open; a rejected verdict and an elapsed expiry release nothing", () => {
    expect(replayLedger(chain, 5)).toMatchObject({ total: 250, circulating: 200, escrow: 50, open_tasks: [1, 2] });
    // task 2 has expiry 1 (long past) and a rejected verdict at event 9: still open, still escrowed
    expect(replayLedger(chain, 10)).toMatchObject({ total: 250, circulating: 230, escrow: 20, open_tasks: [2] });
  });

  it("refunds on task_closed", () => {
    expect(replayLedger(chain, 11).balances.a).toBe(120);
  });

  it("is stable when the same window is replayed at two heads 25 apart in a longer chain", () => {
    const long = [...chain];
    for (let i = 12; i <= 40; i++) long.push(ev(i, "comment", { comment_id: i, handle: "b", member_id: 2, task_id: 1 }));
    expect(replayLedger(long, 40).total).toBe(250);
    expect(replayLedger(long, 15).total).toBe(250);
  });
});

describe("ledger replay, onboarding kinds (2026-09-10)", () => {
  const onboarding: ChainEvent[] = [
    ev(1, "register", { credits: 100, handle: "a", member_id: 1, model: "m" }),
    ev(2, "register", { credits: 100, handle: "b", member_id: 2, model: "m" }),
    ev(3, "task_created", { author: "a", author_id: 1, expiry: null, guild: "arena", kind: "onboarding", pool_credits: 6, pool_size: 3, reward_credits: 2, task_id: 1, title: "t" }),
    ev(4, "verdict", { author_id: 1, credits_transferred: 2, karma_delta: 10, reason: "ok", status: "accepted", submission_id: 1, submitter_id: 2, task_id: 1, task_kind: "onboarding", pool_after: 4, task_status: "open" }),
    ev(5, "credit_transfer", { amount: 2, from_member_id: 1, reason: "task_reward", submission_id: 1, task_id: 1, to_member_id: 2 }),
    ev(6, "task_funded", { amount: 3, author_id: 1, pool_after: 7, status_after: "open", task_id: 1 }),
    ev(7, "task_closed", { author_id: 1, refunded_credits: 7, task_id: 1 }),
  ];
  it("escrows the pool, shrinks it per acceptance, grows it on funding, refunds it on close", () => {
    expect(replayLedger(onboarding, 3)).toMatchObject({ total: 200, circulating: 194, escrow: 6, open_tasks: [1] });
    expect(replayLedger(onboarding, 5)).toMatchObject({ total: 200, circulating: 196, escrow: 4, open_tasks: [1] });
    expect(replayLedger(onboarding, 6)).toMatchObject({ total: 200, circulating: 193, escrow: 7 });
    expect(replayLedger(onboarding, 7)).toMatchObject({ total: 200, circulating: 200, escrow: 0, open_tasks: [] });
  });
});
