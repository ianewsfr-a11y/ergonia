// Rejecting a submission left pending when its single-winner task
// closed (flag LATE_REJECTIONS, 2026-09-19). Trigger: erpin's
// submissions #16 and #19 (tasks 4 and 2) stayed pending after the
// bounties closed on 2026-09-13; every verdict answered 409 "task is
// closed" (steward reports, 2026-09-16 to 2026-09-19).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, goodCondition, register } from "./helpers.js";

async function closedTaskWithStranded() {
  const author = await register("alpha");
  const first = await register("beta");
  const second = await register("gamma");
  const t = await api("POST", "/api/tasks", {
    token: author.secret,
    body: { guild: "evals", title: "A single-winner bounty", brief: "One reward, to the first accepted entry.", condition: goodCondition(), reward_credits: 5 },
  });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const taskId = t.body.task.id as number;
  const stranded = await api("POST", "/api/submissions", { token: first.secret, body: { task_id: taskId, artifact: "https://example.com/a.json" } });
  const winner = await api("POST", "/api/submissions", { token: second.secret, body: { task_id: taskId, artifact: "https://example.com/b.json" } });
  const ok = await api("POST", `/api/submissions/${winner.body.submission.id}/verdict`, { token: author.secret, body: { status: "accepted", reason: "meets the condition" } });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect((await api("GET", `/api/tasks/${taskId}`)).body.task.status).toBe("closed");
  return { author, first, taskId, strandedId: stranded.body.submission.id as number };
}

describe("late rejection on a closed single-winner task", () => {
  it("rejects the stranded row, chains it, moves no credit, and still refuses an acceptance", async () => {
    const { author, first, taskId, strandedId } = await closedTaskWithStranded();
    const before = (await api("GET", "/api/stats")).body;

    const accept = await api("POST", `/api/submissions/${strandedId}/verdict`, { token: author.secret, body: { status: "accepted", reason: "second winner" } });
    expect(accept.status).toBe(409);
    expect(accept.body.error).toBe("task is closed");

    const reject = await api("POST", `/api/submissions/${strandedId}/verdict`, { token: author.secret, body: { status: "rejected", reason: "the bounty was already awarded" } });
    expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    expect(reject.body.submission.status).toBe("rejected");
    expect(reject.body.credits_transferred).toBe(0);

    const ev = await api("GET", "/api/events?kind=verdict&limit=1");
    expect(ev.body.events[0].payload.submission_id).toBe(strandedId);
    expect(ev.body.events[0].payload.status).toBe("rejected");
    expect(ev.body.events[0].payload.credits_transferred).toBe(0);

    const after = (await api("GET", "/api/stats")).body;
    expect(after.credits_total).toBe(before.credits_total);
    expect(after.credits_escrowed).toBe(before.credits_escrowed);
    expect((await api("GET", "/api/me", { token: first.secret })).body.credits).toBe(100);
    expect((await api("GET", `/api/tasks/${taskId}`)).body.task.status).toBe("closed");
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);

    const twice = await api("POST", `/api/submissions/${strandedId}/verdict`, { token: author.secret, body: { status: "rejected", reason: "again" } });
    expect(twice.status).toBe(409);
  });

  it("refuses anyone but the author", async () => {
    const { first, strandedId } = await closedTaskWithStranded();
    const r = await api("POST", `/api/submissions/${strandedId}/verdict`, { token: first.secret, body: { status: "rejected", reason: "not mine to judge" } });
    expect(r.status).toBe(403);
  });
});

describe("flag LATE_REJECTIONS off", () => {
  const off = { ...env, LATE_REJECTIONS: "off" } as unknown as Env;
  it("keeps the 409 on a closed task and discloses off", async () => {
    const { author, strandedId } = await closedTaskWithStranded();
    const r = await route(off, new Request(`https://ergonia.test/api/submissions/${strandedId}/verdict`, {
      method: "POST",
      headers: { authorization: `Bearer ${author.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected", reason: "the bounty was already awarded" }),
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("task is closed");
    const official = (await (await route(off, new Request("https://ergonia.test/api/official"))).json()) as { features: { late_rejections: { status: string } } };
    expect(official.features.late_rejections).toEqual({ status: "off" });
  });
});
