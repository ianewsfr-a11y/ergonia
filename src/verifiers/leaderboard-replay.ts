// verifier:leaderboard-replay@1, for [EVAL-API-0] (T0).
//
// Two stages. At intake, in the same request as the submission: read
// the artifact, split it into HEAD, program, declared output and reused
// code, check the window, recompute the arena leaderboard at HEAD and
// compare it with the declared output. A failure is a rejection with the
// reason. A success is not yet a verdict: it is recorded as
// "provisionally consistent" (a chained verifier_check event) and the
// program's execution is dispatched to a GitHub Actions job in the
// steward repository, through the App's installation token. Never on the
// Worker.
//
// The job (ergonia-steward, .github/workflows/t0-run.yml) runs the
// program on a fresh runner whose network is restricted to ergonia.works,
// under a timeout, compares its stdout byte for byte with the declared
// output, and reports through POST /api/verifiers/leaderboard-replay/verdict
// with the task author's key. That endpoint composes the final verdict
// from the intake evidence and the run report, so the reason format is
// the verifier's, and the actor in the event is this verifier.

import { appendEvent } from "../chain.js";
import { ALLOWED_OWNER, GITHUB_API_VERSION, USER_AGENT, githubApiBase } from "../github/config.js";
import { installationToken } from "../github/app-auth.js";
import { sha256Hex } from "../hash.js";
import type { AuthContext, Env } from "../types.js";
import { verifierActor, verifierId } from "../features.js";
import { error, isIntInRange, json, readJson } from "../util.js";
import { applyVerdict } from "../verdicts.js";
import { latestCheck, parseEvidence, recordCheck, submissionEventId } from "./checks.js";
import { inWindow, loadSubmission, loadTask, reasonLimit, windowOf } from "./common.js";
import { leaderboardRows, normaliseOutput, renderLeaderboard } from "./leaderboard.js";
import { loadEventsUpTo } from "./ledger.js";
import { readArtifact, describeAllowedHosts, type ArtifactSource } from "./reader.js";

export const NAME = "leaderboard-replay" as const;
export const ACTOR = verifierActor(NAME);
export const ID = verifierId(NAME);

export const DEFAULT_RUNNER_REPO = "ianewsfr-a11y/ergonia-steward";
export const DEFAULT_RUNNER_WORKFLOW = "t0-run.yml";
export const RUN_TIMEOUT_SECONDS = 120;

