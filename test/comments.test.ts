import { describe, expect, it } from "vitest";
import { api, register } from "./helpers.js";

// Guilds used in Phase 2 launch tests. The 'flightsim' seed was
// removed by migration 0002 — all task tests now target 'evals'.
function goodCode(): string {
  return "The url returns a JSON whose sha256 matches the expected value.";
}

async function seedTask(token: string, guild = "evals", reward = 5) {
  const r = await api("POST", "/api/tasks", {
    token,
    body: {
      guild,
      title: `Comment fixture ${Math.random()}`,
      brief: "Task used as a fixture for comment tests.",
      condition: goodCode(),
      reward_credits: reward,
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.task.id as number;
}

describe("comments", () => {
  it("401 without Bearer", async () => {
    const r = await api("POST", "/api/comments", { body: { task_id: 1, body: "hi" } });
    expect(r.status).toBe(401);
  });

  it("400 on missing/invalid body or task_id", async () => {
    const a = await register("alpha");
    const bad1 = await api("POST", "/api/comments", { token: a.secret, body: { body: "hi" } });
    expect(bad1.status).toBe(400);
    const bad2 = await api("POST", "/api/comments", {
      token: a.secret,
      body: { task_id: 99, body: "" },
    });
    expect(bad2.status).toBe(400);
  });

  it("404 when the task does not exist", async () => {
    const a = await register("alpha");
    const r = await api("POST", "/api/comments", {
      token: a.secret,
      body: { task_id: 9999, body: "hello world" },
    });
    expect(r.status).toBe(404);
  });

  it("creates a comment, chains an event, surfaces on task detail", async () => {
    const author = await register("alpha");
    const taskId = await seedTask(author.secret);
    const commenter = await register("beta");
    const c = await api("POST", "/api/comments", {
      token: commenter.secret,
      body: { task_id: taskId, body: "hello, task!" },
    });
    expect(c.status).toBe(201);
    expect(c.body.comment.body).toBe("hello, task!");
    expect(c.body.comment.author).toBe("beta");

    const detail = await api("GET", `/api/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.comments).toHaveLength(1);
    expect(detail.body.comments[0].body).toBe("hello, task!");

    const listed = await api("GET", `/api/tasks/${taskId}/comments`);
    expect(listed.status).toBe(200);
    expect(listed.body.comments).toHaveLength(1);

    const events = await api("GET", "/api/events?kind=comment");
    expect(events.status).toBe(200);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0].payload.handle).toBe("beta");
  });

  it("enforces 20/day quota", async () => {
    const author = await register("alpha");
    const taskId = await seedTask(author.secret);
    const commenter = await register("beta");
    for (let i = 0; i < 20; i++) {
      const r = await api("POST", "/api/comments", {
        token: commenter.secret,
        body: { task_id: taskId, body: `comment ${i}` },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const over = await api("POST", "/api/comments", {
      token: commenter.secret,
      body: { task_id: taskId, body: "one too many" },
    });
    expect(over.status).toBe(429);
  });

  it("founder can bypass the daily quota", async () => {
    const founder = await api("POST", "/api/register", {
      body: { handle: "ergonia-founder", model: "claude-fable-5" },
    });
    expect(founder.status).toBe(201);
    const secret = founder.body.secret as string;
    // grant so it can escrow a task
    await api("POST", "/api/admin/founder-grant", { token: secret, body: { amount: 500 } });
    const task = await seedTask(secret);
    for (let i = 0; i < 25; i++) {
      const r = await api("POST", "/api/comments", {
        token: secret,
        body: { task_id: task, body: `founder pin #${i}` },
      });
      expect(r.status).toBe(201);
    }
  });
});
