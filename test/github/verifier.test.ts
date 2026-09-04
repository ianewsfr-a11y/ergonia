// verifier:github-checks@1: submission intake on a GitHub task, the
// decision, the verdict applied on the principal's behalf, and the
// externality metrics staying untouched by a house-to-house loop.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { decide, parsePullRequestUrl, referencesIssue } from "../../src/github/verifier.js";
import type { GithubIssueRow } from "../../src/github/issue.js";
import { api, register } from "../helpers.js";
import {
  REPO,
  checkRunPayload,
  issuesPayload,
  mockCheckRuns,
  mockComment,
  mockGithub,
  mockPull,
  mockPullNotFound,
  pullRequestPayload,
  webhook,
} from "./fixtures.js";

beforeAll(() => mockGithub());

const SHA = "c".repeat(40);

async function openTask(number: number, required: string[] = ["test", "typecheck"]): Promise<number> {
  mockCheckRuns("main", required.map((name) => ({ name })));
  mockComment(number);
  const r = await webhook("issues", issuesPayload("labeled", { number }));
  expect(r.body.outcome, JSON.stringify(r.body)).toMatch(/^opened/);
  const row = await env.DB.prepare("SELECT task_id FROM github_issues WHERE issue_number = ? AND closed_at IS NULL").bind(number).first<{ task_id: number }>();
  return Number(row!.task_id);
}

async function submit(token: string, taskId: number, prNumber: number, issueNumber: number, over: Parameters<typeof mockPull>[1] = {}) {
  mockPull(prNumber, { body: `Fixes #${issueNumber}`, head_sha: SHA, ...over });
  mockComment(issueNumber);
  return api("POST", "/api/submissions", { token, body: { task_id: taskId, artifact: `https://github.com/${REPO.full_name}/pull/${prNumber}` } });
}

describe("pure helpers", () => {
  it("parses only github.com pull request URLs", () => {
    expect(parsePullRequestUrl("https://github.com/a/b/pull/12")).toEqual({ repo: "a/b", number: 12 });
    expect(parsePullRequestUrl("https://github.com/a/b/pull/12/")).toEqual({ repo: "a/b", number: 12 });
    expect(parsePullRequestUrl("https://github.com/a/b/issues/12")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/a/b/pull/12")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/a/b/pull/0")).toBeNull();
  });
  it("recognises the closing keywords GitHub recognises, short and full form", () => {
    expect(referencesIssue("Fixes #7", "a/b", 7)).toBe(true);
    expect(referencesIssue("closes: #7 and more", "a/b", 7)).toBe(true);
    expect(referencesIssue("Resolves https://github.com/a/b/issues/7", "a/b", 7)).toBe(true);
    expect(referencesIssue("Fixes #70", "a/b", 7)).toBe(false);
    expect(referencesIssue("see #7", "a/b", 7)).toBe(false);
    expect(referencesIssue("Fixes https://github.com/a/c/issues/7", "a/b", 7)).toBe(false);
  });

  const row: GithubIssueRow = {
    id: 1, installation_id: 1, repo_id: REPO.id, repo_full_name: REPO.full_name, issue_number: 5,
    issue_url: "", base_branch: "main", required_checks: JSON.stringify(["test"]), task_id: 1,
    delivery_id: "d", opened_at: 0, closed_at: null, close_reason: null,
  };
  const pr = { number: 9, state: "open" as const, merged: false, head_sha: SHA, base_ref: "main", base_repo_full_name: REPO.full_name, head_repo_full_name: REPO.full_name, body: "Fixes #5", author_login: "x", html_url: "" };
  const green = { total_count: 2, check_runs: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "neutral" }], raw_json: "{}" };

  it("accepts an open PR on the right base with every check green and the required one present", () => {
    const d = decide(row, 9, pr, green);
    expect(d.verdict).toBe("accepted");
    expect(d.evidence.repository_matched).toBe(true);
    expect(d.evidence.base_branch_matched).toBe(true);
    expect(d.evidence.required_checks).toEqual([{ name: "test", present: true, conclusion: "success" }]);
    expect(d.evidence.observed_head_sha).toBe(SHA);
    expect(d.evidence.proves).toContain("not a claim that the issue is fixed");
  });
  it("accepts a merged PR the same way", () => {
    expect(decide(row, 9, { ...pr, state: "closed", merged: true }, green).verdict).toBe("accepted");
  });
  it("rejects a PR closed without merge", () => {
    expect(decide(row, 9, { ...pr, state: "closed", merged: false }, green).verdict).toBe("rejected");
  });
  it("stays pending on a red, an incomplete, an empty, or a missing required check", () => {
    expect(decide(row, 9, pr, { ...green, check_runs: [{ name: "test", status: "completed", conclusion: "failure" }, green.check_runs[1]!] }).verdict).toBe("pending");
    expect(decide(row, 9, pr, { ...green, check_runs: [{ name: "test", status: "in_progress", conclusion: null }, green.check_runs[1]!] }).verdict).toBe("pending");
    expect(decide(row, 9, pr, { total_count: 0, check_runs: [], raw_json: "{}" }).verdict).toBe("pending");
    const d = decide(row, 9, pr, { total_count: 1, check_runs: [{ name: "lint", status: "completed", conclusion: "success" }], raw_json: "{}" });
    expect(d.verdict).toBe("pending");
    expect(d.evidence.required_checks[0]!.present).toBe(false);
  });
  it("stays pending on the wrong base branch or the wrong repository, and says which", () => {
    const d1 = decide(row, 9, { ...pr, base_ref: "release" }, green);
    expect(d1.verdict).toBe("pending");
    expect(d1.evidence.base_branch_matched).toBe(false);
    const d2 = decide(row, 9, { ...pr, base_repo_full_name: "someone/fork" }, green);
    expect(d2.evidence.repository_matched).toBe(false);
    expect(d2.verdict).toBe("pending");
  });
});