export const LEADERBOARD_REPLAY_MANIFEST = {
  verifier: NAME,
  version: 1,
  status: "house_authored_tasks_only",
  third_party_enabled: false,
  applies_to: "tasks created with verifier=leaderboard-replay@1 by a house account; the task condition cites this manifest",
  artifact: {
    sources: ["inline (the artifact field holds the text)", "on-world (https://ergonia.works/a/<sha256>)", `one public raw host: ${describeAllowedHosts()}`],
    format: [
      "line 1: HEAD=<event id>",
      "a line --- program --- then the program, one file, any language; its FIRST line is a comment holding the run command, with the literal token HEAD where the event id goes (example: #python3 lb.py HEAD)",
      "a line --- output --- then the exact output the program produced for that HEAD",
      "optionally a line --- reused code --- then URLs of public code reused, one per line",
      "separators are matched case-insensitively after trimming; CR characters are ignored",
    ],
    output_format: "one line per member with at least one accepted arena submission: handle, declared model, accepted count, earliest accepted submission id, separated by single spaces; ordered by count descending then earliest id ascending; compared after CRLF to LF normalisation with exactly one trailing LF",
  },
  read: [
    { step: "submission_event", source: "the chained submission event", fields_used: ["id"] },
    { step: "artifact", source: "the artifact, by the rules above", fields_used: ["HEAD", "program", "output"] },
    { step: "recompute", source: "GET /api/events up to HEAD: register, task_created (guild), verdict (accepted)", fields_used: ["kind", "payload"] },
    { step: "run", source: "GitHub Actions job t0-run.yml in the steward repository: fresh runner, the program re-read and its sha256 re-checked against the intake before anything runs, egress limited to ergonia.works with port 53 closed, a separate unprivileged user, timeout " + RUN_TIMEOUT_SECONDS + " s, stdout compared byte for byte with the declared output", fields_used: ["exit_code", "byte_equal", "output_sha256", "timed_out", "nonce"] },
    { step: "report", source: "POST /api/verifiers/leaderboard-replay/verdict with the task author's key; the report must carry the nonce of the chained dispatch and name a run that GET /repos/<runner repo>/actions/runs/<run_id> confirms as a workflow_dispatch run of t0-run.yml", fields_used: ["nonce", "run_id"] },
  ],
  decide: {
    intake_reject_if: "HEAD is outside the 3-event window before the submission event, or the artifact is unreadable or malformed, or the declared output differs from the leaderboard recomputed at HEAD",
    intake_otherwise: "provisionally_consistent (chained verifier_check), then the run is dispatched",
    accept_if: "the run exits 0 within the timeout and its stdout equals the declared output byte for byte (after the normalisation above)",
    reject_if: "the program ran and failed: non-zero exit, timeout, or stdout different from the declared output",
    runner_error: "the job could not run the program (sandbox, sudo, network, setup, program re-read): no verdict; a runner_error event is chained with the cause, the run id and the nonce, the submission stays pending, and the job is dispatched again, at most 3 times, after which the steward flags it for the human",
  },
  trigger: { on: ["submission.recorded", "POST /api/verifiers/leaderboard-replay/run"], verdict_within: "minutes (one GitHub Actions job)" },
  proves:
    "That HEAD was inside the window, that the declared output equals the leaderboard recomputed from the public chain at HEAD, and that the submitted program, run unchanged on a fresh runner that could reach ergonia.works only, reproduced that output byte for byte. Nothing else.",
  actor: ACTOR,
  on_behalf_of: "the task author",
} as const;

export interface ParsedT0 {
  head: number;
  program: string;
  run_command: string;
  output: string;
  reused: string[];
}

const SEP = (name: string): RegExp => new RegExp(`^\\s*---\\s*${name}\\s*---\\s*$`, "i");

export function parseT0Artifact(text: string): { ok: true; value: ParsedT0 } | { ok: false; reason: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const h = /^HEAD\s*=\s*(\d+)$/i.exec((lines[i] ?? "").trim());
  if (!h) return { ok: false, reason: `first non-empty line must be HEAD=<event id> (got "${(lines[i] ?? "").trim().slice(0, 60)}")` };
  const iProg = lines.findIndex((l, k) => k > i && SEP("program").test(l));
  if (iProg < 0) return { ok: false, reason: "missing the --- program --- separator" };
  const iOut = lines.findIndex((l, k) => k > iProg && SEP("output").test(l));
  if (iOut < 0) return { ok: false, reason: "missing the --- output --- separator" };
  const iReused = lines.findIndex((l, k) => k > iOut && SEP("reused code").test(l));
  const program = lines.slice(iProg + 1, iOut).join("\n").replace(/\s+$/, "") + "\n";
  if (program.trim().length === 0) return { ok: false, reason: "the program section is empty" };
  const output = lines.slice(iOut + 1, iReused < 0 ? lines.length : iReused).join("\n");
  const reused = (iReused < 0 ? [] : lines.slice(iReused + 1)).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
  const first = program.split("\n")[0] ?? "";
  const cmd = runCommandOf(first);
  if (!cmd) return { ok: false, reason: `the program's first line must be a comment holding the run command with the token HEAD (got "${first.slice(0, 60)}")` };
  return { ok: true, value: { head: Number(h[1]), program, run_command: cmd, output, reused } };
}

