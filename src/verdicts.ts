// The one place a verdict is applied.
//
// Three callers: the task author (POST /api/submissions/:id/verdict), the
// executable verifiers (src/verifiers/*, on the author's behalf) and the
// GitHub dogfood verifier (src/github/verifier.ts keeps its own copy
// because it also closes the GitHub issue row; its tasks are always
// bounties). Every caller goes through the same atomic claim and writes
// the same two events, so the ledger replay in src/verifiers/ledger.ts
// and docs/arena/EVENTS_SCHEMA.md describe every verdict on the chain.
//
// Bounty (the original form): an accepted verdict pays the reward from
// the escrow and closes the task. Onboarding (2026-09-10): an accepted
// verdict pays the fixed reward from the pool and leaves the task open;
// when the pool can no longer pay one reward the task is paused, visibly,
// until the author funds it again. No credit is minted on either path.
//
// ATOMICITY (review of 2026-09-10). Two different pending submissions on
// the same task, judged concurrently, must not both draw on the one
// bounty reward or on a pool that holds one reward. So the claim, the
// resource change (close the bounty, or shrink the pool) and the payout
// run in ONE D1 batch, which is one SQLite transaction, and every
// statement after the claim is conditioned on a claim token this call
// alone knows. A concurrent transaction is serialised behind this one
// and re-evaluates its own claim against the committed state: the
// bounty is closed, or the pool is short, or (onboarding) the member
// was already accepted, and its claim matches zero rows, so none of
// its later statements can match either. Nothing is paid on the basis
// of a check made in an earlier, separate statement.

import { appendEvent } from "./chain.js";
import type { Env, TaskKind, TaskStatus } from "./types.js";
import { KARMA_ON_ACCEPT } from "./types.js";

export interface VerdictTask {
  id: number;
  author_id: number;
  reward_credits: number;
  kind: TaskKind;
}

export interface VerdictSubmission {
  id: number;
  task_id: number;
  member_id: number;
}

export interface VerdictExtras {
  // Set by executable verifiers: who decided, on whose behalf, and what
  // exactly was proven. Absent on a human verdict, so the payload of a
  // human verdict is byte for byte what it was before 2026-09-10.
  actor?: string;
  on_behalf_of?: string;
  evidence?: Record<string, unknown>;
}

export type ApplyResult =
  | { ok: true; transferred: number; event_id: number; task_status: TaskStatus; pool_after: number | null }
  | { ok: false; error: string };

function claimToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

export async function applyVerdict(
  env: Env,
  task: VerdictTask,
  submission: VerdictSubmission,
  status: "accepted" | "rejected",
  reason: string,
  extras: VerdictExtras = {},
): Promise<ApplyResult> {
  const token = claimToken();
  const onboarding = task.kind === "onboarding";
  const reward = task.reward_credits;

  // The claim. A rejection needs no funds and is allowed on a paused
  // onboarding task (a stranded pending row must be rejectable without
  // the author paying to unblock it). An acceptance needs the task open
  // and, for an onboarding task, a pool that can pay and a member not
  // yet accepted on it.
  const claim =
    status === "rejected"
      ? env.DB
          .prepare(
            `UPDATE submissions SET status = 'rejected', verdict_reason = ?, claim_token = ?
               WHERE id = ? AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task_id AND t.status IN ('open', 'paused'))`,
          )
          .bind(reason, token, submission.id)
      : env.DB
          .prepare(
            `UPDATE submissions SET status = 'accepted', verdict_reason = ?, claim_token = ?
               WHERE id = ? AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = submissions.task_id AND t.status = 'open'
                               AND (t.kind != 'onboarding' OR t.pool_credits >= t.reward_credits))
                 AND (? = 0 OR NOT EXISTS (SELECT 1 FROM submissions o WHERE o.task_id = submissions.task_id
                                                AND o.member_id = submissions.member_id AND o.status = 'accepted' AND o.id != submissions.id))`,
          )
          .bind(reason, token, submission.id, onboarding ? 1 : 0);

  const claimed = `EXISTS (SELECT 1 FROM submissions c WHERE c.id = ? AND c.claim_token = ?)`;
  const statements: D1PreparedStatement[] = [claim];
  if (status === "accepted") {
    statements.push(
      onboarding
        ? env.DB
            .prepare(`UPDATE tasks SET pool_credits = pool_credits - ? WHERE id = ? AND status = 'open' AND pool_credits >= ? AND ${claimed}`)
            .bind(reward, task.id, reward, submission.id, token)
        : env.DB.prepare(`UPDATE tasks SET status = 'closed' WHERE id = ? AND status = 'open' AND ${claimed}`).bind(task.id, submission.id, token),
      env.DB
        .prepare(`UPDATE members SET credits = credits + ?, karma = karma + ? WHERE id = ? AND ${claimed}`)
        .bind(reward, KARMA_ON_ACCEPT, submission.member_id, submission.id, token),
    );
    if (onboarding) {
      statements.push(
        env.DB
          .prepare(`UPDATE tasks SET status = 'paused' WHERE id = ? AND status = 'open' AND pool_credits < reward_credits AND ${claimed}`)
          .bind(task.id, submission.id, token),
      );
    }
  }

  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes) {
    return { ok: false, error: "submission is no longer pending (or its task cannot take this verdict now)" };
  }
  if (status === "accepted" && (!results[1]?.meta.changes || !results[2]?.meta.changes)) {
    // Unreachable by construction (same transaction, same preconditions);
    // if it ever prints, the invariant is broken and must be looked at.
    console.error(`verdict claim ${token} on submission ${submission.id} committed without its resource change`);
  }

  let transferred = 0;
  let taskStatus: TaskStatus = onboarding ? "open" : "open";
  let poolAfter: number | null = null;
  if (status === "accepted") {
    transferred = reward;
    if (onboarding) {
      const row = await env.DB.prepare("SELECT pool_credits, status FROM tasks WHERE id = ?").bind(task.id).first<{ pool_credits: number; status: TaskStatus }>();
      poolAfter = row?.pool_credits ?? 0;
      taskStatus = row?.status ?? "open";
    } else {
      taskStatus = "closed";
    }
  } else if (onboarding) {
    const row = await env.DB.prepare("SELECT pool_credits, status FROM tasks WHERE id = ?").bind(task.id).first<{ pool_credits: number; status: TaskStatus }>();
    poolAfter = row?.pool_credits ?? null;
    taskStatus = row?.status ?? "open";
  }

  const verdictEvent = await appendEvent(env, "verdict", {
    submission_id: submission.id,
    task_id: task.id,
    author_id: task.author_id,
    submitter_id: submission.member_id,
    status,
    reason,
    credits_transferred: transferred,
    karma_delta: status === "accepted" ? KARMA_ON_ACCEPT : 0,
    ...(extras.actor ? { actor: extras.actor } : {}),
    ...(extras.on_behalf_of ? { on_behalf_of: extras.on_behalf_of } : {}),
    ...(extras.evidence ? { evidence: extras.evidence } : {}),
    ...(onboarding ? { task_kind: "onboarding", pool_after: poolAfter, task_status: taskStatus } : {}),
  });
  if (status === "accepted") {
    await appendEvent(env, "credit_transfer", {
      from_member_id: task.author_id,
      to_member_id: submission.member_id,
      amount: transferred,
      task_id: task.id,
      submission_id: submission.id,
      reason: "task_reward",
      ...(extras.actor ? { actor: extras.actor } : {}),
    });
  }
  return { ok: true, transferred, event_id: verdictEvent.id, task_status: taskStatus, pool_after: poolAfter };
}
