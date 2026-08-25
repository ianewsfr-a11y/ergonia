// Direct tests of the atomicity primitives introduced by the
// post-phase-2 security review.
//
// HONEST SCOPE OF WHAT THESE TESTS PROVE
// --------------------------------------
// The vitest-pool-workers harness serializes overlapping SELF.fetch
// calls, so no test in this repo reproduces a genuine simultaneous race.
// This was verified, not assumed: each fix was reverted in turn and the
// suite re-run.
//
//   V1/V2 (founder_grant uniqueness) — PROVEN HERE.
//     "a direct second INSERT is rejected by the storage engine" fails
//     when migration 0003's partial UNIQUE index is absent (the INSERT
//     resolves instead of rejecting) and passes when it is present. The
//     guarantee lives in the storage engine, so it holds under any
//     interleaving, on any runtime.
//
//   V5/V6 (verdict / close double-spend) — NOT PROVEN BY ANY TEST.
//     Run sequentially, the old and the new handler are behaviourally
//     identical: both answer 409 on the second call. The difference only
//     appears when two requests are genuinely in flight at once, which
//     this harness cannot produce. Reverting either fix leaves the whole
//     suite green.
//
//     The tests below therefore document the INVARIANT the fix relies on
//     — that the conditional UPDATE moves zero rows once its precondition
//     is false — rather than proving the handler is race-free. A
//     conditional UPDATE is atomic within SQLite regardless of how many
//     callers race it, which is why claiming the transition before
//     touching credits closes the hole; that argument rests on code
//     review, not on these assertions.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, goodCondition, register, registerFounder, TEST_ADMIN_SECRET } from "./helpers.js";

describe("V1/V2 — the chain physically cannot hold two founder_grant events", () => {
  it("a direct second INSERT is rejected by the storage engine", async () => {
    const founder = await registerFounder();
    const g = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 1200 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(g.status).toBe(200);

    // Bypass every application-level check and go straight at the table.
    // The partial UNIQUE index from migration 0003 must refuse this.
    const head = await env.DB
      .prepare("SELECT hash FROM events ORDER BY id DESC LIMIT 1")
      .first<{ hash: string }>();
    await expect(
      env.DB
        .prepare(
          "INSERT INTO events (kind, payload, prev_hash, hash, created_at) VALUES ('founder_grant', ?, ?, ?, ?)",
        )
        .bind('{"amount":99999}', head!.hash, "f".repeat(64), Date.now())
        .run(),
    ).rejects.toThrow();

    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'founder_grant'")
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("the index does not restrict any other event kind", async () => {
    const a = await register("alpha");
    for (let i = 0; i < 3; i++) {
      const r = await api("POST", "/api/tasks", {
        token: a.secret,
        body: {
          guild: "evals",
          title: `Index sanity ${i}`,
          brief: `Confirming multiple task_created events remain legal, ${i}.`,
          condition: goodCondition(),
          reward_credits: 1,
        },
      });
      expect(r.status).toBe(201);
    }
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'task_created'")
      .first<{ n: number }>();
    expect(count!.n).toBe(3);
  });
});

describe("V5 — the verdict transition is a conditional claim", () => {
  it("re-running the claim on an already-judged submission changes 0 rows", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const task = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Claim semantics fixture",
        brief: "Fixture proving the verdict claim is conditional.",
        condition: goodCondition(),
        reward_credits: 50,
      },
    });
    const sub = await api("POST", "/api/submissions", {
      token: b.secret,
      body: { task_id: task.body.task.id, artifact: "https://example.test/claim.log" },
    });
    const subId = sub.body.submission.id as number;

    const v = await api("POST", `/api/submissions/${subId}/verdict`, {
      token: a.secret,
      body: { status: "accepted", reason: "artifact verified against the condition" },
    });
    expect(v.status).toBe(200);

    // The exact statement the handler uses to claim the transition. A
    // second caller — however it got here — must move zero rows, which
    // is what stops it from reaching the payout.
    const replay = await env.DB
      .prepare(
        `UPDATE submissions SET status = ?, verdict_reason = ?
           WHERE id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task_id AND t.status = 'open')`,
      )
      .bind("accepted", "replayed", subId)
      .run();
    expect(replay.meta.changes).toBe(0);

    // And the worker was paid exactly once.
    const worker = await api("GET", "/api/me", { token: b.secret });
    expect(worker.body.credits).toBe(150);
    expect(worker.body.karma).toBe(10);
  });

  it("the claim also refuses when the parent task is no longer open", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const task = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Closed-parent fixture",
        brief: "Fixture proving the claim checks the parent task status.",
        condition: goodCondition(),
        reward_credits: 20,
      },
    });
    const taskId = task.body.task.id as number;
    const sub = await api("POST", "/api/submissions", {
      token: b.secret,
      body: { task_id: taskId, artifact: "https://example.test/closed.log" },
    });
    const subId = sub.body.submission.id as number;

    const close = await api("POST", `/api/tasks/${taskId}/close`, { token: a.secret });
    expect(close.status).toBe(200);

    // Submission is still 'pending', but its task is closed: the claim
    // must refuse, otherwise a refunded escrow could also be paid out.
    const replay = await env.DB
      .prepare(
        `UPDATE submissions SET status = ?, verdict_reason = ?
           WHERE id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task_id AND t.status = 'open')`,
      )
      .bind("accepted", "should not apply", subId)
      .run();
    expect(replay.meta.changes).toBe(0);

    const verdict = await api("POST", `/api/submissions/${subId}/verdict`, {
      token: a.secret,
      body: { status: "accepted", reason: "attempting to pay a refunded escrow" },
    });
    expect(verdict.status).toBe(409);

    const worker = await api("GET", "/api/me", { token: b.secret });
    expect(worker.body.credits, "escrow was refunded, not paid out").toBe(100);
  });
});

describe("V6 — the close transition is a conditional claim", () => {
  it("re-running the claim on an already-closed task changes 0 rows", async () => {
    const a = await register("alpha");
    const task = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Close claim fixture",
        brief: "Fixture proving the close claim is conditional.",
        condition: goodCondition(),
        reward_credits: 40,
      },
    });
    const taskId = task.body.task.id as number;

    const close = await api("POST", `/api/tasks/${taskId}/close`, { token: a.secret });
    expect(close.status).toBe(200);
    expect(close.body.refunded_credits).toBe(40);

    const replay = await env.DB
      .prepare("UPDATE tasks SET status = 'closed' WHERE id = ? AND status = 'open'")
      .bind(taskId)
      .run();
    expect(replay.meta.changes).toBe(0);

    // A second close over HTTP is likewise refused, and refunds nothing.
    const again = await api("POST", `/api/tasks/${taskId}/close`, { token: a.secret });
    expect(again.status).toBe(409);

    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits, "refunded exactly once").toBe(100);
  });
});
