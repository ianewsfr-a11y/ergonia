// POST /api/submissions/:id/withdraw (flag WITHDRAWALS, 2026-09-11).
// Trigger: erpin, comments #40 (task 9) and #41 (task 13): the
// one-pending-slot rule kept it from entering an improvement.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, goodCondition, register, registerFounder } from "./helpers.js";

async function arenaTask(token: string, title: string, expiry?: number) {
  const r = await api("POST", "/api/tasks", {
    token,
    body: { guild: "arena", title, brief: "An arena challenge with a score in the note.", condition: goodCondition(), reward_credits: 1, ...(expiry ? { expiry } : {}) },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.task.id as number;
}

describe("POST /api/submissions/:id/withdraw", () => {
  it("withdraws one's own pending submission, chains it, moves no credit, frees the slot", async () => {
    const author = await register("alpha");
    const w = await register("beta");
    const taskId = await arenaTask(author.secret, "Hash hunt", Math.floor(Date.now() / 1000) + 3600);
    const first = await api("POST", "/api/submissions", { token: w.secret, body: { task_id: taskId, artifact: "beta:1", note: "score=21" } });
    expect(first.status).toBe(201);
    const blocked = await api("POST", "/api/submissions", { token: w.secret, body: { task_id: taskId, artifact: "beta:2", note: "score=32" } });
    expect(blocked.status).toBe(409);

    const wd = await api("POST", `/api/submissions/${first.body.submission.id}/withdraw`, { token: w.secret });
    expect(wd.status, JSON.stringify(wd.body)).toBe(200);
    expect(wd.body.withdrawn).toBe(true);
    expect(wd.body.submission.status).toBe("withdrawn");
    const ev = await api("GET", "/api/events?kind=submission_withdrawn&limit=1");
    expect(ev.body.events[0].payload).toEqual({ submission_id: first.body.submission.id, task_id: taskId, member_id: w.id, handle: "beta" });

    const again = await api("POST", "/api/submissions", { token: w.secret, body: { task_id: taskId, artifact: "beta:2", note: "score=32" } });
    expect(again.status).toBe(201);
    expect(again.body.submission.status).toBe("pending");

    const stats = await api("GET", "/api/stats");
    expect(stats.body.credits_total).toBe(200);
    expect(stats.body.credits_escrowed).toBe(1);
    expect((await api("GET", "/api/me", { token: w.secret })).body.credits).toBe(100);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);

    // A withdrawn submission cannot be judged, nor withdrawn twice.
    const verdict = await api("POST", `/api/submissions/${first.body.submission.id}/verdict`, { token: author.secret, body: { status: "accepted", reason: "too late" } });
    expect(verdict.status).toBe(409);
    const twice = await api("POST", `/api/submissions/${first.body.submission.id}/withdraw`, { token: w.secret });
    expect(twice.status).toBe(409);
  });

  it("refuses another member, a judged submission, and an expired task", async () => {
    const author = await register("alpha");
    const w = await register("beta");
    const other = await register("gamma");
    const taskId = await arenaTask(author.secret, "Code golf", Math.floor(Date.now() / 1000) + 3600);
    const sub = await api("POST", "/api/submissions", { token: w.secret, body: { task_id: taskId, artifact: "x=1", note: "score=96" } });
    const id = sub.body.submission.id as number;
    expect((await api("POST", `/api/submissions/${id}/withdraw`, { token: other.secret })).status).toBe(403);
    expect((await api("POST", `/api/submissions/${id}/withdraw`)).status).toBe(401);
    expect((await api("POST", `/api/submissions/9999/withdraw`, { token: w.secret })).status).toBe(404);
    // Expired: the entry stands for the verdict at expiry.
    await env.DB.prepare("UPDATE tasks SET expiry = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 60, taskId).run();
    const late = await api("POST", `/api/submissions/${id}/withdraw`, { token: w.secret });
    expect(late.status).toBe(409);
    expect(late.body.error).toContain("expired");
    // Judged: not pending any more.
    await env.DB.prepare("UPDATE tasks SET expiry = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) + 3600, taskId).run();
    const rej = await api("POST", `/api/submissions/${id}/verdict`, { token: author.secret, body: { status: "rejected", reason: "does not run" } });
    expect(rej.status).toBe(200);
    expect((await api("POST", `/api/submissions/${id}/withdraw`, { token: w.secret })).status).toBe(409);
    expect((await api("GET", "/api/events?kind=submission_withdrawn")).body.events.length).toBe(0);
  });

  it("/api/arena recomputes the provisional best without the withdrawn entry", async () => {
    const founder = await registerFounder();
    // ARENA_META keys challenges by task id; task 13 is the hash hunt (higher wins).
    let id = 0;
    for (let i = 1; i <= 13; i++) id = await arenaTask(founder.secret, `Challenge ${i}`);
    expect(id).toBe(13);
    const a = await register("hunter-a");
    const b = await register("hunter-b");
    const sa = await api("POST", "/api/submissions", { token: a.secret, body: { task_id: 13, artifact: "a:1", note: "score=31" } });
    await api("POST", "/api/submissions", { token: b.secret, body: { task_id: 13, artifact: "b:1", note: "score=29" } });
    const before = (await api("GET", "/api/arena")).body.challenges.find((c: { task_id: number }) => c.task_id === 13);
    expect(before.provisional_best_score).toBe(31);
    expect(before.provisional_best_score_handle).toBe("hunter-a");
    const wd = await api("POST", `/api/submissions/${sa.body.submission.id}/withdraw`, { token: a.secret });
    expect(wd.status).toBe(200);
    const after = (await api("GET", "/api/arena")).body.challenges.find((c: { task_id: number }) => c.task_id === 13);
    expect(after.provisional_best_score).toBe(29);
    expect(after.provisional_best_score_handle).toBe("hunter-b");
    const detail = await api("GET", "/api/tasks/13");
    expect(detail.body.submissions.map((s: { id: number; status: string }) => [s.id, s.status])).toEqual([[2, "pending"], [1, "withdrawn"]]);
  });
});

describe("flag WITHDRAWALS off", () => {
  const off = { ...env, WITHDRAWALS: "off" } as unknown as Env;
  it("404s the route before authentication and discloses off", async () => {
    const r = await route(off, new Request("https://ergonia.test/api/submissions/1/withdraw", { method: "POST" }));
    expect(r.status).toBe(404);
    const official = (await (await route(off, new Request("https://ergonia.test/api/official"))).json()) as { features: { withdrawals: { status: string } } };
    expect(official.features.withdrawals).toEqual({ status: "off" });
    const openapi = (await (await route(off, new Request("https://ergonia.test/openapi.json"))).json()) as { paths: Record<string, unknown> };
    expect(openapi.paths["/api/submissions/{id}/withdraw"]).toBeUndefined();
  });
});
