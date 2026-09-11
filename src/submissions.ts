// Submissions and verdicts.
//
//   - POST /api/submissions: submit an artifact against an open task.
//   - POST /api/submissions/:id/verdict: only the task author. Accepted
//     transfers the escrow to the submitter and grants +10 karma.
//     Rejected leaves credits untouched but requires a public reason.
//     The transition itself lives in verdicts.ts, shared with the
//     executable verifiers.
//
// 2026-09-10: a task bound to an executable verifier (tasks.verifier) is
// judged right after its submission event is chained, in this request
// (chain-replay@1) or by a dispatched job (leaderboard-replay@1). An
// onboarding task accepts each member once.

import { appendEvent } from "./chain.js";
import { verifierNameOf, verifiersEnabled } from "./features.js";
import type { PullRequestView } from "./github/api.js";
import { githubIssueForTask } from "./github/issue.js";
import { afterGithubSubmission, validateGithubSubmission } from "./github/verifier.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import { taskById } from "./tasks.js";
import type { AuthContext, Env, SubmissionRow } from "./types.js";
import { error, isNonEmptyString, json, nowMs, readJson } from "./util.js";
import { applyVerdict } from "./verdicts.js";
import { runVerifierAtIntake } from "./verifiers/index.js";

interface CreateSubmissionBody {
  task_id?: unknown;
  artifact?: unknown;
  note?: unknown;
}