describe("submission intake on a GitHub task", () => {
  it("refuses a non-PR artifact, a PR on another repository, and a PR that does not reference the issue, without consuming quota", async () => {
    const taskId = await openTask(30);
    const m = await register("gh-worker-two");
    const bad1 = await api("POST", "/api/submissions", { token: m.secret, body: { task_id: taskId, artifact: "https://example.com/x" } });
    expect(bad1.status).toBe(400);
    const bad2 = await api("POST", "/api/submissions", { token: m.secret, body: { task_id: taskId, artifact: "https://github.com/other/repo/pull/1" } });
    expect(bad2.status).toBe(400);
    mockPull(301, { body: "unrelated" });
    const bad3 = await api("POST", "/api/submissions", { token: m.secret, body: { task_id: taskId, artifact: `https://github.com/${REPO.full_name}/pull/301` } });
    expect(bad3.status).toBe(400);
    expect(bad3.body.error).toContain("must reference issue #30");
    mockPullNotFound(302);
    const bad4 = await api("POST", "/api/submissions", { token: m.secret, body: { task_id: taskId, artifact: `https://github.com/${REPO.full_name}/pull/302` } });
    expect(bad4.status).toBe(400);
    const me = await api("GET", "/api/me", { token: m.secret });
    expect(me.body.quotas.subs_used).toBe(0);
  });

  it("accepts a valid PR once per member, chains it with provenance, posts the submission comment", async () => {
    const taskId = await openTask(31);
    const m = await register("gh-worker-three");
    const ok = await submit(m.secret, taskId, 310, 31);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const ev = await api("GET", "/api/events?kind=submission");
    expect(ev.body.events[0].payload.source).toBe("github");
    expect(ev.body.events[0].payload.github.pull_request).toBe(310);
    expect(ev.body.events[0].payload.github.head_sha).toBe(SHA);
    const kinds = (await env.DB.prepare("SELECT kind FROM github_comments ORDER BY id").all<{ kind: string }>()).results?.map((r) => r.kind);
    expect(kinds).toEqual(["opened", "submission"]);
    const again = await submit(m.secret, taskId, 311, 31);
    expect(again.status).toBe(409);
  });
});

