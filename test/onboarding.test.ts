// Onboarding tasks (flag ONBOARDING_TASKS): accepted once per member,
// fixed reward, never closed by an acceptance, pool escrow, paused when
// unfunded, refilled by the author. The evergreen form T0/T1 move to
// (DECISIONS.md, 2026-09-09 and 2026-09-10).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, goodCondition, register } from "./helpers.js";

async function onboardingTask(token: string, over: Record<string, unknown> = {}) {
  return api("POST", "/api/tasks", {
    token,
    body: {
      guild: "arena",
      title: "[EVAL-CHAIN-1] Reconstruct the credit ledger",
      brief: "Replay the chain; accepted once per member.",
      condition: goodCondition(),
      reward_credits: 2,
      kind: "onboarding",
      pool_size: 3,
      ...over,
    },
  });
}

async function submitAndAccept(author: string, worker: string, taskId: number, artifact: string) {
  const sub = await api("POST", "/api/submissions", { token: worker, body: { task_id: taskId, artifact } });
  expect(sub.status, JSON.stringify(sub.body)).toBe(201);
  const v = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, { token: author, body: { status: "accepted", reason: "replay matches" } });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return { sub: sub.body.submission.id, verdict: v.body };
}

async function stats() {
  const s = await api("GET", "/api/stats");
  return s.body as { credits_total: number; credits_circulating: number; credits_escrowed: number; tasks_paused: number; tasks_open: number };
}

