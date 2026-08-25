// Credit-conservation suite: no endpoint may mint or destroy credits.
//
// The invariant, stated once:
//
//   credits_total == 100 * members + sum(founder_grant amounts)
//
// where credits_total = sum(member balances) + escrow of open tasks.
// Every test below asserts it after doing something adversarial.
//
// NOTE ON THE "V5"/"V6" CASES BELOW. They fire overlapping requests with
// Promise.all, but the vitest-pool-workers harness serializes those
// fetches — reverting either fix leaves them green (verified). They are
// conservation smoke tests, NOT proof of race-freedom. See the header of
// test/atomicity.test.ts for what is and is not actually proven.

import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

async function totals() {
  const s = await api("GET", "/api/stats");
  expect(s.status).toBe(200);
  return s.body as {
    members: number;
    credits_circulating: number;
    credits_escrowed: number;
    credits_total: number;
  };
}

// The conservation law: no credit exists that a register or a
// founder_grant did not create.
async function expectConserved(grants = 0) {
  const t = await totals();
  expect(t.credits_circulating + t.credits_escrowed).toBe(t.credits_total);
  expect(t.credits_total).toBe(100 * t.members + grants);
  return t;
}

async function publish(token: string, reward: number, tag: string) {
  const r = await api("POST", "/api/tasks", {
    token,
    body: {
      guild: "evals",
      title: `Credit fixture ${tag}`,
      brief: `Fixture task ${tag} used by the credit-conservation suite.`,
      condition: goodCondition(),
      reward_credits: reward,
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.task.id as number;
}

async function submit(token: string, taskId: number) {
  const r = await api("POST", "/api/submissions", {
    token,
    body: { task_id: taskId, artifact: `https://example.test/${taskId}.log` },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.submission.id as number;
}

describe("credit conservation", () => {
  it("register is the only source of credits at rest", async () => {
    await register("alpha");
    await register("beta");
    await expectConserved();
  });

  it("publishing moves credits from balance to escrow, conserving the total", async () => {
    const a = await register("alpha");
    await publish(a.secret, 30, "escrow");
    const t = await expectConserved();
    expect(t.credits_escrowed).toBe(30);
    expect(t.credits_circulating).toBe(70);
  });

  it("an accepted verdict moves escrow to the worker, conserving the total", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const taskId = await publish(a.secret, 30, "accept");
    const subId = await submit(b.secret, taskId);
    const v = await api("POST", `/api/submissions/${subId}/verdict`, {
      token: a.secret,
      body: { status: "accepted", reason: "artifact verified against the condition" },
    });
    expect(v.status).toBe(200);
    const t = await expectConserved();
    expect(t.credits_escrowed).toBe(0);
    expect(t.credits_circulating).toBe(200);
  });

  it("closing an unaccepted task refunds the escrow, conserving the total", async () => {
    const a = await register("alpha");
    const taskId = await publish(a.secret, 30, "close");
    const c = await api("POST", `/api/tasks/${taskId}/close`, { token: a.secret });
    expect(c.status).toBe(200);
    expect(c.body.refunded_credits).toBe(30);
    const t = await expectConserved();
    expect(t.credits_escrowed).toBe(0);
    expect(t.credits_circulating).toBe(100);
  });

  it("V5 — concurrent verdicts on one submission pay out exactly once", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const taskId = await publish(a.secret, 50, "race-verdict");
    const subId = await submit(b.secret, taskId);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api("POST", `/api/submissions/${subId}/verdict`, {
          token: a.secret,
          body: { status: "accepted", reason: "artifact verified against the condition" },
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok, "exactly one verdict may land").toHaveLength(1);
    expect(ok[0]!.body.credits_transferred).toBe(50);

    const worker = await api("GET", "/api/me", { token: b.secret });
    expect(worker.body.credits, "worker paid once, not six times").toBe(150);
    expect(worker.body.karma, "karma granted once").toBe(10);

    const author = await api("GET", "/api/me", { token: a.secret });
    expect(author.body.credits).toBe(50);

    await expectConserved();
    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);

    // Exactly one verdict + one credit_transfer event were chained.
    const verdicts = await api("GET", "/api/events?kind=verdict");
    expect(verdicts.body.events).toHaveLength(1);
    const transfers = await api("GET", "/api/events?kind=credit_transfer");
    expect(transfers.body.events).toHaveLength(1);
  });

  it("V6 — concurrent closes refund exactly once", async () => {
    const a = await register("alpha");
    const taskId = await publish(a.secret, 40, "race-close");

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api("POST", `/api/tasks/${taskId}/close`, { token: a.secret }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok, "exactly one close may land").toHaveLength(1);
    expect(ok[0]!.body.refunded_credits).toBe(40);

    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits, "refunded once, not six times").toBe(100);

    await expectConserved();
    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);

    const closed = await api("GET", "/api/events?kind=task_closed");
    expect(closed.body.events).toHaveLength(1);
  });

  it("close racing a verdict never pays the escrow twice", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const taskId = await publish(a.secret, 60, "race-both");
    const subId = await submit(b.secret, taskId);

    // Fire the payout and the refund at the same instant. Whichever wins,
    // the escrow must be spent exactly once.
    const [verdict, close] = await Promise.all([
      api("POST", `/api/submissions/${subId}/verdict`, {
        token: a.secret,
        body: { status: "accepted", reason: "artifact verified against the condition" },
      }),
      api("POST", `/api/tasks/${taskId}/close`, { token: a.secret }),
    ]);

    const paid = verdict.status === 200 ? verdict.body.credits_transferred : 0;
    const refunded = close.status === 200 ? close.body.refunded_credits : 0;
    expect(paid + refunded, "the 60-credit escrow leaves escrow exactly once").toBe(60);

    await expectConserved();
    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);
  });

  it("a rejected verdict moves nothing and leaves the escrow locked", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const taskId = await publish(a.secret, 25, "reject");
    const subId = await submit(b.secret, taskId);
    const v = await api("POST", `/api/submissions/${subId}/verdict`, {
      token: a.secret,
      body: { status: "rejected", reason: "artifact does not satisfy the condition" },
    });
    expect(v.status).toBe(200);
    expect(v.body.credits_transferred).toBe(0);

    const worker = await api("GET", "/api/me", { token: b.secret });
    expect(worker.body.credits).toBe(100);
    expect(worker.body.karma).toBe(0);

    const t = await expectConserved();
    expect(t.credits_escrowed, "task stays open, escrow stays locked").toBe(25);
  });

  it("cannot escrow more credits than the author holds", async () => {
    const a = await register("alpha");
    const r = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Overdraft attempt",
        brief: "Trying to escrow more than the balance allows.",
        condition: goodCondition(),
        reward_credits: 500,
      },
    });
    expect(r.status).toBe(402);
    await expectConserved();
  });

  it("concurrent publishes cannot overdraft the author below zero", async () => {
    const a = await register("alpha");
    // Six 40-credit tasks would need 240; the author holds 100. The
    // founder exemption does not apply, so the daily cap of 3 also bites.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api("POST", "/api/tasks", {
          token: a.secret,
          body: {
            guild: "evals",
            title: `Concurrent overdraft ${i}`,
            brief: `Distinct concurrent publish attempt number ${i} for the overdraft test.`,
            condition: `The url returns a JSON whose sha256 matches value_${i}.`,
            reward_credits: 40,
          },
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeLessThanOrEqual(3);

    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits, "balance never goes negative").toBeGreaterThanOrEqual(0);
    await expectConserved();
  });
});
