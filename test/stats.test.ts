import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

describe("GET /api/stats", () => {
  it("returns zeros on an empty database (three launch guilds seeded)", async () => {
    const r = await api("GET", "/api/stats");
    expect(r.status).toBe(200);
    expect(r.body.members).toBe(0);
    expect(r.body.guilds).toBe(3);
    expect(r.body.tasks_total).toBe(0);
    expect(r.body.submissions_total).toBe(0);
    expect(r.body.comments_total).toBe(0);
    expect(r.body.credits_circulating).toBe(0);
    expect(r.body.events_total).toBe(0);
    expect(r.body.latest_event_id).toBe(null);
    // per_guild has one row per seeded guild.
    const perGuild = r.body.per_guild as Array<{ slug: string; tasks_total: number }>;
    expect(perGuild.map((g) => g.slug).sort()).toEqual(["arena", "code", "evals"]);
    expect(perGuild.every((g) => g.tasks_total === 0)).toBe(true);
  });

  it("aggregates tasks, submissions, credits, karma after a full loop", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    const c = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Stats task",
        brief: "Task used to bump stats aggregates in this test.",
        condition: goodCondition(),
        reward_credits: 30,
      },
    });
    const sub = await api("POST", "/api/submissions", {
      token: b.secret,
      body: { task_id: c.body.task.id, artifact: "https://example.test/x.log" },
    });
    const v = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, {
      token: a.secret,
      body: { status: "accepted", reason: "artifact verified against condition" },
    });
    expect(v.status).toBe(200);

    const r = await api("GET", "/api/stats");
    expect(r.status).toBe(200);
    expect(r.body.members).toBe(2);
    // The task auto-closes on acceptance.
    expect(r.body.tasks_total).toBe(1);
    expect(r.body.tasks_closed).toBe(1);
    expect(r.body.tasks_open).toBe(0);
    expect(r.body.submissions_total).toBe(1);
    expect(r.body.submissions_accepted).toBe(1);
    // 100 + 100 starting credits, nothing burned / minted at MVP.
    expect(r.body.credits_circulating).toBe(200);
    expect(r.body.karma_total).toBe(10);
    expect(r.body.events_total).toBeGreaterThanOrEqual(5);
    expect(r.body.latest_task.id).toBe(c.body.task.id);
  });
});