describe("onboarding tasks", () => {
  it("escrows reward x pool_size, chains kind and pool, shows acceptances_left", async () => {
    const a = await register("alpha");
    const t = await onboardingTask(a.secret);
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.task.kind).toBe("onboarding");
    expect(t.body.task.pool_credits).toBe(6);
    expect(t.body.task.acceptances_left).toBe(3);
    expect(t.body.task.status).toBe("open");
    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits).toBe(94);
    const ev = await api("GET", "/api/events?kind=task_created&limit=1");
    expect(ev.body.events[0].payload).toMatchObject({ task_id: t.body.task.id, kind: "onboarding", pool_credits: 6, pool_size: 3, reward_credits: 2 });
    const s = await stats();
    expect(s.credits_escrowed).toBe(6);
    expect(s.credits_total).toBe(100);
  });

  it("a bounty task's task_created payload is unchanged (no kind field)", async () => {
    const a = await register("alpha");
    const t = await api("POST", "/api/tasks", { token: a.secret, body: { guild: "evals", title: "Plain bounty", brief: "As before the 10th.", condition: goodCondition(), reward_credits: 5 } });
    expect(t.status).toBe(201);
    expect(t.body.task.kind).toBe("bounty");
    expect(t.body.task.pool_credits).toBeUndefined();
    const ev = await api("GET", "/api/events?kind=task_created&limit=1");
    expect(Object.keys(ev.body.events[0].payload).sort()).toEqual(["author", "author_id", "expiry", "guild", "reward_credits", "task_id", "title"]);
  });

  it("refuses kind/pool_size/verifier fields on invalid input", async () => {
    const a = await register("alpha");
    expect((await onboardingTask(a.secret, { pool_size: undefined })).status).toBe(400);
    expect((await onboardingTask(a.secret, { pool_size: 0 })).status).toBe(400);
    expect((await onboardingTask(a.secret, { pool_size: 1001 })).status).toBe(400);
    expect((await onboardingTask(a.secret, { kind: "weird" })).status).toBe(400);
    expect((await onboardingTask(a.secret, { kind: "bounty", pool_size: 2 })).status).toBe(400);
    expect((await onboardingTask(a.secret, { pool_size: 60 })).status).toBe(402); // 120 > 100 credits
    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.quotas.tasks_used).toBe(0);
  });

  it("stays open across acceptances, pays the fixed reward from the pool, accepts each member once, pauses when unfunded", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const w2 = await register("worker-2");
    const w3 = await register("worker-3");
    const w4 = await register("worker-4");
    const t = await onboardingTask(a.secret);
    const id = t.body.task.id as number;

    const first = await submitAndAccept(a.secret, w1.secret, id, "HEAD=1 inline");
    expect(first.verdict.credits_transferred).toBe(2);
    let task = await api("GET", `/api/tasks/${id}`);
    expect(task.body.task.status).toBe("open");
    expect(task.body.task.pool_credits).toBe(4);
    expect(task.body.task.acceptances_left).toBe(2);
    const vev = await api("GET", "/api/events?kind=verdict&limit=1");
    expect(vev.body.events[0].payload).toMatchObject({ status: "accepted", credits_transferred: 2, task_kind: "onboarding", pool_after: 4, task_status: "open" });

    // Once per member.
    const again = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "HEAD=2 inline" } });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("once per member");

    await submitAndAccept(a.secret, w2.secret, id, "HEAD=3 inline");
    const third = await submitAndAccept(a.secret, w3.secret, id, "HEAD=4 inline");
    expect(third.verdict.credits_transferred).toBe(2);
    task = await api("GET", `/api/tasks/${id}`);
    expect(task.body.task.status).toBe("paused");
    expect(task.body.task.paused_reason).toBe("unfunded");
    expect(task.body.task.pool_credits).toBe(0);
    expect(task.body.task.acceptances_left).toBe(0);

    // Paused: no new submission, no verdict on a pending one.
    const blocked = await api("POST", "/api/submissions", { token: w4.secret, body: { task_id: id, artifact: "HEAD=5 inline" } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("paused");

    // Listing and stats know the status.
    const paused = await api("GET", "/api/tasks?status=paused");
    expect(paused.body.tasks.map((x: { id: number }) => x.id)).toContain(id);
    const s = await stats();
    expect(s.tasks_paused).toBe(1);
    expect(s.credits_escrowed).toBe(0);
    expect(s.credits_total).toBe(500);
    expect(s.credits_circulating).toBe(500);

    // Members' balances: 3 x 2 paid, author paid 6 at creation.
    const w1me = await api("GET", "/api/me", { token: w1.secret });
    expect(w1me.body.credits).toBe(102);
    expect(w1me.body.karma).toBe(10);
    const ame = await api("GET", "/api/me", { token: a.secret });
    expect(ame.body.credits).toBe(94);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("fund refills the pool, reopens a paused task, is chained as task_funded and conserves the total", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const w2 = await register("worker-2");
    const t = await onboardingTask(a.secret, { pool_size: 1 });
    const id = t.body.task.id as number;
    await submitAndAccept(a.secret, w1.secret, id, "HEAD=1 inline");
    let task = await api("GET", `/api/tasks/${id}`);
    expect(task.body.task.status).toBe("paused");

    const notAuthor = await api("POST", `/api/tasks/${id}/fund`, { token: w2.secret, body: { credits: 4 } });
    expect(notAuthor.status).toBe(403);
    const tooMuch = await api("POST", `/api/tasks/${id}/fund`, { token: a.secret, body: { credits: 1000 } });
    expect(tooMuch.status).toBe(402);
    const one = await api("POST", `/api/tasks/${id}/fund`, { token: a.secret, body: { credits: 1 } });
    expect(one.status).toBe(200);
    expect(one.body.task.status).toBe("paused"); // 1 < reward 2
    const more = await api("POST", `/api/tasks/${id}/fund`, { token: a.secret, body: { credits: 3 } });
    expect(more.status).toBe(200);
    expect(more.body.task.status).toBe("open");
    expect(more.body.task.pool_credits).toBe(4);
    expect(more.body.task.acceptances_left).toBe(2);

    const ev = await api("GET", "/api/events?kind=task_funded");
    expect(ev.body.events.length).toBe(2);
    expect(ev.body.events[0].payload).toEqual({ task_id: id, author_id: a.id, amount: 3, pool_after: 4, status_after: "open" });

    const s = await stats();
    expect(s.credits_total).toBe(300);
    expect(s.credits_escrowed).toBe(4);
    const ame = await api("GET", "/api/me", { token: a.secret });
    expect(ame.body.credits).toBe(100 - 2 - 1 - 3);

    // A bounty task has no pool.
    const bounty = await api("POST", "/api/tasks", { token: a.secret, body: { guild: "evals", title: "Bounty", brief: "Plain bounty task.", condition: goodCondition(), reward_credits: 1 } });
    const noPool = await api("POST", `/api/tasks/${bounty.body.task.id}/fund`, { token: a.secret, body: { credits: 1 } });
    expect(noPool.status).toBe(409);

    // Second worker passes on the refilled pool; the first cannot again.
    await submitAndAccept(a.secret, w2.secret, id, "HEAD=2 inline");
    task = await api("GET", `/api/tasks/${id}`);
    expect(task.body.task.status).toBe("open");
    expect(task.body.task.pool_credits).toBe(2);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("closing an open or paused onboarding task refunds the whole pool", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const t = await onboardingTask(a.secret); // pool 6
    const id = t.body.task.id as number;
    await submitAndAccept(a.secret, w1.secret, id, "HEAD=1 inline"); // pool 4
    const close = await api("POST", `/api/tasks/${id}/close`, { token: a.secret });
    expect(close.status).toBe(200);
    expect(close.body.refunded_credits).toBe(4);
    expect(close.body.task.status).toBe("closed");
    const ame = await api("GET", "/api/me", { token: a.secret });
    expect(ame.body.credits).toBe(98);
    const s = await stats();
    expect(s.credits_escrowed).toBe(0);
    expect(s.credits_total).toBe(200);
    const ev = await api("GET", "/api/events?kind=task_closed&limit=1");
    expect(ev.body.events[0].payload).toEqual({ task_id: id, author_id: a.id, refunded_credits: 4 });

    // Paused task closes too.
    const t2 = await onboardingTask(a.secret, { pool_size: 1, title: "[EVAL-API-0] Rebuild the leaderboard" });
    const id2 = t2.body.task.id as number;
    const w2 = await register("worker-2");
    await submitAndAccept(a.secret, w2.secret, id2, "HEAD=1 inline");
    expect((await api("GET", `/api/tasks/${id2}`)).body.task.status).toBe("paused");
    const close2 = await api("POST", `/api/tasks/${id2}/close`, { token: a.secret });
    expect(close2.status).toBe(200);
    expect(close2.body.refunded_credits).toBe(0);
    expect(close2.body.task.status).toBe("closed");
  });

  it("a rejected verdict on an onboarding task moves nothing and keeps the task open", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const t = await onboardingTask(a.secret);
    const id = t.body.task.id as number;
    const sub = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "HEAD=1 inline" } });
    const v = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, { token: a.secret, body: { status: "rejected", reason: "wrong head" } });
    expect(v.status).toBe(200);
    expect(v.body.credits_transferred).toBe(0);
    const task = await api("GET", `/api/tasks/${id}`);
    expect(task.body.task.status).toBe("open");
    expect(task.body.task.pool_credits).toBe(6);
    // The member may try again after a rejection.
    const retry = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "HEAD=2 inline" } });
    expect(retry.status).toBe(201);
  });
});

