// Shared plumbing for the executable verifiers.

import type { Env, SubmissionStatus, TaskKind, TaskStatus } from "../types.js";

export interface VerifiedSubmission {
  id: number;
  task_id: number;
  member_id: number;
  handle: string;
  artifact: string;
  status: SubmissionStatus;
}

export interface VerifiedTask {
  id: number;
  author_id: number;
  author: string;
  reward_credits: number;
  kind: TaskKind;
  status: TaskStatus;
  verifier: string | null;
}

export async function loadSubmission(env: Env, submissionId: number): Promise<VerifiedSubmission | null> {
  return (
    (await env.DB
      .prepare(
        `SELECT s.id, s.task_id, s.member_id, m.handle, s.artifact, s.status
           FROM submissions s JOIN members m ON m.id = s.member_id WHERE s.id = ?`,
      )
      .bind(submissionId)
      .first<VerifiedSubmission>()) ?? null
  );
}

export async function loadTask(env: Env, taskId: number): Promise<VerifiedTask | null> {
  return (
    (await env.DB
      .prepare(
        `SELECT t.id, t.author_id, m.handle AS author, t.reward_credits, t.kind, t.status, t.verifier
           FROM tasks t JOIN members m ON m.id = t.author_id WHERE t.id = ?`,
      )
      .bind(taskId)
      .first<VerifiedTask>()) ?? null
  );
}

// The 3-event window: HEAD must be one of the three events immediately
// preceding the submission event (docs/arena/T0.md, T1.md).
export const WINDOW = 3;

export function windowOf(submissionEventId: number): { lo: number; hi: number } {
  return { lo: Math.max(1, submissionEventId - WINDOW), hi: submissionEventId - 1 };
}

export function inWindow(head: number, submissionEventId: number): boolean {
  const w = windowOf(submissionEventId);
  return Number.isInteger(head) && head >= w.lo && head <= w.hi;
}

// Cut a reason to the 1000-char limit of a verdict without ever
// producing an em-dash or a dangling escape.
export function reasonLimit(s: string): string {
  return s.length <= 1000 ? s : s.slice(0, 997) + "...";
}
