// verifier:github-checks@1
//
// Reads a pull request and the check runs on its head commit, decides
// accepted / rejected / pending, and applies the verdict on the task
// author's behalf (the house principal ergonia-bounties). The verdict
// event names the actor, the principal, and an evidence block that
// says exactly what was proven and nothing more: the listed checks
// passed on that commit. It does not claim the issue is fixed.
//
// The rule is fixed at task opening (base branch, required check
// names recorded from the base branch) and cannot be redefined by the
// pull request under verification.

import { BRAND } from "../brand.js";
import { appendEvent } from "../chain.js";
import type { Env, MemberRow, SubmissionRow } from "../types.js";
import { KARMA_ON_ACCEPT } from "../types.js";
import { json, nowMs } from "../util.js";
import {
  GithubApiError,
  getPullRequest,
  listCheckRuns,
  type CheckRunsView,
  type PullRequestView,
} from "./api.js";
import { installationToken } from "./app-auth.js";
import { acceptedComment, rejectedComment, submissionComment } from "./comments.js";
import { COOL_OFF_MS, VERIFIER_ACTOR, VERIFIER_NAME, VERIFIER_VERSION } from "./config.js";
import {
  githubIssueForTask,
  openIssueRowsForRepo,
  postTransitionComment,
  requiredChecksOf,
  type GithubIssueRow,
} from "./issue.js";
import { ensurePrincipal } from "./principal.js";

export const VERIFIER_MANIFEST = {
  verifier: VERIFIER_NAME,
  version: VERIFIER_VERSION,
  status: "house_dogfood",
  third_party_enabled: false,
  read: [
    {
      step: "resolve_pr",
      call: "GET /repos/<repo>/pulls/<n>",
      fields_used: ["state", "merged", "head.sha", "base.ref", "base.repo.full_name", "body"],
    },
    {
      step: "list_checks",
      call: "GET /repos/<repo>/commits/<head.sha>/check-runs",
      fields_used: ["total_count", "check_runs[].name", "check_runs[].status", "check_runs[].conclusion"],
    },
  ],
  decide: {
    accept_if:
      "resolve_pr.base.repo.full_name == task.repo AND resolve_pr.base.ref == task.base_branch AND (resolve_pr.state == 'open' OR resolve_pr.merged == true) AND list_checks.total_count > 0 AND every check_run has status == 'completed' AND conclusion IN ('success','neutral','skipped') AND every name in task.required_checks is present",
    reject_if: "resolve_pr.state == 'closed' AND resolve_pr.merged == false",
    otherwise: "pending",
  },
  trigger: {
    on: ["check_run.completed", "pull_request.synchronize", "pull_request.closed", "pull_request.reopened"],
    cool_off_ms: COOL_OFF_MS,
  },
  proves:
    "That the named check runs completed with the listed conclusions on the observed head commit of a pull request against the expected repository and base branch. Nothing else: a green check set is CI evidence, not a claim that the issue is fixed.",
  actor: VERIFIER_ACTOR,
  on_behalf_of: "ergonia-bounties",
} as const;

export function handleVerifierManifest(): Response {
  return json(VERIFIER_MANIFEST);
}