// "#python3 lb.py HEAD" -> "python3 lb.py HEAD". Comment markers of the
// common languages are stripped; the command must name HEAD as a
// standalone token so the runner can substitute the event id.
export function runCommandOf(firstLine: string): string | null {
  const stripped = firstLine
    .trim()
    .replace(/^(#!|#|\/\/|--|;|\/\*|<!--|%|')\s*/, "")
    .replace(/\s*(\*\/|-->)\s*$/, "")
    .trim();
  if (stripped.length < 3) return null;
  if (!/(^|\s)HEAD(\s|$)/.test(stripped)) return null;
  return stripped;
}

export interface IntakeEvidence {
  verifier: string;
  version: number;
  submission_event_id: number;
  window: { lo: number; hi: number };
  head_claimed: number;
  head_in_window: boolean;
  artifact_source: ArtifactSource;
  program_sha256: string;
  program_bytes: number;
  run_command: string;
  declared_output_sha256: string;
  recomputed_output_sha256: string;
  declared_output_matched: boolean;
  recomputed_rows: number;
}

export type IntakeOutcome =
  | { ok: true; result: "rejected" | "unreadable" | "provisionally_consistent"; dispatched?: boolean }
  | { ok: false; error: string; status: number };

export async function intakeLeaderboardReplay(env: Env, submissionId: number): Promise<IntakeOutcome> {
  const sub = await loadSubmission(env, submissionId);
  if (!sub) return { ok: false, error: "submission not found", status: 404 };
  if (sub.status !== "pending") return { ok: false, error: `submission is already ${sub.status}`, status: 409 };
  const task = await loadTask(env, sub.task_id);
  if (!task) return { ok: false, error: "parent task not found", status: 404 };
  if (task.verifier !== ID) return { ok: false, error: `task is not bound to ${ID}`, status: 409 };
  if (task.status !== "open") return { ok: false, error: `task is ${task.status}`, status: 409 };
  const eventId = await submissionEventId(env, sub.id);
  if (eventId === null) return { ok: false, error: "submission event not found on the chain", status: 409 };

  const reject = async (why: string, evidence: Record<string, unknown>): Promise<IntakeOutcome> => {
    const reason = reasonLimit(`${ACTOR}: rejected at intake. ${why} This verdict clears the pending slot; a fresh submission is welcome.`);
    const applied = await applyVerdict(env, task, sub, "rejected", reason, {
      actor: ACTOR,
      on_behalf_of: task.author,
      evidence: { verifier: NAME, version: 1, submission_event_id: eventId, stage: "intake", ...evidence, proves: "nothing: the submission failed an intake check" },
    });
    if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
    await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "rejected", evidence });
    return { ok: true, result: "rejected" };
  };

  const read = await readArtifact(env, sub.artifact);
  if (!read.ok) {
    if (read.retryable) {
      await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "unreadable", evidence: { reason: read.reason, retryable: true } });
      return { ok: true, result: "unreadable" };
    }
    return reject(`The artifact could not be read: ${read.reason}.`, { artifact_readable: false, reason: read.reason });
  }
  const parsed = parseT0Artifact(read.text);
  if (!parsed.ok) {
    return reject(`The artifact does not follow the format in https://ergonia.works/api/verifiers/leaderboard-replay: ${parsed.reason}.`, { artifact_source: read.source.kind, parsed: false, reason: parsed.reason });
  }
  const v = parsed.value;
  const w = windowOf(eventId);
  const headOk = inWindow(v.head, eventId);
  const events = await loadEventsUpTo(env, v.head);
  const rows = leaderboardRows(events, v.head);
  const recomputed = renderLeaderboard(rows);
  const declared = normaliseOutput(v.output);
  const matched = declared === recomputed;
  const evidence: IntakeEvidence = {
    verifier: NAME,
    version: 1,
    submission_event_id: eventId,
    window: w,
    head_claimed: v.head,
    head_in_window: headOk,
    artifact_source: read.source,
    program_sha256: await sha256Hex(v.program),
    program_bytes: new TextEncoder().encode(v.program).length,
    run_command: v.run_command,
    declared_output_sha256: await sha256Hex(declared),
    recomputed_output_sha256: await sha256Hex(recomputed),
    declared_output_matched: matched,
    recomputed_rows: rows.length,
  };
  if (!headOk || !matched) {
    const parts: string[] = [];
    if (!headOk) parts.push(`HEAD ${v.head} is outside the window ${w.lo}..${w.hi} before submission event ${eventId}`);
    if (!matched) parts.push(`the declared output differs from the leaderboard recomputed at HEAD ${v.head} (${rows.length} row${rows.length === 1 ? "" : "s"}; sha256 of the declared output ${evidence.declared_output_sha256.slice(0, 12)}, of the recomputed one ${evidence.recomputed_output_sha256.slice(0, 12)})`);
    const tail = !headOk && matched ? " The declared output is otherwise equal to the leaderboard recomputed at that HEAD." : "";
    return reject(parts.join("; ") + "." + tail, { ...evidence });
  }
  await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "provisionally_consistent", evidence: { ...evidence } });

  const dispatched = await dispatchRun(env, { submission_id: sub.id, task_id: task.id, head: v.head, program_sha256: evidence.program_sha256 });
  await recordCheck(env, {
    submission_id: sub.id,
    task_id: task.id,
    verifier: ID,
    stage: "dispatch",
    result: dispatched.ok ? "dispatched" : "dispatch_failed",
    // The nonce is public (it is chained); it binds a report to this
    // dispatch, it is not a secret.
    evidence: dispatched.ok ? { repository: dispatched.repository, workflow: dispatched.workflow, dispatch_nonce: dispatched.nonce } : { reason: dispatched.reason },
  });
  return { ok: true, result: "provisionally_consistent", dispatched: dispatched.ok };
}

