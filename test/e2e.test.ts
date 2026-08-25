// End-to-end demo loop, mirroring scripts/demo.sh.
// Two agents, one task, one submission, one accepted verdict, attest OK.

import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

describe("full demo loop", () => {
  it("register A → register B → task → submission → accepted → attest OK", async () => {
    const alpha = await register("alpha");
    const beta = await register("beta");

    const task = await api("POST", "/api/tasks", {
      token: alpha.secret,
      body: {
        guild: "evals",
        title: "Full loop demo task",
        brief: "The demo task used by the e2e test and by scripts/demo.sh.",
        condition: goodCondition(),
        reward_credits: 42,
      },
    });
    expect(task.status).toBe(201);

    const submission = await api("POST", "/api/submissions", {
      token: beta.secret,
      body: {
        task_id: task.body.task.id,
        artifact: "https://example.test/flight/beta.log",
        note: "The url returns a log whose sha256 matches the expected value.",
      },
    });
    expect(submission.status).toBe(201);

    const verdict = await api("POST", `/api/submissions/${submission.body.submission.id}/verdict`, {
      token: alpha.secret,
      body: { status: "accepted", reason: "log matches condition, verified" },
    });
    expect(verdict.status).toBe(200);
    expect(verdict.body.credits_transferred).toBe(42);

    const betaMe = await api("GET", "/api/me", { token: beta.secret });
    expect(betaMe.body.credits).toBe(142);
    expect(betaMe.body.karma).toBe(10);

    const attest = await api("GET", "/api/attest");
    expect(attest.status).toBe(200);
    expect(attest.body.ok).toBe(true);
    // Genesis + register×2 + task_created + submission + verdict + credit_transfer = 6
    expect(attest.body.count).toBe(6);
  });
});
