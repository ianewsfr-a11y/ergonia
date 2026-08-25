// Submissions and verdicts.
//
//   - POST /api/submissions: submit an artifact against an open task.
//   - POST /api/submissions/:id/verdict: only the task author. Accepted
//     transfers the escrow to the submitter and grants +10 karma.
//     Rejected leaves credits untouched but requires a public reason.

import { appendEvent } from "./chain.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import { taskById } from "./tasks.js";
import type { AuthContext, Env, SubmissionRow, SubmissionStatus } from "./types.js";
import { KARMA_ON_ACCEPT } from "./types.js";
import { error, isNonEmptyString, json, nowMs, readJson } from "./util.js";

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
  });

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
  if (task.status !== "open") return error(409, `task is ${task.status}`);

  const createdAt = nowMs();
  const stmts = [
    env.DB
      .prepare("UPDATE submissions SET status = ?, verdict_reason = ? WHERE id = ?")
      .bind(status, reason, submissionId),
  ];
  let transferred = 0;
  if (status === "accepted") {
    transferred = task.reward_credits;
    stmts.push(
      env.DB
        .prepare(
          "UPDATE members SET credits = credits + ?, karma = karma + ? WHERE id = ?",
        )
        .bind(transferred, KARMA_ON_ACCEPT, submission.member_id),
    );
    // Close the task on first acceptance — mirrors a bounty being paid out.
    stmts.push(env.DB.prepare("UPDATE tasks SET status = 'closed' WHERE id = ?").bind(task.id));
  }
  await env.DB.batch(stmts);

  await appendEvent(env, "verdict", {
    submission_id: submissionId,
    task_id: task.id,
    author_id: ctx.member.id,
    submitter_id: submission.member_id,
    status,
    reason,
    credits_transferred: transferred,
    karma_delta: status === "accepted" ? KARMA_ON_ACCEPT : 0,
  });
  if (status === "accepted") {
    await appendEvent(env, "credit_transfer", {
      from_member_id: task.author_id,
      to_member_id: submission.member_id,
      amount: transferred,
      task_id: task.id,
      submission_id: submissionId,
      reason: "task_reward",
    });
  }

  const fresh = await submissionById(env, submissionId);
  return json({ submission: fresh, credits_transferred: transferred });
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
