import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

describe("tasks", () => {
  it("publishes a task, escrows credits, refuses near-duplicate", async () => {
    const a = await register("alpha");
    const create = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "Verify a KLAX landing",
        brief: "Check that the attached flight file lands at KLAX under 200 fpm.",
        condition: goodCondition(),
        reward_credits: 10,
      },
    });
    expect(create.status).toBe(201);
    const taskId = create.body.task.id;
    expect(taskId).toBeGreaterThan(0);

    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits).toBe(90); // escrowed 10

    const dupe = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "verify a klax landing!!!",
        brief: " check that THE attached flight file lands at KLAX under 200 fpm ",
        condition: goodCondition(),
        reward_credits: 10,
      },
    });
    expect(dupe.status).toBe(409);
  });

  it("rejects an unverifiable condition (no artifact/verb) without consuming quota", async () => {
    const a = await register("alpha");
    const r = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "Write a nice article",
        brief: "Any style, any length, we vibe on quality.",
        condition: "make it a good article",
        reward_credits: 5,
      },
    });
    expect(r.status).toBe(400);
    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits).toBe(100);
    expect(me.body.quotas.tasks_used).toBe(0);
  });

  it("closes an open task with no acceptance and refunds the escrow", async () => {
    const a = await register("alpha");
    const c = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "Task to close",
        brief: "Some description of the closable task, long enough.",
        condition: goodCondition(),
        reward_credits: 20,
      },
    });
    expect(c.status).toBe(201);
    const id = c.body.task.id;

    const close = await api("POST", `/api/tasks/${id}/close`, { token: a.secret });
    expect(close.status).toBe(200);
    expect(close.body.refunded_credits).toBe(20);

    const me = await api("GET", "/api/me", { token: a.secret });
    expect(me.body.credits).toBe(100);
  });

  it("enforces the 3-tasks/day quota", async () => {
    const a = await register("alpha");
    for (let i = 0; i < 3; i++) {
      const r = await api("POST", "/api/tasks", {
        token: a.secret,
        body: {
          guild: "flightsim",
          title: `Task number ${i}`,
          brief: `Description number ${i} for a fresh distinct task.`,
          condition: `The url returns hash matching value_${i}.`,
          reward_credits: 1,
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const over = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "Task number four",
        brief: "Description number four for a fresh distinct task.",
        condition: "The url returns hash matching value_4.",
        reward_credits: 1,
      },
    });
    expect(over.status).toBe(429);
  });
});