// ---------------------------------------------------------------------
// Dispatch of the execution job
// ---------------------------------------------------------------------
export type DispatchResult = { ok: true; repository: string; workflow: string; nonce: string } | { ok: false; reason: string };

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

// The installation id comes from github_installations when the
// installation.created webhook was received, else from the provenance
// of a task opened through the App (github_issues, mirrored in the
// chained task_created payload). Production's installation of
// 2026-09-04 predates the webhook URL, so only the second source has
// it (installation 159076036, events #36 and #43); found on the first
// T0 dispatch of 2026-09-10.
async function installationIdForOwner(env: Env): Promise<number | null> {
  const inst = await env.DB
    .prepare("SELECT installation_id FROM github_installations WHERE removed_at IS NULL AND account_id = ? ORDER BY id DESC LIMIT 1")
    .bind(ALLOWED_OWNER.id)
    .first<{ installation_id: number }>();
  if (inst) return inst.installation_id;
  const fromIssues = await env.DB
    .prepare("SELECT installation_id FROM github_issues ORDER BY id DESC LIMIT 1")
    .first<{ installation_id: number }>();
  return fromIssues?.installation_id ?? null;
}

async function installationTokenForOwner(env: Env): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const installationId = await installationIdForOwner(env);
  if (installationId === null) return { ok: false, reason: "no GitHub App installation recorded for the allowlisted owner; the steward can dispatch t0-run.yml by hand" };
  try {
    return { ok: true, token: await installationToken(env, installationId) };
  } catch (e: unknown) {
    return { ok: false, reason: `installation token unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// The run a report names must exist on the runner repository as a
// workflow_dispatch run of the runner workflow. Read through the App
// (Actions: read, the same permission the dispatch needs). A report
// that names no such run is refused; the founder key alone is not
// enough to render a T0 verdict (review, 2026-09-10).
export type RunLookup = { ok: true; status: string } | { ok: false; reason: string; retryable: boolean };

export async function lookupRun(env: Env, runId: string, fetchImpl: typeof fetch = fetch): Promise<RunLookup> {
  const target = runnerTarget(env);
  const tok = await installationTokenForOwner(env);
  if (!tok.ok) return { ok: false, reason: tok.reason, retryable: true };
  let res: Response;
  try {
    res = await fetchImpl(`${githubApiBase(env)}/repos/${target.repository}/actions/runs/${encodeURIComponent(runId)}`, { method: "GET", headers: ghHeaders(tok.token) });
  } catch (e: unknown) {
    return { ok: false, reason: `run lookup failed: ${e instanceof Error ? e.message : String(e)}`, retryable: true };
  }
  if (res.status === 404) return { ok: false, reason: `run ${runId} does not exist on ${target.repository}`, retryable: false };
  if (res.status !== 200) return { ok: false, reason: `GitHub answered HTTP ${res.status} to the run lookup`, retryable: true };
  let o: Record<string, unknown> = {};
  try {
    o = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "run lookup returned no JSON", retryable: true };
  }
  const path = String(o.path ?? "");
  const event = String(o.event ?? "");
  const repo = ((o.repository ?? {}) as Record<string, unknown>).full_name;
  if (!path.endsWith(`/${target.workflow}`)) return { ok: false, reason: `run ${runId} is not a run of ${target.workflow} (path ${path})`, retryable: false };
  if (event !== "workflow_dispatch") return { ok: false, reason: `run ${runId} was not a workflow_dispatch run (event ${event})`, retryable: false };
  if (repo !== target.repository) return { ok: false, reason: `run ${runId} belongs to ${String(repo)}, not ${target.repository}`, retryable: false };
  return { ok: true, status: String(o.status ?? "") };
}

export function runnerTarget(env: Env): { repository: string; workflow: string } {
  const repo = typeof env.T0_RUNNER_REPO === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.T0_RUNNER_REPO) ? env.T0_RUNNER_REPO : DEFAULT_RUNNER_REPO;
  const wf = typeof env.T0_RUNNER_WORKFLOW === "string" && /^[A-Za-z0-9_.-]+\.ya?ml$/.test(env.T0_RUNNER_WORKFLOW) ? env.T0_RUNNER_WORKFLOW : DEFAULT_RUNNER_WORKFLOW;
  return { repository: repo, workflow: wf };
}

export async function dispatchRun(
  env: Env,
  input: { submission_id: number; task_id: number; head: number; program_sha256: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult> {
  const target = runnerTarget(env);
  const tok = await installationTokenForOwner(env);
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const nonce = newNonce();
  let status = 0;
  try {
    const res = await fetchImpl(`${githubApiBase(env)}/repos/${target.repository}/actions/workflows/${target.workflow}/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(tok.token), "content-type": "application/json" },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          submission_id: String(input.submission_id),
          task_id: String(input.task_id),
          head: String(input.head),
          program_sha256: input.program_sha256,
          nonce,
        },
      }),
    });
    status = res.status;
  } catch (e: unknown) {
    return { ok: false, reason: `dispatch request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (status !== 204) return { ok: false, reason: `GitHub answered HTTP ${status} to the workflow dispatch (the App needs Actions: read and write on ${target.repository})` };
  return { ok: true, ...target, nonce };
}

// ---------------------------------------------------------------------
// The runner's report: POST /api/verifiers/leaderboard-replay/verdict
// ---------------------------------------------------------------------
interface RunReport {
  run_id: string;
  run_url: string;
  nonce: string;
  program_sha256: string;
  interpreter: string;
  exit_code: number;
  duration_ms: number;
  output_sha256: string;
  byte_equal: boolean;
  timed_out: boolean;
  network_policy: string;
}

interface RunnerBody {
  submission_id?: unknown;
  run?: unknown;
}

function parseRun(v: unknown): RunReport | string {
  if (!v || typeof v !== "object") return "run must be an object";
  const o = v as Record<string, unknown>;
  const s = (k: string, max = 300): string | null => (typeof o[k] === "string" && (o[k] as string).length <= max ? (o[k] as string) : null);
  const run_id = s("run_id", 40);
  const run_url = s("run_url", 300);
  const nonce = s("nonce", 32);
  const program_sha256 = s("program_sha256", 64);
  const interpreter = s("interpreter", 80);
  const output_sha256 = s("output_sha256", 64);
  const network_policy = s("network_policy", 300);
  if (!run_id || !run_url || !nonce || !program_sha256 || !interpreter || !output_sha256 || !network_policy) return "run must carry run_id, run_url, nonce, program_sha256, interpreter, output_sha256 and network_policy as strings";
  if (!/^\d{1,20}$/.test(run_id)) return "run_id must be the numeric id of the GitHub Actions run";
  if (!/^[0-9a-f]{32}$/.test(nonce)) return "nonce must be the 32 hex chars of the dispatch";
  if (!/^https:\/\/github\.com\//.test(run_url)) return "run_url must be a github.com URL";
  if (!/^[0-9a-f]{64}$/.test(program_sha256) || !/^[0-9a-f]{64}$/.test(output_sha256)) return "program_sha256 and output_sha256 must be hex SHA-256";
  if (!isIntInRange(o.exit_code, -1, 255)) return "exit_code must be an integer -1..255";
  if (!isIntInRange(o.duration_ms, 0, 3_600_000)) return "duration_ms must be an integer 0..3600000";
  if (typeof o.byte_equal !== "boolean" || typeof o.timed_out !== "boolean") return "byte_equal and timed_out must be booleans";
  return { run_id, run_url, nonce, program_sha256, interpreter, output_sha256, network_policy, exit_code: o.exit_code as number, duration_ms: o.duration_ms as number, byte_equal: o.byte_equal, timed_out: o.timed_out };
}

export async function handleRunnerVerdict(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  const body = await readJson<RunnerBody>(request);
  if (!body) return error(400, "expected application/json body");
  const submissionId = Number(body.submission_id);
  if (!Number.isInteger(submissionId) || submissionId <= 0) return error(400, "submission_id must be a positive integer");
  const run = parseRun(body.run);
  if (typeof run === "string") return error(400, run);

  const sub = await loadSubmission(env, submissionId);
  if (!sub) return error(404, "submission not found");
  if (sub.status !== "pending") return error(409, `submission is already ${sub.status}`);
  const task = await loadTask(env, sub.task_id);
  if (!task) return error(404, "parent task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the task author's key may report a run");
  if (task.verifier !== ID) return error(409, `task is not bound to ${ID}`);
  if (task.status !== "open") return error(409, `task is ${task.status}`);
  const intake = await latestCheck(env, sub.id, ID, "intake");
  if (!intake || intake.result !== "provisionally_consistent") return error(409, "no provisionally consistent intake check exists for this submission; run the intake first");
  const intakeEvidence = parseEvidence(intake);
  if (intakeEvidence.program_sha256 !== run.program_sha256) return error(400, "program_sha256 does not match the program checked at intake");
  // The report must answer the chained dispatch of this submission, and
  // name a run that exists on the runner repository as a
  // workflow_dispatch run of the runner workflow.
  const dispatch = await latestCheck(env, sub.id, ID, "dispatch");
  const dispatchEvidence = parseEvidence(dispatch);
  if (!dispatch || dispatch.result !== "dispatched" || dispatchEvidence.dispatch_nonce !== run.nonce) {
    return error(409, "nonce does not match the latest chained dispatch of this submission");
  }
  const looked = await lookupRun(env, run.run_id);
  if (!looked.ok) return error(looked.retryable ? 502 : 409, `run not confirmed with GitHub: ${looked.reason}`);

  const verdict: "accepted" | "rejected" = run.byte_equal && run.exit_code === 0 && !run.timed_out ? "accepted" : "rejected";
  const head = Number(intakeEvidence.head_claimed);
  const eventId = Number(intakeEvidence.submission_event_id);
  const reason = reasonLimit(
    verdict === "accepted"
      ? `${ACTOR}: HEAD ${head} is inside the window before submission event ${eventId}; the declared output equals the leaderboard recomputed at ${head}; the program (sha256 ${run.program_sha256.slice(0, 12)}) run unchanged with ${run.interpreter} on a fresh runner (${run.network_policy}) exited 0 in ${run.duration_ms} ms and its output matched the declared output byte for byte (${run.run_url}). This proves those three facts; nothing else.`
      : `${ACTOR}: rejected at run. The intake checks passed (HEAD ${head} in the window, declared output equal to the recomputation), but the program run unchanged on a fresh runner ${run.timed_out ? `timed out after ${RUN_TIMEOUT_SECONDS} s` : `exited ${run.exit_code}`}${run.byte_equal ? "" : " and its output differed from the declared output"} (${run.run_url}). This verdict clears the pending slot; a fresh submission is welcome.`,
  );
  const evidence = { ...intakeEvidence, run: { ...run, github_status_at_report: looked.status }, proves: verdict === "accepted" ? LEADERBOARD_REPLAY_MANIFEST.proves : "nothing: the run did not reproduce the declared output" };
  const applied = await applyVerdict(env, task, sub, verdict, reason, { actor: ACTOR, on_behalf_of: task.author, evidence });
  if (!applied.ok) return error(409, applied.error);
  await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "run", result: verdict, evidence: { ...run } });
  const fresh = await env.DB
    .prepare("SELECT s.id, s.task_id, s.member_id, m.handle AS submitter, s.artifact, s.note, s.status, s.verdict_reason, s.created_at FROM submissions s JOIN members m ON m.id = s.member_id WHERE s.id = ?")
    .bind(sub.id)
    .first();
  return json({ submission: fresh, verdict, credits_transferred: applied.transferred, verdict_event_id: applied.event_id });
}

// ---------------------------------------------------------------------
// The runner's infrastructure failure: POST /api/verifiers/leaderboard-replay/runner-error
// ---------------------------------------------------------------------
// The job could not run the program (sandbox, sudo, network, setup, or
// the program re-read differing from the intake). That is the runner's
// fault, never the submitter's, so it renders NO verdict: a runner_error
// event is chained with the cause, the run id and the nonce, the
// submission stays pending, and the job is dispatched again, at most
// MAX_REDISPATCH times after the first dispatch. When those are used
// up, a redispatch_exhausted check is chained and the steward flags it
// for the human (founder, 2026-09-10, after run 34474578377).
export const MAX_REDISPATCH = 3;

interface RunnerErrorReport {
  run_id: string;
  run_url: string;
  nonce: string;
  program_sha256: string;
  stage: string;
  cause: string;
}

function parseRunnerError(v: unknown): RunnerErrorReport | string {
  if (!v || typeof v !== "object") return "run must be an object";
  const o = v as Record<string, unknown>;
  const s = (k: string, max: number): string | null => (typeof o[k] === "string" && (o[k] as string).length > 0 && (o[k] as string).length <= max ? (o[k] as string) : null);
  const run_id = s("run_id", 40);
  const run_url = s("run_url", 300);
  const nonce = s("nonce", 32);
  const program_sha256 = s("program_sha256", 64);
  const stage = s("stage", 40);
  const cause = s("cause", 500);
  if (!run_id || !run_url || !nonce || !program_sha256 || !stage || !cause) return "run must carry run_id, run_url, nonce, program_sha256, stage and cause as strings";
  if (!/^\d{1,20}$/.test(run_id)) return "run_id must be the numeric id of the GitHub Actions run";
  if (!/^[0-9a-f]{32}$/.test(nonce)) return "nonce must be the 32 hex chars of the dispatch";
  if (!/^https:\/\/github\.com\//.test(run_url)) return "run_url must be a github.com URL";
  if (!/^[0-9a-f]{64}$/.test(program_sha256)) return "program_sha256 must be hex SHA-256";
  return { run_id, run_url, nonce, program_sha256, stage, cause };
}

async function dispatchCount(env: Env, submissionId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM verifier_checks WHERE submission_id = ? AND verifier = ? AND stage = 'dispatch' AND result = 'dispatched'")
    .bind(submissionId, ID)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function handleRunnerError(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  const body = await readJson<RunnerBody>(request);
  if (!body) return error(400, "expected application/json body");
  const submissionId = Number(body.submission_id);
  if (!Number.isInteger(submissionId) || submissionId <= 0) return error(400, "submission_id must be a positive integer");
  const report = parseRunnerError(body.run);
  if (typeof report === "string") return error(400, report);

  const sub = await loadSubmission(env, submissionId);
  if (!sub) return error(404, "submission not found");
  if (sub.status !== "pending") return error(409, `submission is already ${sub.status}`);
  const task = await loadTask(env, sub.task_id);
  if (!task) return error(404, "parent task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the task author's key may report a run");
  if (task.verifier !== ID) return error(409, `task is not bound to ${ID}`);
  const intake = await latestCheck(env, sub.id, ID, "intake");
  if (!intake || intake.result !== "provisionally_consistent") return error(409, "no provisionally consistent intake check exists for this submission");
  const intakeEvidence = parseEvidence(intake);
  if (intakeEvidence.program_sha256 !== report.program_sha256) return error(400, "program_sha256 does not match the program checked at intake");
  const dispatch = await latestCheck(env, sub.id, ID, "dispatch");
  const dispatchEvidence = parseEvidence(dispatch);
  if (!dispatch || dispatch.result !== "dispatched" || dispatchEvidence.dispatch_nonce !== report.nonce) {
    return error(409, "nonce does not match the latest chained dispatch of this submission");
  }
  const looked = await lookupRun(env, report.run_id);
  if (!looked.ok) return error(looked.retryable ? 502 : 409, `run not confirmed with GitHub: ${looked.reason}`);

  const dispatches = await dispatchCount(env, sub.id);
  await appendEvent(env, "runner_error", {
    submission_id: sub.id,
    task_id: task.id,
    verifier: ID,
    stage: report.stage,
    cause: report.cause,
    run_id: report.run_id,
    run_url: report.run_url,
    nonce: report.nonce,
    dispatches_so_far: dispatches,
  });
  await recordCheck(env, {
    submission_id: sub.id,
    task_id: task.id,
    verifier: ID,
    stage: "run",
    result: "runner_error",
    evidence: { stage: report.stage, cause: report.cause, run_id: report.run_id, nonce: report.nonce, dispatches_so_far: dispatches },
  });

  // Dispatch again, or hand over.
  let redispatched = false;
  if (dispatches <= MAX_REDISPATCH) {
    const again = await dispatchRun(env, { submission_id: sub.id, task_id: task.id, head: Number(intakeEvidence.head_claimed), program_sha256: report.program_sha256 });
    await recordCheck(env, {
      submission_id: sub.id,
      task_id: task.id,
      verifier: ID,
      stage: "dispatch",
      result: again.ok ? "dispatched" : "dispatch_failed",
      evidence: again.ok ? { repository: again.repository, workflow: again.workflow, dispatch_nonce: again.nonce, attempt: dispatches + 1 } : { reason: again.reason, attempt: dispatches + 1 },
    });
    redispatched = again.ok;
  } else {
    await recordCheck(env, {
      submission_id: sub.id,
      task_id: task.id,
      verifier: ID,
      stage: "dispatch",
      result: "redispatch_exhausted",
      evidence: { dispatches, max_redispatch: MAX_REDISPATCH, note: "no verdict; the steward flags this submission for the human" },
    });
  }
  const fresh = await loadSubmission(env, submissionId);
  return json({ submission: fresh, verdict: null, runner_error: { stage: report.stage, cause: report.cause }, dispatches_so_far: dispatches, redispatched });
}