// ---------------------------------------------------------------------
// Submission intake helpers (used by submissions.ts for GitHub tasks)
// ---------------------------------------------------------------------
export function parsePullRequestUrl(artifact: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(artifact.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isInteger(n) && n > 0 ? { repo: m[1]!, number: n } : null;
}

export function referencesIssue(body: string, repoFullName: string, issueNumber: number): boolean {
  const kw = "(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)";
  const short = new RegExp(`\\b${kw}\\s*:?\\s+#${issueNumber}\\b`, "i");
  const full = new RegExp(
    `\\b${kw}\\s*:?\\s+https://github\\.com/${repoFullName.replace(/[.]/g, "\\.")}/issues/${issueNumber}\\b`,
    "i",
  );
  return short.test(body) || full.test(body);
}

export type IntakeResult = { ok: true; pr: PullRequestView } | { ok: false; error: string };

export async function validateGithubSubmission(env: Env, row: GithubIssueRow, artifact: string): Promise<IntakeResult> {
  const parsed = parsePullRequestUrl(artifact);
  if (!parsed) return { ok: false, error: "artifact must be a github.com pull request URL (https://github.com/<owner>/<repo>/pull/<n>)" };
  if (parsed.repo !== row.repo_full_name) {
    return { ok: false, error: `the pull request must be on ${row.repo_full_name}` };
  }
  let pr: PullRequestView;
  try {
    const token = await installationToken(env, row.installation_id);
    pr = await getPullRequest(env, token, row.repo_full_name, parsed.number);
  } catch (e: unknown) {
    if (e instanceof GithubApiError && e.status === 404) {
      return { ok: false, error: "the pull request does not exist on the target repository" };
    }
    return { ok: false, error: "the pull request could not be read from GitHub right now; try again" };
  }
  if (pr.base_repo_full_name !== row.repo_full_name) {
    return { ok: false, error: `the pull request must target ${row.repo_full_name}` };
  }
  if (!referencesIssue(pr.body, row.repo_full_name, row.issue_number)) {
    return {
      ok: false,
      error: `the pull request body must reference issue #${row.issue_number} with Closes, Fixes or Resolves`,
    };
  }
  return { ok: true, pr };
}

export async function afterGithubSubmission(
  env: Env,
  row: GithubIssueRow,
  submissionId: number,
  member: MemberRow,
  pr: PullRequestView,
): Promise<void> {
  await postTransitionComment(
    env,
    row,
    "submission",
    submissionId,
    submissionComment({
      pr_url: pr.html_url,
      github_login: pr.author_login,
      handle: member.handle,
      member_url: `${BRAND.origin}/api/members/${member.handle}`,
      head_sha: pr.head_sha,
    }),
  );
}

// ---------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------
export interface Evidence {
  verifier: string;
  version: number;
  expected_repository: string;
  repository_matched: boolean;
  expected_pull_request: number;
  pull_request_matched: boolean;
  expected_base_branch: string;
  base_branch_matched: boolean;
  pull_request_state: "open" | "merged" | "closed";
  observed_head_sha: string;
  required_checks_rule: string;
  required_checks: Array<{ name: string; present: boolean; conclusion: string | null }>;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  checks_total: number;
  checks_green: number;
  proves: string;
}

const PASSING = new Set(["success", "neutral", "skipped"]);

export function decide(
  row: GithubIssueRow,
  expectedNumber: number,
  pr: PullRequestView,
  checks: CheckRunsView,
): { verdict: "accepted" | "rejected" | "pending"; evidence: Evidence } {
  const required = requiredChecksOf(row);
  const byName = new Map<string, { status: string; conclusion: string | null }>();
  for (const c of checks.check_runs) byName.set(c.name, { status: c.status, conclusion: c.conclusion });
  const requiredView = required.map((name) => {
    const c = byName.get(name);
    return { name, present: c !== undefined, conclusion: c?.conclusion ?? null };
  });
  const green = checks.check_runs.filter((c) => c.status === "completed" && c.conclusion !== null && PASSING.has(c.conclusion)).length;
  const evidence: Evidence = {
    verifier: VERIFIER_NAME,
    version: VERIFIER_VERSION,
    expected_repository: row.repo_full_name,
    repository_matched: pr.base_repo_full_name === row.repo_full_name,
    expected_pull_request: expectedNumber,
    pull_request_matched: pr.number === expectedNumber,
    expected_base_branch: row.base_branch,
    base_branch_matched: pr.base_ref === row.base_branch,
    pull_request_state: pr.merged ? "merged" : pr.state,
    observed_head_sha: pr.head_sha,
    required_checks_rule:
      required.length > 0
        ? "every check run on the head commit must pass, and the check runs recorded from the base branch at task opening must be present"
        : "every check run on the head commit must pass; at least one check run must exist",
    required_checks: requiredView,
    checks: checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    checks_total: checks.total_count,
    checks_green: green,
    proves: VERIFIER_MANIFEST.proves,
  };

  if (pr.state === "closed" && !pr.merged) return { verdict: "rejected", evidence };
  const allGreen = checks.total_count > 0 && checks.check_runs.length === checks.total_count && green === checks.check_runs.length;
  const requiredPresent = requiredView.every((r) => r.present);
  const accepted =
    evidence.repository_matched &&
    evidence.pull_request_matched &&
    evidence.base_branch_matched &&
    (pr.state === "open" || pr.merged) &&
    allGreen &&
    requiredPresent;
  return { verdict: accepted ? "accepted" : "pending", evidence };
}

function reasonText(verdict: "accepted" | "rejected", e: Evidence): string {
  const flag = (b: boolean): string => (b ? "matched" : "MISMATCH");
  if (verdict === "rejected") {
    return `${VERIFIER_ACTOR}: pull request #${e.expected_pull_request} on ${e.expected_repository} was closed without being merged.`;
  }
  const names = e.checks.map((c) => `${c.name}=${c.conclusion ?? c.status}`).join(", ");
  return (
    `${VERIFIER_ACTOR}: repository ${flag(e.repository_matched)}; pull request #${e.expected_pull_request} ${flag(e.pull_request_matched)}; ` +
    `base branch ${e.expected_base_branch} ${flag(e.base_branch_matched)}; ${e.checks_green}/${e.checks_total} check runs green on ${e.observed_head_sha} (${names}). ` +
    `This proves those checks passed on that commit; it does not by itself prove the issue is fixed.`
  ).slice(0, 1000);
}

// ---------------------------------------------------------------------
// Running the verifier on the pending submissions of a repository
// ---------------------------------------------------------------------
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [300, 900];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const retryable = e instanceof GithubApiError && e.status >= 500;
      if (!retryable || attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

interface PendingRow extends SubmissionRow {
  handle: string;
}

export async function verifyPendingForRepo(
  env: Env,
  repoId: number,
  hint: { prNumber?: number; headSha?: string },
): Promise<Array<{ submission_id: number; verdict: string }>> {
  const out: Array<{ submission_id: number; verdict: string }> = [];
  const rows = await openIssueRowsForRepo(env, repoId);
  for (const row of rows) {
    const pending = await env.DB
      .prepare(
        `SELECT s.id, s.task_id, s.member_id, s.artifact, s.note, s.status, s.verdict_reason, s.created_at, m.handle
           FROM submissions s JOIN members m ON m.id = s.member_id
           WHERE s.task_id = ? AND s.status = 'pending' ORDER BY s.id ASC`,
      )
      .bind(row.task_id)
      .all<PendingRow>();
    for (const sub of pending.results ?? []) {
      const parsed = parsePullRequestUrl(sub.artifact);
      if (!parsed) continue;
      if (hint.prNumber !== undefined && hint.headSha === undefined && parsed.number !== hint.prNumber) continue;
      const r = await verifyOne(env, row, sub, parsed.number, hint.headSha);
      if (r) out.push({ submission_id: sub.id, verdict: r });
      if (r === "accepted") break; // the task closed; remaining pending rows were superseded
    }
  }
  return out;
}

async function verifyOne(
  env: Env,
  row: GithubIssueRow,
  sub: PendingRow,
  prNumber: number,
  headShaHint: string | undefined,
): Promise<"accepted" | "rejected" | "pending" | null> {
  const token = await installationToken(env, row.installation_id);
  const pr = await withRetry(() => getPullRequest(env, token, row.repo_full_name, prNumber));
  if (headShaHint !== undefined && pr.head_sha !== headShaHint) return null; // a check run for another commit
  const snap = await env.DB
    .prepare("SELECT fetched_at FROM github_check_snapshots WHERE submission_id = ? AND head_sha = ?")
    .bind(sub.id, pr.head_sha)
    .first<{ fetched_at: number }>();
  const closedUnmerged = pr.state === "closed" && !pr.merged;
  if (snap && nowMs() - snap.fetched_at < COOL_OFF_MS && !closedUnmerged) return null; // cool-off
  const checks = closedUnmerged
    ? { total_count: 0, check_runs: [], raw_json: "{}" }
    : await withRetry(() => listCheckRuns(env, token, row.repo_full_name, pr.head_sha));
  const { verdict, evidence } = decide(row, prNumber, pr, checks);
  await env.DB
    .prepare(
      `INSERT INTO github_check_snapshots (submission_id, head_sha, fetched_at, verdict_hint, raw_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(submission_id, head_sha) DO UPDATE SET fetched_at = excluded.fetched_at, verdict_hint = excluded.verdict_hint, raw_json = excluded.raw_json`,
    )
    .bind(sub.id, pr.head_sha, nowMs(), verdict === "accepted" ? "green" : verdict === "rejected" ? "red" : "pending", checks.raw_json)
    .run();
  if (verdict === "pending") return "pending";
  const applied = await applyVerdict(env, row, sub, pr, verdict, evidence);
  return applied ? verdict : null;
}

async function applyVerdict(
  env: Env,
  row: GithubIssueRow,
  sub: PendingRow,
  pr: PullRequestView,
  verdict: "accepted" | "rejected",
  evidence: Evidence,
): Promise<boolean> {
  const principal = await ensurePrincipal(env);
  const reason = reasonText(verdict, evidence);
  const task = await env.DB
    .prepare("SELECT id, author_id, reward_credits FROM tasks WHERE id = ?")
    .bind(row.task_id)
    .first<{ id: number; author_id: number; reward_credits: number }>();
  if (!task) return false;

  // Same atomic claim as the human verdict path (submissions.ts).
  const claim = await env.DB
    .prepare(
      `UPDATE submissions SET status = ?, verdict_reason = ?
         WHERE id = ? AND status = 'pending'
           AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task_id AND t.status = 'open')`,
    )
    .bind(verdict, reason, sub.id)
    .run();
  if (!claim.meta.changes) return false;

  let transferred = 0;
  if (verdict === "accepted") {
    transferred = task.reward_credits;
    await env.DB.batch([
      env.DB
        .prepare("UPDATE members SET credits = credits + ?, karma = karma + ? WHERE id = ?")
        .bind(transferred, KARMA_ON_ACCEPT, sub.member_id),
      env.DB.prepare("UPDATE tasks SET status = 'closed' WHERE id = ?").bind(task.id),
      env.DB
        .prepare("UPDATE submissions SET status = 'superseded', verdict_reason = ? WHERE task_id = ? AND status = 'pending'")
        .bind(`superseded by accepted submission ${sub.id}`, task.id),
      env.DB
        .prepare("UPDATE github_issues SET closed_at = ?, close_reason = 'accepted' WHERE id = ? AND closed_at IS NULL")
        .bind(nowMs(), row.id),
    ]);
  }

  const verdictEvent = await appendEvent(env, "verdict", {
    submission_id: sub.id,
    task_id: task.id,
    author_id: principal.id,
    submitter_id: sub.member_id,
    status: verdict,
    reason,
    credits_transferred: transferred,
    karma_delta: verdict === "accepted" ? KARMA_ON_ACCEPT : 0,
    actor: VERIFIER_ACTOR,
    on_behalf_of: principal.handle,
    evidence,
    github: { repo: row.repo_full_name, issue_number: row.issue_number, pull_request: pr.number, head_sha: pr.head_sha },
  });
  if (verdict === "accepted") {
    await appendEvent(env, "credit_transfer", {
      from_member_id: principal.id,
      to_member_id: sub.member_id,
      amount: transferred,
      task_id: task.id,
      submission_id: sub.id,
      reason: "task_reward",
      actor: VERIFIER_ACTOR,
    });
  }

  const verdictUrl = `${BRAND.origin}/api/events?before=${verdictEvent.id + 1}&limit=1`;
  if (verdict === "accepted") {
    await postTransitionComment(
      env,
      row,
      "accepted",
      sub.id,
      acceptedComment({
        reward: transferred,
        github_login: pr.author_login,
        pr_url: pr.html_url,
        head_sha: pr.head_sha,
        verdict_event_url: verdictUrl,
        attest_url: `${BRAND.origin}/api/attest`,
      }),
    );
  } else {
    await postTransitionComment(
      env,
      row,
      "rejected",
      sub.id,
      rejectedComment({ pr_url: pr.html_url, reason: "closed without merge", verdict_event_url: verdictUrl }),
    );
  }
  return true;
}

export { githubIssueForTask };
