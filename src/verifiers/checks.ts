// What an executable verifier observed, recorded twice on purpose: a
// row in verifier_checks (the working memory the next stage reads) and
// a chained verifier_check event with the same evidence (the record a
// stranger can replay). Findings are numbers, booleans, enums and short
// strings; never a verdict by themselves.

import { appendEvent } from "../chain.js";
import type { Env } from "../types.js";
import { canonicalJson, nowMs } from "../util.js";

export type CheckStage = "intake" | "dispatch" | "run";
export type CheckResult =
  | "accepted"
  | "rejected"
  | "provisionally_consistent"
  | "dispatched"
  | "dispatch_failed"
  | "unreadable";

export interface CheckRow {
  id: number;
  submission_id: number;
  verifier: string;
  stage: CheckStage;
  result: CheckResult;
  evidence: string;
  created_at: number;
}

export async function recordCheck(
  env: Env,
  input: { submission_id: number; task_id: number; verifier: string; stage: CheckStage; result: CheckResult; evidence: Record<string, unknown> },
): Promise<number> {
  const createdAt = nowMs();
  const inserted = await env.DB
    .prepare("INSERT INTO verifier_checks (submission_id, verifier, stage, result, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(input.submission_id, input.verifier, input.stage, input.result, canonicalJson(input.evidence), createdAt)
    .run();
  await appendEvent(env, "verifier_check", {
    submission_id: input.submission_id,
    task_id: input.task_id,
    verifier: input.verifier,
    stage: input.stage,
    result: input.result,
    evidence: input.evidence,
  });
  return Number(inserted.meta.last_row_id);
}

export async function latestCheck(env: Env, submissionId: number, verifier: string, stage: CheckStage): Promise<CheckRow | null> {
  return (
    (await env.DB
      .prepare(
        "SELECT id, submission_id, verifier, stage, result, evidence, created_at FROM verifier_checks WHERE submission_id = ? AND verifier = ? AND stage = ? ORDER BY id DESC LIMIT 1",
      )
      .bind(submissionId, verifier, stage)
      .first<CheckRow>()) ?? null
  );
}

export function parseEvidence(row: CheckRow | null): Record<string, unknown> {
  if (!row) return {};
  try {
    const v = JSON.parse(row.evidence);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The chained submission event of a submission: the anchor of the HEAD
// window. Canonical JSON sorts keys, so "submission_id":<id> is always
// followed by the comma before "task_id".
export async function submissionEventId(env: Env, submissionId: number): Promise<number | null> {
  const row = await env.DB
    .prepare("SELECT id FROM events WHERE kind = 'submission' AND payload LIKE ? ORDER BY id ASC LIMIT 1")
    .bind(`%"submission_id":${submissionId},%`)
    .first<{ id: number }>();
  return row?.id ?? null;
}
