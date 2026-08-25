import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

async function seedTask(token: string, reward = 25) {
  const r = await api("POST", "/api/tasks", {
    token,
    body: {
      guild: "evals",
      title: "Verify smooth landing",
      brief: "Author expects the flight log to show a landing under 200 fpm.",
      condition: goodCondition(),
      reward_credits: reward,
    },
  });
  expect(r.status).toBe(201);
  return r.body.task.id as number;
}

describe("submissions + verdicts", () => {
  it("accepts a submission, transfers credits + karma on 'accepted'", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    const taskId = await seedTask(author.secret, 25);

    const sub = await api("POST", "/api/submissions", {
      token: worker.secret,
      body: { task_id: taskId, artifact: "https://example.test/flight/1.log", note: "sha256 matches" },
    });
    expect(sub.status).toBe(201);
    const subId = sub.body.submission.id;

    const verdict = await api("POST", `/api/submissions/${subId}/verdict`, {
      token: author.secret,
      body: { status: "accepted", reason: "log verified under 200 fpm" },
    });
    expect(verdict.status).toBe(200);
    expect(verdict.body.credits_transferred).toBe(25);

    const workerMe = await api("GET", "/api/me", { token: worker.secret });
    expect(workerMe.body.credits).toBe(125);
    expect(workerMe.body.karma).toBe(10);

    const authorMe = await api("GET", "/api/me", { token: author.secret });
    // 100 - 25 escrowed = 75 (transferred, not refunded)
    expect(authorMe.body.credits).toBe(75);

    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("closed");
  });

  it("refuses verdict from a non-author", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    const stranger = await register("gamma");
    const taskId = await seedTask(author.secret, 5);
    const sub = await api("POST", "/api/submissions", {
      token: worker.secret,
      body: { task_id: taskId, artifact: "https://example.test/a.log" },
    });
    const r = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, {
      token: stranger.secret,
      body: { status: "accepted", reason: "looks nice to me" },
    });
    expect(r.status).toBe(403);
  });

  it("author cannot submit to their own task", async () => {
    const author = await register("alpha");
    const taskId = await seedTask(author.secret, 5);
    const r = await api("POST", "/api/submissions", {
      token: author.secret,
      body: { task_id: taskId, artifact: "https://example.test/a.log" },
    });
    expect(r.status).toBe(403);
  });

  it("rejected verdict leaves credits alone and requires a public reason", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    const taskId = await seedTask(author.secret, 30);
    const sub = await api("POST", "/api/submissions", {
      token: worker.secret,
      body: { task_id: taskId, artifact: "https://example.test/wrong.log" },
    });
    const noReason = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, {
      token: author.secret,
      body: { status: "rejected", reason: "" },
    });
    expect(noReason.status).toBe(400);

    const withReason = await api("POST", `/api/submissions/${sub.body.submission.id}/verdict`, {
      token: author.secret,
      body: { status: "rejected", reason: "log shows 400 fpm, condition fails" },
    });
    expect(withReason.status).toBe(200);
    expect(withReason.body.credits_transferred).toBe(0);

    const workerMe = await api("GET", "/api/me", { token: worker.secret });
    expect(workerMe.body.credits).toBe(100);
    expect(workerMe.body.karma).toBe(0);
  });
});
