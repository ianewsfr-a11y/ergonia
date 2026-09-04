// G1 GitHub integration, house dogfood: the webhook gates and the
// label -> task -> close path. Fail-closed behaviour is asserted first.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { route } from "../../src/router.js";
import type { Env } from "../../src/types.js";
import { api } from "../helpers.js";
import {
  INSTALLATION_ID,
  REPO,
  checkRunPayload,
  installationPayload,
  issuesPayload,
  mockCheckRuns,
  mockComment,
  mockCommentFails,
  mockGithub,
  newDelivery,
  repoObj,
  sign,
  webhook,
} from "./fixtures.js";

beforeAll(() => mockGithub());

async function principal() {
  return env.DB.prepare("SELECT id, credits FROM members WHERE handle = 'ergonia-bounties'").first<{ id: number; credits: number }>();
}
async function openIssueRows() {
  const rs = await env.DB.prepare("SELECT * FROM github_issues WHERE closed_at IS NULL").all();
  return rs.results ?? [];
}

describe("fail closed: flag off", () => {
  const off = { ...env, GITHUB_INTEGRATION: "off" } as unknown as Env;
  for (const [method, path] of [
    ["POST", "/api/github/webhook"],
    ["GET", "/api/verifiers/github-checks"],
    ["POST", "/api/github/fund"],
  ] as const) {
    it(`${method} ${path} is 404 like any unknown route`, async () => {
      const res = await route(off, new Request(`https://ergonia.test${path}`, { method }));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(`no route for ${method} ${path}`);
    });
  }
  it("/api/official does not mention the integration when off", async () => {
    const res = await route(off, new Request("https://ergonia.test/api/official"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.github_integration).toBeUndefined();
  });
});

describe("webhook integrity", () => {
  it("rejects a missing signature with 401 and writes nothing", async () => {
    const r = await webhook("ping", { zen: "x" }, { signature: null });
    expect(r.status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM github_deliveries").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
  it("rejects a wrong signature with 401", async () => {
    const r = await webhook("ping", { zen: "x" }, { secret: "not-the-secret" });
    expect(r.status).toBe(401);
  });
  it("rejects a malformed signature header with 401", async () => {
    const r = await webhook("ping", { zen: "x" }, { signature: "sha1=abc" });
    expect(r.status).toBe(401);
  });
  it("answers ping", async () => {
    const r = await webhook("ping", { zen: "Keep it logically awesome." });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("pong");
  });
  it("requires event and delivery headers", async () => {
    const raw = JSON.stringify({ zen: "x" });
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("https://ergonia.test/api/github/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(400);
  });
});

describe("allowlist: nothing outside the two dogfood repositories creates state", () => {
  it("ignores a labelled issue on a repository with a foreign id, without a delivery row", async () => {
    const r = await webhook("issues", issuesPayload("labeled", { number: 1 }, "ergonia-bounty", repoObj({ id: 999, full_name: "someone/else" })));
    expect(r.status).toBe(202);
    expect(r.body.outcome).toBe("ignored");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM github_deliveries").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n).toBe(0);
  });
  it("ignores an allowlisted id under a different name (renamed or spoofed)", async () => {
    const r = await webhook("issues", issuesPayload("labeled", { number: 1 }, "ergonia-bounty", repoObj({ full_name: "ianewsfr-a11y/renamed" })));
    expect(r.status).toBe(202);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n).toBe(0);
  });
  it("ignores an allowlisted name under a different id", async () => {
    const r = await webhook("issues", issuesPayload("labeled", { number: 1 }, "ergonia-bounty", repoObj({ id: 42 })));
    expect(r.status).toBe(202);
  });
  it("ignores an installation by another account", async () => {
    const r = await webhook("installation", installationPayload("created", { id: 1, login: "stranger", type: "User" }));
    expect(r.status).toBe(202);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM github_installations").first<{ n: number }>())?.n).toBe(0);
  });
  it("records an installation by the allowlisted owner, chained", async () => {
    const r = await webhook("installation", installationPayload("created"));
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT installation_id, account_id FROM github_installations").first<{ installation_id: number; account_id: number }>();
    expect(row?.installation_id).toBe(INSTALLATION_ID);
    expect(row?.account_id).toBe(278779481);
    const ev = await api("GET", "/api/events?kind=github_installation");
    expect(ev.body.events.length).toBe(1);
  });
});

describe("label -> task", () => {
  it("opens one task in the code guild, escrowed from the principal, with provenance and one comment", async () => {
    mockCheckRuns("main", [{ name: "test" }, { name: "typecheck" }]);
    mockComment(12);
    const r = await webhook("issues", issuesPayload("labeled", { number: 12, title: "Door lists a dead link", body: "The door lists /x which 404s." }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toMatch(/^opened: task \d+$/);

    const p = await principal();
    expect(p).not.toBeNull();
    expect(p!.credits).toBe(100 - 10);

    const tasks = await api("GET", "/api/tasks?guild=code");
    expect(tasks.body.tasks.length).toBe(1);
    const task = tasks.body.tasks[0];
    expect(task.author).toBe("ergonia-bounties");
    expect(task.title).toBe("Door lists a dead link");
    expect(task.reward_credits).toBe(10);
    expect(task.condition).toContain(`https://api.github.com/repos/${REPO.full_name}/commits/<sha>/check-runs`);
    expect(task.condition).toContain('"test"');
    expect(task.condition).toContain('"typecheck"');
    expect(task.brief).toContain("The door lists /x which 404s.");
    expect(task.brief).toContain("not a claim that the issue is fixed");

    const rows = await openIssueRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.repo_id).toBe(REPO.id);
    expect(rows[0]!.issue_number).toBe(12);
    expect(rows[0]!.base_branch).toBe("main");
    expect(JSON.parse(rows[0]!.required_checks as string)).toEqual(["test", "typecheck"]);
    expect(typeof rows[0]!.delivery_id).toBe("string");

    const created = await api("GET", "/api/events?kind=task_created");
    expect(created.body.events.length).toBe(1);
    const payload = created.body.events[0].payload;
    expect(payload.source).toBe("github");
    expect(payload.github.repo).toBe(REPO.full_name);
    expect(payload.github.repo_id).toBe(REPO.id);
    expect(payload.github.issue_number).toBe(12);
    expect(payload.github.delivery_id).toBe(rows[0]!.delivery_id);
    expect(payload.verdict_by).toBe("verifier:github-checks@1");

    const comments = await api("GET", "/api/events?kind=github_comment");
    expect(comments.body.events.length).toBe(1);
    expect(comments.body.events[0].payload.kind).toBe("opened");
    const rec = await env.DB.prepare("SELECT kind, github_comment_id FROM github_comments").all<{ kind: string; github_comment_id: number }>();
    expect(rec.results?.length).toBe(1);
    expect(rec.results?.[0]?.github_comment_id).toBeGreaterThan(0);

    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);
  });

  it("a repeated delivery id is a no-op (no second task, no second comment)", async () => {
    mockCheckRuns("main", [{ name: "test" }]);
    mockComment(13);
    const delivery = newDelivery();
    const first = await webhook("issues", issuesPayload("labeled", { number: 13 }), { delivery });
    expect(first.status).toBe(200);
    const again = await webhook("issues", issuesPayload("labeled", { number: 13 }), { delivery });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("duplicate");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM github_comments").first<{ n: number }>())?.n).toBe(1);
  });

  it("the same label event under a new delivery id does not open a second task", async () => {
    mockCheckRuns("main", [{ name: "test" }]);
    mockComment(14);
    const first = await webhook("issues", issuesPayload("labeled", { number: 14 }));
    expect(first.body.outcome).toMatch(/^opened/);
    const again = await webhook("issues", issuesPayload("labeled", { number: 14 }));
    expect(again.status).toBe(200);
    expect(again.body.outcome).toMatch(/^already_open/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM github_comments").first<{ n: number }>())?.n).toBe(1);
    expect((await principal())?.credits).toBe(90);
  });

  it("a comment that GitHub refuses is retried on the next delivery, never doubled", async () => {
    mockCheckRuns("main", [{ name: "test" }]);
    mockCommentFails(15);
    const first = await webhook("issues", issuesPayload("labeled", { number: 15 }));
    expect(first.status).toBe(200);
    expect(first.body.outcome).toMatch(/^opened/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM github_comments").first<{ n: number }>())?.n).toBe(0);
    mockComment(15);
    const again = await webhook("issues", issuesPayload("labeled", { number: 15 }));
    expect(again.body.outcome).toMatch(/^already_open/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM github_comments").first<{ n: number }>())?.n).toBe(1);
  });

  it("a similar-but-different label is a no-op", async () => {
    const r = await webhook("issues", issuesPayload("labeled", { number: 16 }, "Ergonia-Bounty"));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toMatch(/^ignored/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first<{ n: number }>())?.n).toBe(0);
  });

  it("a labelled pull request (not an issue) is a no-op", async () => {
    const p = issuesPayload("labeled", { number: 17 }) as Record<string, unknown>;
    (p.issue as Record<string, unknown>).pull_request = { url: "https://api.github.com/x" };
    const r = await webhook("issues", p);
    expect(r.body.outcome).toMatch(/^ignored/);
  });

  it("without any check run on the base branch the task still opens, with the at-least-one rule", async () => {
    mockCheckRuns("main", []);
    mockComment(18);
    const r = await webhook("issues", issuesPayload("labeled", { number: 18 }));
    expect(r.body.outcome).toMatch(/^opened/);
    const tasks = await api("GET", "/api/tasks?guild=code");
    expect(tasks.body.tasks[0].condition).toContain("A head commit with zero check runs does not pass");
    expect(tasks.body.tasks[0].condition).not.toContain("recorded from main");
  });
});

describe("label removed / issue closed", () => {
  async function openOne(number: number) {
    mockCheckRuns("main", [{ name: "test" }]);
    mockComment(number);
    const r = await webhook("issues", issuesPayload("labeled", { number }));
    expect(r.body.outcome).toMatch(/^opened/);
    const rows = await openIssueRows();
    return Number(rows[0]!.task_id);
  }

  it("unlabel closes the task, refunds the escrow, supersedes pending submissions, posts one comment", async () => {
    const taskId = await openOne(20);
    // A member submission that will be superseded (intake mocked as valid).
    const { register } = await import("../helpers.js");
    const m = await register("gh-worker-one");
    const { mockPull } = await import("./fixtures.js");
    mockPull(201, { body: "Fixes #20" });
    mockComment(20); // submission comment
    const sub = await api("POST", "/api/submissions", { token: m.secret, body: { task_id: taskId, artifact: `https://github.com/${REPO.full_name}/pull/201` } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    mockComment(20); // label-removed comment
    const r = await webhook("issues", issuesPayload("unlabeled", { number: 20 }));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toMatch(/^label_removed: task \d+ closed; refunded 10$/);
    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("closed");
    expect(task.body.submissions[0].status).toBe("superseded");
    expect((await principal())?.credits).toBe(100);
    const me = await api("GET", "/api/me", { token: m.secret });
    expect(me.body.credits).toBe(100);
    const kinds = (await env.DB.prepare("SELECT kind FROM github_comments ORDER BY id").all<{ kind: string }>()).results?.map((r) => r.kind);
    expect(kinds).toEqual(["opened", "submission", "label_removed"]);
    expect((await openIssueRows()).length).toBe(0);
    const closed = await api("GET", "/api/events?kind=task_closed");
    expect(closed.body.events[0].payload.close_reason).toBe("label_removed");
    expect(closed.body.events[0].payload.refunded_credits).toBe(10);
  });

  it("unlabel with no open task is a no-op", async () => {
    const r = await webhook("issues", issuesPayload("unlabeled", { number: 21 }));
    expect(r.body.outcome).toMatch(/^ignored: no open task/);
  });

  it("closing the issue closes the task the same way", async () => {
    const taskId = await openOne(22);
    mockComment(22);
    const r = await webhook("issues", issuesPayload("closed", { number: 22 }));
    expect(r.body.outcome).toMatch(/^issue_closed/);
    expect((await api("GET", `/api/tasks/${taskId}`)).body.task.status).toBe("closed");
  });

  it("re-adding the label after a close opens a fresh task with a new id", async () => {
    const first = await openOne(23);
    mockComment(23);
    await webhook("issues", issuesPayload("unlabeled", { number: 23 }));
    mockCheckRuns("main", [{ name: "test" }]);
    mockComment(23);
    const r = await webhook("issues", issuesPayload("labeled", { number: 23 }));
    expect(r.body.outcome).toMatch(/^opened/);
    const rows = await openIssueRows();
    expect(Number(rows[0]!.task_id)).toBeGreaterThan(first);
  });

  it("installation.deleted closes every open task on it without commenting", async () => {
    const a = await openOne(24);
    const r = await webhook("installation", installationPayload("deleted"));
    expect(r.status).toBe(200);
    expect((await api("GET", `/api/tasks/${a}`)).body.task.status).toBe("closed");
    const kinds = (await env.DB.prepare("SELECT kind FROM github_comments").all<{ kind: string }>()).results?.map((r) => r.kind);
    expect(kinds).toEqual(["opened"]);
  });

  it("a check_run for a repository with no pending submission verifies nothing", async () => {
    await openOne(25);
    const r = await webhook("check_run", checkRunPayload("b".repeat(40)));
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("verified 0 submission(s): none");
  });
});