describe("the verdict, house to house", () => {
  it("check_run.completed with every check green accepts, pays, closes, chains with evidence, comments once; external metrics stay at zero", async () => {
    const before = await api("GET", "/api/stats");
    const taskId = await openTask(40);
    // ergonia-smith is a house agent: this whole loop is house-to-house.
    const smith = await register("ergonia-smith");
    const sub = await submit(smith.secret, taskId, 400, 40);
    expect(sub.status).toBe(201);

    mockPull(400, { body: "Fixes #40", head_sha: SHA });
    mockCheckRuns(SHA, [{ name: "test" }, { name: "typecheck" }]);
    mockComment(40); // accepted comment
    const r = await webhook("check_run", checkRunPayload(SHA));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe(`verified 1 submission(s): ${sub.body.submission.id}=accepted`);

    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("closed");
    expect(task.body.submissions[0].status).toBe("accepted");
    expect(task.body.submissions[0].verdict_reason).toContain("verifier:github-checks@1");
    expect(task.body.submissions[0].verdict_reason).toContain("2/2 check runs green");
    expect(task.body.submissions[0].verdict_reason).toContain("does not by itself prove the issue is fixed");

    const me = await api("GET", "/api/me", { token: smith.secret });
    expect(me.body.credits).toBe(110);
    expect(me.body.karma).toBe(10);
    const principal = await env.DB.prepare("SELECT credits FROM members WHERE handle = 'ergonia-bounties'").first<{ credits: number }>();
    expect(principal?.credits).toBe(90);

    const verdicts = await api("GET", "/api/events?kind=verdict");
    expect(verdicts.body.events.length).toBe(1);
    const v = verdicts.body.events[0].payload;
    expect(v.status).toBe("accepted");
    expect(v.actor).toBe("verifier:github-checks@1");
    expect(v.on_behalf_of).toBe("ergonia-bounties");
    expect(v.evidence.expected_repository).toBe(REPO.full_name);
    expect(v.evidence.repository_matched).toBe(true);
    expect(v.evidence.pull_request_matched).toBe(true);
    expect(v.evidence.base_branch_matched).toBe(true);
    expect(v.evidence.observed_head_sha).toBe(SHA);
    expect(v.evidence.checks.map((c: { name: string; conclusion: string }) => `${c.name}:${c.conclusion}`)).toEqual(["test:success", "typecheck:success"]);
    expect(v.evidence.required_checks.every((c: { present: boolean }) => c.present)).toBe(true);
    const transfers = await api("GET", "/api/events?kind=credit_transfer");
    expect(transfers.body.events[0].payload.amount).toBe(10);
    expect(transfers.body.events[0].payload.reason).toBe("task_reward");

    const kinds = (await env.DB.prepare("SELECT kind FROM github_comments ORDER BY id").all<{ kind: string }>()).results?.map((r) => r.kind);
    expect(kinds).toEqual(["opened", "submission", "accepted"]);
    const row = await env.DB.prepare("SELECT close_reason FROM github_issues WHERE task_id = ?").bind(taskId).first<{ close_reason: string }>();
    expect(row?.close_reason).toBe("accepted");

    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);

    const after = await api("GET", "/api/stats");
    expect(after.body.verified_work).toBe(before.body.verified_work + 1);
    for (const k of ["external_members", "external_submissions", "external_verified_completions", "cross_member_completions", "external_task_authors"]) {
      expect(after.body[k], k).toBe(before.body[k]);
    }
    expect(after.body.external_definition.excluded_handles).toContain("ergonia-bounties");
    expect(after.body.credits_total).toBe(before.body.credits_total + 200); // two registrations, no minting
  });

  it("a red check leaves the submission pending; a later green (after the cool-off) accepts", async () => {
    const taskId = await openTask(41, ["test"]);
    const w = await register("gh-worker-four");
    const sub = await submit(w.secret, taskId, 410, 41);
    expect(sub.status).toBe(201);
    mockPull(410, { body: "Fixes #41", head_sha: SHA });
    mockCheckRuns(SHA, [{ name: "test", conclusion: "failure" }]);
    const red = await webhook("check_run", checkRunPayload(SHA));
    expect(red.body.outcome).toBe(`verified 1 submission(s): ${sub.body.submission.id}=pending`);
    expect((await api("GET", `/api/tasks/${taskId}`)).body.submissions[0].status).toBe("pending");
    const snap = await env.DB.prepare("SELECT verdict_hint FROM github_check_snapshots WHERE submission_id = ?").bind(sub.body.submission.id).first<{ verdict_hint: string }>();
    expect(snap?.verdict_hint).toBe("pending");

    // Inside the cool-off: nothing is re-read.
    mockPull(410, { body: "Fixes #41", head_sha: SHA });
    const tooSoon = await webhook("check_run", checkRunPayload(SHA));
    expect(tooSoon.body.outcome).toBe("verified 0 submission(s): none");

    await env.DB.prepare("UPDATE github_check_snapshots SET fetched_at = fetched_at - 60000").run();
    mockPull(410, { body: "Fixes #41", head_sha: SHA });
    mockCheckRuns(SHA, [{ name: "test", conclusion: "success" }]);
    mockComment(41);
    const green = await webhook("check_run", checkRunPayload(SHA));
    expect(green.body.outcome).toBe(`verified 1 submission(s): ${sub.body.submission.id}=accepted`);
  });

  it("a check_run on another commit is ignored for this submission", async () => {
    const taskId = await openTask(42, ["test"]);
    const w = await register("gh-worker-five");
    await submit(w.secret, taskId, 420, 42);
    mockPull(420, { body: "Fixes #42", head_sha: SHA });
    const r = await webhook("check_run", checkRunPayload("d".repeat(40)));
    expect(r.body.outcome).toBe("verified 0 submission(s): none");
  });

  it("a pull request closed without merge is rejected, the task stays open, one rejected comment", async () => {
    const taskId = await openTask(43, ["test"]);
    const w = await register("gh-worker-six");
    const sub = await submit(w.secret, taskId, 430, 43);
    mockPull(430, { body: "Fixes #43", head_sha: SHA, state: "closed", merged: false });
    mockComment(43);
    const r = await webhook("pull_request", pullRequestPayload("closed", 430));
    expect(r.body.outcome).toBe(`verified 1 submission(s): ${sub.body.submission.id}=rejected`);
    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("open");
    expect(task.body.submissions[0].status).toBe("rejected");
    const me = await api("GET", "/api/me", { token: w.secret });
    expect(me.body.credits).toBe(100);
    const kinds = (await env.DB.prepare("SELECT kind FROM github_comments ORDER BY id").all<{ kind: string }>()).results?.map((r) => r.kind);
    expect(kinds).toEqual(["opened", "submission", "rejected"]);
  });

  it("a missing required check keeps the submission pending even when every present check is green", async () => {
    const taskId = await openTask(44, ["test", "typecheck"]);
    const w = await register("gh-worker-seven");
    const sub = await submit(w.secret, taskId, 440, 44);
    mockPull(440, { body: "Fixes #44", head_sha: SHA });
    mockCheckRuns(SHA, [{ name: "test" }]);
    const r = await webhook("check_run", checkRunPayload(SHA));
    expect(r.body.outcome).toBe(`verified 1 submission(s): ${sub.body.submission.id}=pending`);
  });

  it("two submissions: the first green wins, the other is superseded", async () => {
    const taskId = await openTask(45, ["test"]);
    const a = await register("gh-worker-eight");
    const b = await register("gh-worker-nine");
    const sa = await submit(a.secret, taskId, 450, 45);
    const sb = await submit(b.secret, taskId, 451, 45);
    expect(sa.status).toBe(201);
    expect(sb.status).toBe(201);
    mockPull(450, { body: "Fixes #45", head_sha: SHA });
    mockCheckRuns(SHA, [{ name: "test" }]);
    mockComment(45);
    const r = await webhook("check_run", checkRunPayload(SHA));
    expect(r.body.outcome).toBe(`verified 1 submission(s): ${sa.body.submission.id}=accepted`);
    const task = await api("GET", `/api/tasks/${taskId}`);
    const byId = Object.fromEntries(task.body.submissions.map((s: { id: number; status: string }) => [s.id, s.status]));
    expect(byId[sa.body.submission.id]).toBe("accepted");
    expect(byId[sb.body.submission.id]).toBe("superseded");
  });
});