describe("onboarding tasks, races and stranded rows (review of 2026-09-10)", () => {
  it("a pending submission on a paused task can be rejected, not accepted", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const w2 = await register("worker-2");
    const t = await onboardingTask(a.secret, { pool_size: 1 });
    const id = t.body.task.id as number;
    const stranded = await api("POST", "/api/submissions", { token: w2.secret, body: { task_id: id, artifact: "HEAD=1 inline" } });
    expect(stranded.status).toBe(201);
    await submitAndAccept(a.secret, w1.secret, id, "HEAD=2 inline"); // pool 2 -> 0, paused
    expect((await api("GET", `/api/tasks/${id}`)).body.task.status).toBe("paused");
    const accept = await api("POST", `/api/submissions/${stranded.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "fine" } });
    expect(accept.status).toBe(409);
    const reject = await api("POST", `/api/submissions/${stranded.body.submission.id}/verdict`, { token: a.secret, body: { status: "rejected", reason: "wrong head" } });
    expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    expect(reject.body.submission.status).toBe("rejected");
    const s = await stats();
    expect(s.credits_total).toBe(300);
    expect(s.credits_escrowed).toBe(0);
  });

  it("two concurrent acceptances on two submissions of a pool of one pay exactly once", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const w2 = await register("worker-2");
    const t = await onboardingTask(a.secret, { pool_size: 1 }); // pool 2, reward 2
    const id = t.body.task.id as number;
    const s1 = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "HEAD=1 inline" } });
    const s2 = await api("POST", "/api/submissions", { token: w2.secret, body: { task_id: id, artifact: "HEAD=2 inline" } });
    const [v1, v2] = await Promise.all([
      api("POST", `/api/submissions/${s1.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "ok one" } }),
      api("POST", `/api/submissions/${s2.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "ok two" } }),
    ]);
    const statuses = [v1.status, v2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const paid = (v1.status === 200 ? v1 : v2).body.credits_transferred;
    expect(paid).toBe(2);
    const s = await stats();
    expect(s.credits_total).toBe(300);
    expect(s.credits_circulating).toBe(300);
    expect(s.credits_escrowed).toBe(0);
    const m1 = (await api("GET", "/api/me", { token: w1.secret })).body.credits;
    const m2 = (await api("GET", "/api/me", { token: w2.secret })).body.credits;
    expect([m1, m2].sort()).toEqual([100, 102]);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("two concurrent acceptances on two submissions of one bounty pay exactly once", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const w2 = await register("worker-2");
    const t = await api("POST", "/api/tasks", { token: a.secret, body: { guild: "evals", title: "Bounty", brief: "One reward only.", condition: goodCondition(), reward_credits: 7 } });
    const id = t.body.task.id as number;
    const s1 = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "https://example.test/1" } });
    const s2 = await api("POST", "/api/submissions", { token: w2.secret, body: { task_id: id, artifact: "https://example.test/2" } });
    const [v1, v2] = await Promise.all([
      api("POST", `/api/submissions/${s1.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "ok one" } }),
      api("POST", `/api/submissions/${s2.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "ok two" } }),
    ]);
    expect([v1.status, v2.status].sort()).toEqual([200, 409]);
    const s = await stats();
    expect(s.credits_total).toBe(300);
    expect(s.credits_escrowed).toBe(0);
    const m1 = (await api("GET", "/api/me", { token: w1.secret })).body.credits;
    const m2 = (await api("GET", "/api/me", { token: w2.secret })).body.credits;
    expect([m1, m2].sort()).toEqual([100, 107]);
    expect((await api("GET", `/api/tasks/${id}`)).body.task.status).toBe("closed");
  });

  it("a member cannot be paid twice on an onboarding task even with two pending rows", async () => {
    const a = await register("alpha");
    const w1 = await register("worker-1");
    const t = await onboardingTask(a.secret); // pool 6
    const id = t.body.task.id as number;
    const s1 = await api("POST", "/api/submissions", { token: w1.secret, body: { task_id: id, artifact: "HEAD=1 inline" } });
    // A second pending row for the same member, as a race on the
    // "one pending per member" read could produce it.
    const s2 = await env.DB.prepare("INSERT INTO submissions (task_id, member_id, artifact, note, status, created_at) VALUES (?, ?, 'HEAD=2 inline', NULL, 'pending', ?)").bind(id, w1.id, Date.now()).run();
    const s2id = Number(s2.meta.last_row_id);
    const v1 = await api("POST", `/api/submissions/${s1.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "ok here" } });
    expect(v1.status, JSON.stringify(v1.body)).toBe(200);
    const v2 = await api("POST", `/api/submissions/${s2id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "again" } });
    expect(v2.status).toBe(409);
    expect((await api("GET", "/api/me", { token: w1.secret })).body.credits).toBe(102);
    const reject = await api("POST", `/api/submissions/${s2id}/verdict`, { token: a.secret, body: { status: "rejected", reason: "duplicate" } });
    expect(reject.status).toBe(200);
  });

  it("fund racing close conserves the author's credits whichever lands first", async () => {
    const a = await register("alpha");
    const t = await onboardingTask(a.secret); // pool 6, balance 94
    const id = t.body.task.id as number;
    const [close, fund] = await Promise.all([
      api("POST", `/api/tasks/${id}/close`, { token: a.secret }),
      api("POST", `/api/tasks/${id}/fund`, { token: a.secret, body: { credits: 10 } }),
    ]);
    expect(close.status).toBe(200);
    // Either the fund landed first (pool 16, refunded 16) or the close
    // did (refunded 6, fund refused): the author ends at 100 both ways.
    if (fund.status === 200) expect(close.body.refunded_credits).toBe(16);
    else {
      expect(fund.status).toBe(409);
      expect(close.body.refunded_credits).toBe(6);
    }
    expect((await api("GET", "/api/me", { token: a.secret })).body.credits).toBe(100);
    const s = await stats();
    expect(s.credits_total).toBe(100);
    expect(s.credits_escrowed).toBe(0);
    // Sequentially after the close, the fund is refused and moves nothing.
    const late = await api("POST", `/api/tasks/${id}/fund`, { token: a.secret, body: { credits: 10 } });
    expect(late.status).toBe(409);
    expect((await api("GET", "/api/me", { token: a.secret })).body.credits).toBe(100);
  });
});

describe("flag ONBOARDING_TASKS off", () => {
  const off = { ...env, ONBOARDING_TASKS: "off" } as unknown as Env;
  it("refuses the kind and pool fields with 400, 404s /fund, and discloses off", async () => {
    const a = await register("alpha");
    const res = await route(
      off,
      new Request("https://ergonia.test/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.secret}` },
        body: JSON.stringify({ guild: "arena", title: "Tiny task", brief: "Ten chars brief.", condition: goodCondition(), reward_credits: 1, kind: "onboarding", pool_size: 2 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not enabled");
    const fund = await route(off, new Request("https://ergonia.test/api/tasks/1/fund", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(fund.status).toBe(404);
    const official = await route(off, new Request("https://ergonia.test/api/official"));
    expect(((await official.json()) as { features: { onboarding_tasks: { status: string } } }).features.onboarding_tasks).toEqual({ status: "off" });
    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.quotas.tasks_used).toBe(0);
  });
});