export async function handleCreateSubmission(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  const body = await readJson<CreateSubmissionBody>(request);
  if (!body) return error(400, "expected application/json body");
  const taskId = Number(body.task_id);
  const artifact = typeof body.artifact === "string" ? body.artifact.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : null;
  if (!Number.isInteger(taskId) || taskId <= 0) return error(400, "task_id must be a positive integer");
  if (!isNonEmptyString(artifact, 3, 2000)) return error(400, "artifact must be 3-2000 chars");
  if (note !== null && note.length > 2000) return error(400, "note is too long (max 2000 chars)");

  const task = await taskById(env, taskId);
  if (!task) return error(404, "task not found");
  if (task.status === "paused") return error(409, "task is paused (unfunded): its pool cannot pay one more reward until the author funds it");
  if (task.status !== "open") return error(409, `task is ${task.status}`);
  if (task.author_id === ctx.member.id) return error(403, "authors cannot submit to their own tasks");
  if (task.expiry !== null && task.expiry * 1000 < nowMs()) {
    return error(409, "task has expired");
  }

  // One pending submission per member per task avoids trivial spam and
  // makes the verdict UX unambiguous.
  const openOne = await env.DB
    .prepare("SELECT id FROM submissions WHERE task_id = ? AND member_id = ? AND status = 'pending'")
    .bind(taskId, ctx.member.id)
    .first<{ id: number }>();
  if (openOne) return error(409, "you already have a pending submission on this task");

  // An onboarding task is passed once per member: after an acceptance,
  // further submissions are refused (no quota consumed).
  if (task.kind === "onboarding") {
    const passed = await env.DB
      .prepare("SELECT id FROM submissions WHERE task_id = ? AND member_id = ? AND status = 'accepted' LIMIT 1")
      .bind(taskId, ctx.member.id)
      .first<{ id: number }>();
    if (passed) return error(409, `you already passed this task (submission ${passed.id} accepted); an onboarding task is accepted once per member`);
  }

  // GitHub-mirrored task (G1 dogfood): the artifact must be a pull
  // request on the target repository that references the issue. A
  // refusal here is a 400, not a verdict, and consumes no quota. One
  // submission per member per task, ever: updates go to the same PR.
  const gh = await githubIssueForTask(env, taskId);
  let githubPr: PullRequestView | null = null;
  if (gh) {
    const prior = await env.DB
      .prepare("SELECT id FROM submissions WHERE task_id = ? AND member_id = ? LIMIT 1")
      .bind(taskId, ctx.member.id)
      .first<{ id: number }>();
    if (prior) return error(409, "one submission per member on a GitHub task; push to the same pull request instead");
    const intake = await validateGithubSubmission(env, gh, artifact);
    if (!intake.ok) return error(400, intake.error);
    githubPr = intake.pr;
  }

  if (!(await hasQuota(env, ctx.member, "subs"))) {
    return error(429, "daily submission quota exhausted (resets 00:00 UTC)");
  }

  const createdAt = nowMs();
  const inserted = await env.DB
    .prepare(
      `INSERT INTO submissions (task_id, member_id, artifact, note, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(taskId, ctx.member.id, artifact, note, createdAt)
    .run();
  const id = Number(inserted.meta.last_row_id);

  await consumeQuota(env, ctx.member, "subs");
  await appendEvent(env, "submission", {
    submission_id: id,
    task_id: taskId,
    member_id: ctx.member.id,
    handle: ctx.member.handle,
    artifact,
    ...(gh ? { source: "github", github: { repo: gh.repo_full_name, issue_number: gh.issue_number, pull_request: githubPr?.number ?? null, head_sha: githubPr?.head_sha ?? null } } : {}),
  });

  if (gh && githubPr) {
    // The issue comment is best effort: the submission stands even if
    // GitHub refuses the comment; the claim/post/record path in
    // github/issue.ts keeps a retry from posting it twice.
    await afterGithubSubmission(env, gh, id, ctx.member, githubPr);
  }

  // Executable verifier bound to the task: judge now. The submission
  // event above is the anchor of the HEAD window, so this must run
  // after it is chained. A verifier failure leaves the row pending.
  const verifier = verifiersEnabled(env) ? verifierNameOf(task.verifier) : null;
  if (verifier) await runVerifierAtIntake(env, verifier, id);

  return json({ submission: await submissionById(env, id) }, { status: 201 });
}

interface VerdictBody {
  status?: unknown;
  reason?: unknown;
}

export async function handleVerdict(
  env: Env,
  ctx: AuthContext,
  submissionId: number,
  request: Request,
): Promise<Response> {
  const body = await readJson<VerdictBody>(request);
  if (!body) return error(400, "expected application/json body");
  const status = body.status;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (status !== "accepted" && status !== "rejected") {
    return error(400, "status must be 'accepted' or 'rejected'");
  }
  if (!isNonEmptyString(reason, 3, 1000)) {
    return error(400, "reason is required (3-1000 chars) — it is public");
  }

  const submission = await env.DB
    .prepare(
      `SELECT s.id, s.task_id, s.member_id, s.artifact, s.note, s.status,
              s.verdict_reason, s.created_at
         FROM submissions s WHERE s.id = ?`,
    )
    .bind(submissionId)
    .first<SubmissionRow>();
  if (!submission) return error(404, "submission not found");
  if (submission.status !== "pending") return error(409, `submission is already ${submission.status}`);

  const task = await taskById(env, submission.task_id);
  if (!task) return error(404, "parent task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the task author can verdict");
  // A paused onboarding task can still reject (no funds needed) so a
  // pending row is never stranded; accepting needs the pool funded.
  if (task.status === "paused" && status === "accepted") return error(409, "task is paused (unfunded): fund the pool before accepting");
  if (task.status !== "open" && task.status !== "paused") return error(409, `task is ${task.status}`);

  const applied = await applyVerdict(env, task, submission, status, reason);
  if (!applied.ok) return error(409, applied.error);

  const fresh = await submissionById(env, submissionId);
  return json({ submission: fresh, credits_transferred: applied.transferred });
}

// POST /api/submissions/:id/withdraw (flag WITHDRAWALS, 2026-09-11).
//
// The submitter takes its own pending submission back before the task's
// expiry. Chained as submission_withdrawn; no credit moves (a pending
// submission holds none); the one-pending-slot rule sees the slot free
// at once, so an improved entry can follow. A withdrawn submission is
// ignored by every verdict path (they act on pending rows only) and by
// /api/arena. Trigger, verbatim in DECISIONS.md: erpin, comments #40
// (task 9) and #41 (task 13): "the improvement cannot be entered while
// #20 is pending".
export async function handleWithdraw(env: Env, ctx: AuthContext, submissionId: number): Promise<Response> {
  const submission = await env.DB
    .prepare("SELECT id, task_id, member_id, status FROM submissions WHERE id = ?")
    .bind(submissionId)
    .first<{ id: number; task_id: number; member_id: number; status: string }>();
  if (!submission) return error(404, "submission not found");
  if (submission.member_id !== ctx.member.id) return error(403, "only the submitter can withdraw a submission");
  if (submission.status !== "pending") return error(409, `submission is ${submission.status}; only a pending submission can be withdrawn`);
  const task = await taskById(env, submission.task_id);
  if (!task) return error(404, "parent task not found");
  if (task.expiry !== null && task.expiry * 1000 < nowMs()) {
    return error(409, "task has expired; the entry stands for the verdict at expiry");
  }
  if (task.status !== "open" && task.status !== "paused") return error(409, `task is ${task.status}`);

  // One conditional UPDATE: a verdict landing at the same instant wins
  // or loses here, never both.
  const claim = await env.DB
    .prepare("UPDATE submissions SET status = 'withdrawn' WHERE id = ? AND status = 'pending' AND member_id = ?")
    .bind(submissionId, ctx.member.id)
    .run();
  if (!claim.meta.changes) return error(409, "submission is no longer pending");

  await appendEvent(env, "submission_withdrawn", {
    submission_id: submissionId,
    task_id: submission.task_id,
    member_id: ctx.member.id,
    handle: ctx.member.handle,
  });
  return json({ submission: await submissionById(env, submissionId), withdrawn: true });
}

export async function submissionById(env: Env, id: number) {
  return env.DB
    .prepare(
      `SELECT s.id, s.task_id, s.member_id, m.handle AS submitter, s.artifact, s.note,
              s.status, s.verdict_reason, s.created_at
         FROM submissions s JOIN members m ON m.id = s.member_id
         WHERE s.id = ?`,
    )
    .bind(id)
    .first();
}
