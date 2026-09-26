// Routes of the executable verifiers (flag VERIFIERS, off by default):
//
//   GET  /api/verifiers/<name>          the manifest: what is read, how it decides, what it proves
//   POST /api/verifiers/<name>/run      (task author's Bearer) re-run the verifier on a pending
//                                       submission, for the retryable cases (artifact host down,
//                                       dispatch refused)
//   POST /api/verifiers/leaderboard-replay/verdict
//                                       (task author's Bearer) the execution job's report
//
// And the intake hook submissions.ts calls right after the submission
// event is chained. Third parties cannot bind a task to a verifier yet
// (tasks.ts: house-authored only), so every verdict these render is on
// a house account's behalf.

import type { AuthContext, Env } from "../types.js";
import { type VerifierName, verifierBindableBy, verifierId } from "../features.js";
import { error, json, readJson } from "../util.js";
import { CHAIN_REPLAY_MANIFEST, runChainReplay } from "./chain-replay.js";
import { RECORD_REPLAY_MANIFEST, runRecordReplay } from "./record-replay.js";
import { SCHEMA_CHECK_MANIFEST, runSchemaCheck } from "./schema-check.js";
import { loadSubmission, loadTask } from "./common.js";
import { recordCheck, verifierRunsToday } from "./checks.js";
import { LEADERBOARD_REPLAY_MANIFEST, handleRunnerError, handleRunnerVerdict, intakeLeaderboardReplay } from "./leaderboard-replay.js";

export { handleRunnerError, handleRunnerVerdict };

export function handleVerifierManifest(env: Env, name: VerifierName): Response {
  const base =
    name === "chain-replay"
      ? CHAIN_REPLAY_MANIFEST
      : name === "record-replay"
        ? RECORD_REPLAY_MANIFEST
        : name === "schema-check"
          ? SCHEMA_CHECK_MANIFEST
          : LEADERBOARD_REPLAY_MANIFEST;
  // third_party_enabled is a live fact, not a constant: it says whether
  // an author who is not the house can bind THIS verifier right now.
  const bindable = verifierBindableBy(env, name, false);
  return json({
    ...base,
    status: bindable.ok ? "any_author" : "house_authored_tasks_only",
    third_party_enabled: bindable.ok,
    // applies_to is written into the static manifest and would otherwise
    // keep saying "by a house account" after that stopped being true.
    applies_to: bindable.ok
      ? `tasks created with verifier=${verifierId(name)} by any author; the task condition must cite this manifest`
      : `tasks created with verifier=${verifierId(name)} by a house account; the task condition cites this manifest`,
    ...(bindable.ok ? {} : { third_party_refused_because: bindable.reason }),
  });
}

// Called by submissions.ts after the submission event exists. Never
// throws: a verifier failure leaves the submission pending, exactly as
// a human verdict that has not happened yet.
export const VERIFIER_RUNS_PER_TASK_PER_DAY = 200;

export async function runVerifierAtIntake(env: Env, name: VerifierName, submissionId: number): Promise<void> {
  try {
    // Ceiling on how much replay one task can ask of this world in a day.
    // Reaching it leaves the submission pending for a human, which is the
    // same outcome as a verifier that could not read an artifact.
    const sub = await loadSubmission(env, submissionId);
    if (sub) {
      const runs = await verifierRunsToday(env, sub.task_id);
      if (runs >= VERIFIER_RUNS_PER_TASK_PER_DAY) {
        await recordCheck(env, {
          submission_id: submissionId,
          task_id: sub.task_id,
          verifier: verifierId(name),
          stage: "intake",
          result: "unreadable",
          evidence: { reason: "verifier_runs_per_task_per_day_reached", runs, ceiling: VERIFIER_RUNS_PER_TASK_PER_DAY },
        });
        return;
      }
    }
    if (name === "chain-replay") await runChainReplay(env, submissionId);
    else if (name === "record-replay") await runRecordReplay(env, submissionId);
    else if (name === "schema-check") await runSchemaCheck(env, submissionId);
    else await intakeLeaderboardReplay(env, submissionId);
  } catch (e: unknown) {
    console.error(`verifier ${verifierId(name)} failed at intake of submission ${submissionId}`, e instanceof Error ? e.message : String(e));
  }
}

interface RunBody {
  submission_id?: unknown;
}

export async function handleVerifierRun(env: Env, ctx: AuthContext, name: VerifierName, request: Request): Promise<Response> {
  const body = await readJson<RunBody>(request);
  if (!body) return error(400, "expected application/json body");
  const submissionId = Number(body.submission_id);
  if (!Number.isInteger(submissionId) || submissionId <= 0) return error(400, "submission_id must be a positive integer");
  const sub = await loadSubmission(env, submissionId);
  if (!sub) return error(404, "submission not found");
  const task = await loadTask(env, sub.task_id);
  if (!task) return error(404, "parent task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the task author can re-run the verifier");
  if (task.verifier !== verifierId(name)) return error(409, `task is not bound to ${verifierId(name)}`);
  const outcome =
    name === "chain-replay"
      ? await runChainReplay(env, submissionId)
      : name === "record-replay"
        ? await runRecordReplay(env, submissionId)
        : name === "schema-check"
          ? await runSchemaCheck(env, submissionId)
          : await intakeLeaderboardReplay(env, submissionId);
  if (!outcome.ok) return error(outcome.status, outcome.error);
  const fresh = await loadSubmission(env, submissionId);
  return json({ verifier: verifierId(name), result: outcome.result, ...("dispatched" in outcome ? { dispatched: outcome.dispatched } : {}), submission: fresh });
}
