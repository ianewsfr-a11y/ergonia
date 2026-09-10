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
import { type VerifierName, verifierId } from "../features.js";
import { error, json, readJson } from "../util.js";
import { CHAIN_REPLAY_MANIFEST, runChainReplay } from "./chain-replay.js";
import { loadSubmission, loadTask } from "./common.js";
import { LEADERBOARD_REPLAY_MANIFEST, handleRunnerVerdict, intakeLeaderboardReplay } from "./leaderboard-replay.js";

export { handleRunnerVerdict };

export function handleVerifierManifest(name: VerifierName): Response {
  return json(name === "chain-replay" ? CHAIN_REPLAY_MANIFEST : LEADERBOARD_REPLAY_MANIFEST);
}

// Called by submissions.ts after the submission event exists. Never
// throws: a verifier failure leaves the submission pending, exactly as
// a human verdict that has not happened yet.
export async function runVerifierAtIntake(env: Env, name: VerifierName, submissionId: number): Promise<void> {
  try {
    if (name === "chain-replay") await runChainReplay(env, submissionId);
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
  const outcome = name === "chain-replay" ? await runChainReplay(env, submissionId) : await intakeLeaderboardReplay(env, submissionId);
  if (!outcome.ok) return error(outcome.status, outcome.error);
  const fresh = await loadSubmission(env, submissionId);
  return json({ verifier: verifierId(name), result: outcome.result, ...("dispatched" in outcome ? { dispatched: outcome.dispatched } : {}), submission: fresh });
}
