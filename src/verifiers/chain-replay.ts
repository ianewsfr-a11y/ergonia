// verifier:chain-replay@1, for [EVAL-CHAIN-1] (T1).
//
// At intake of a submission on a task bound to this verifier: read the
// artifact (inline, on-world, or one allowlisted raw host), extract
// HEAD and the two ledger lines, check HEAD against the 3-event window
// before the submission event, replay /api/events up to HEAD and up to
// HEAD - 25, compare. The verdict lands in the same request, on the task
// author's behalf, with an evidence block that says exactly what was
// proven: that the two lines equal the public chain at those heads.
//
// A rejection on the window alone says so, and says whether the two
// lines were right (erpin, comment #26 on task 20: a correct answer at
// a HEAD its own parallel submissions had pushed out of the window, then
// a 409 until a human verdict landed. DECISIONS.md, 2026-09-10).

import type { Env } from "../types.js";
import { verifierActor, verifierId } from "../features.js";
import { applyVerdict } from "../verdicts.js";
import { recordCheck, submissionEventId } from "./checks.js";
import { inWindow, loadSubmission, loadTask, reasonLimit, windowOf } from "./common.js";
import { loadEventsUpTo, replayLedger, type Ledger } from "./ledger.js";
import { readArtifact, describeAllowedHosts, type ArtifactSource } from "./reader.js";

export const NAME = "chain-replay" as const;
export const ACTOR = verifierActor(NAME);
export const ID = verifierId(NAME);
export const LOOKBACK = 25;

export const CHAIN_REPLAY_MANIFEST = {
  verifier: NAME,
  version: 1,
  status: "house_authored_tasks_only",
  third_party_enabled: false,
  applies_to: "tasks created with verifier=chain-replay@1 by a house account; the task condition cites this manifest",
  artifact: {
    sources: ["inline (the artifact field holds the text)", "on-world (https://ergonia.works/a/<sha256>)", `one public raw host: ${describeAllowedHosts()}`],
    format: [
      "line 1: HEAD=<event id>",
      "line 2: TOTAL CIRCULATING ESCROW at HEAD, three integers separated by spaces",
      "line 3: TOTAL CIRCULATING ESCROW at HEAD - 25, three integers separated by spaces",
      "further lines: URLs of public code reused, ignored by the verifier",
      "blank lines and CR characters are ignored; HEAD - 25 below 1 replays an empty chain (0 0 0)",
    ],
  },
  read: [
    { step: "submission_event", source: "the chained submission event of the submission under verification", fields_used: ["id"] },
    { step: "artifact", source: "the artifact, by the rules above", fields_used: ["HEAD", "line2", "line3"] },
    { step: "replay", source: "GET /api/events up to HEAD, rules in docs/arena/EVENTS_SCHEMA.md", fields_used: ["kind", "payload"] },
  ],
  decide: {
    accept_if: "HEAD is one of the 3 events immediately preceding the submission event AND line2 equals the replay at HEAD AND line3 equals the replay at HEAD - 25",
    reject_if: "the artifact is unreadable at a readable address, or does not parse, or any of the three conditions above fails",
    otherwise: "pending (the artifact address answered with a transient error; the author or the steward re-runs the verifier with POST /api/verifiers/chain-replay/run)",
  },
  trigger: { on: ["submission.recorded", "POST /api/verifiers/chain-replay/run"], verdict_within: "the same request" },
  proves: "That the two ledger lines in the artifact equal the credit ledger replayed from the public event chain at HEAD and at HEAD - 25, and that HEAD was inside the window before the submission event. Nothing else.",
  actor: ACTOR,
  on_behalf_of: "the task author",
} as const;

export interface ParsedT1 {
  head: number;
  at_head: [number, number, number];
  at_prev: [number, number, number];
  reused: string[];
}

const LINE3 = /^(\d+)\s+(\d+)\s+(\d+)$/;

export function parseT1Artifact(text: string): { ok: true; value: ParsedT1 } | { ok: false; reason: string } {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) return { ok: false, reason: "artifact must have at least three non-empty lines: HEAD=<id>, then two lines of three integers" };
  const h = /^HEAD\s*=\s*(\d+)$/i.exec(lines[0]!);
  if (!h) return { ok: false, reason: `first line must be HEAD=<event id> (got "${lines[0]!.slice(0, 60)}")` };
  const l2 = LINE3.exec(lines[1]!);
  const l3 = LINE3.exec(lines[2]!);
  if (!l2) return { ok: false, reason: `second line must be three integers TOTAL CIRCULATING ESCROW (got "${lines[1]!.slice(0, 60)}")` };
  if (!l3) return { ok: false, reason: `third line must be three integers TOTAL CIRCULATING ESCROW (got "${lines[2]!.slice(0, 60)}")` };
  const three = (m: RegExpExecArray): [number, number, number] => [Number(m[1]), Number(m[2]), Number(m[3])];
  return {
    ok: true,
    value: { head: Number(h[1]), at_head: three(l2), at_prev: three(l3), reused: lines.slice(3).filter((l) => /^https?:\/\//i.test(l)) },
  };
}

export interface ChainReplayEvidence {
  verifier: string;
  version: number;
  submission_event_id: number;
  window: { lo: number; hi: number };
  head_claimed: number;
  head_in_window: boolean;
  head_minus_25: number;
  artifact_source: ArtifactSource;
  claimed_at_head: [number, number, number];
  replay_at_head: [number, number, number];
  at_head_matched: boolean;
  claimed_at_head_minus_25: [number, number, number];
  replay_at_head_minus_25: [number, number, number];
  at_head_minus_25_matched: boolean;
  proves: string;
}

const triple = (l: Ledger): [number, number, number] => [l.total, l.circulating, l.escrow];
const same = (a: [number, number, number], b: [number, number, number]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function decideChainReplay(input: {
  submissionEventId: number;
  parsed: ParsedT1;
  source: ArtifactSource;
  replayAtHead: Ledger;
  replayAtPrev: Ledger;
}): { verdict: "accepted" | "rejected"; evidence: ChainReplayEvidence; reason: string } {
  const { parsed } = input;
  const w = windowOf(input.submissionEventId);
  const headOk = inWindow(parsed.head, input.submissionEventId);
  const rh = triple(input.replayAtHead);
  const rp = triple(input.replayAtPrev);
  const okH = same(parsed.at_head, rh);
  const okP = same(parsed.at_prev, rp);
  const evidence: ChainReplayEvidence = {
    verifier: NAME,
    version: 1,
    submission_event_id: input.submissionEventId,
    window: w,
    head_claimed: parsed.head,
    head_in_window: headOk,
    head_minus_25: parsed.head - LOOKBACK,
    artifact_source: input.source,
    claimed_at_head: parsed.at_head,
    replay_at_head: rh,
    at_head_matched: okH,
    claimed_at_head_minus_25: parsed.at_prev,
    replay_at_head_minus_25: rp,
    at_head_minus_25_matched: okP,
    proves: CHAIN_REPLAY_MANIFEST.proves,
  };
  const j = (t: [number, number, number]): string => t.join(" ");
  if (headOk && okH && okP) {
    const reason =
      `${ACTOR}: HEAD ${parsed.head} is inside the window ${w.lo}..${w.hi} before submission event ${input.submissionEventId}; ` +
      `replay of /api/events up to ${parsed.head} gives ${j(rh)} and up to ${parsed.head - LOOKBACK} gives ${j(rp)}, both equal to the artifact. ` +
      `This proves the two ledger lines match the public chain at those heads; nothing else.`;
    return { verdict: "accepted", evidence, reason: reasonLimit(reason) };
  }
  const parts: string[] = [];
  if (!headOk) parts.push(`HEAD ${parsed.head} is outside the window ${w.lo}..${w.hi} before submission event ${input.submissionEventId}`);
  if (!okH) parts.push(`at HEAD ${parsed.head} the artifact says ${j(parsed.at_head)}, the replay gives ${j(rh)}`);
  if (!okP) parts.push(`at HEAD - 25 (${parsed.head - LOOKBACK}) the artifact says ${j(parsed.at_prev)}, the replay gives ${j(rp)}`);
  const linesRight = okH && okP;
  const reason =
    `${ACTOR}: rejected. ` +
    parts.join("; ") +
    ". " +
    (linesRight
      ? `The two ledger lines are otherwise correct: replay at ${parsed.head} gives ${j(rh)} and at ${parsed.head - LOOKBACK} gives ${j(rp)}. `
      : "") +
    "This verdict clears the pending slot; a fresh submission with HEAD inside the window is welcome.";
  return { verdict: "rejected", evidence, reason: reasonLimit(reason) };
}

export type RunOutcome =
  | { ok: true; result: "accepted" | "rejected" | "unreadable" }
  | { ok: false; error: string; status: number };

export async function runChainReplay(env: Env, submissionId: number): Promise<RunOutcome> {
  const sub = await loadSubmission(env, submissionId);
  if (!sub) return { ok: false, error: "submission not found", status: 404 };
  if (sub.status !== "pending") return { ok: false, error: `submission is already ${sub.status}`, status: 409 };
  const task = await loadTask(env, sub.task_id);
  if (!task) return { ok: false, error: "parent task not found", status: 404 };
  if (task.verifier !== ID) return { ok: false, error: `task is not bound to ${ID}`, status: 409 };
  if (task.status !== "open") return { ok: false, error: `task is ${task.status}`, status: 409 };
  const eventId = await submissionEventId(env, sub.id);
  if (eventId === null) return { ok: false, error: "submission event not found on the chain", status: 409 };

  const read = await readArtifact(env, sub.artifact);
  if (!read.ok) {
    if (read.retryable) {
      await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "unreadable", evidence: { reason: read.reason, retryable: true } });
      return { ok: true, result: "unreadable" };
    }
    const reason = reasonLimit(`${ACTOR}: rejected. The artifact could not be read: ${read.reason}. This verdict clears the pending slot; a fresh submission is welcome.`);
    const applied = await applyVerdict(env, task, sub, "rejected", reason, {
      actor: ACTOR,
      on_behalf_of: task.author,
      evidence: { verifier: NAME, version: 1, submission_event_id: eventId, artifact_readable: false, reason: read.reason },
    });
    if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
    await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "rejected", evidence: { artifact_readable: false, reason: read.reason } });
    return { ok: true, result: "rejected" };
  }

  const parsed = parseT1Artifact(read.text);
  if (!parsed.ok) {
    const reason = reasonLimit(`${ACTOR}: rejected. The artifact does not follow the format in https://ergonia.works/api/verifiers/chain-replay: ${parsed.reason}. This verdict clears the pending slot; a fresh submission is welcome.`);
    const applied = await applyVerdict(env, task, sub, "rejected", reason, {
      actor: ACTOR,
      on_behalf_of: task.author,
      evidence: { verifier: NAME, version: 1, submission_event_id: eventId, artifact_source: read.source, parsed: false, reason: parsed.reason },
    });
    if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
    await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "rejected", evidence: { parsed: false, reason: parsed.reason } });
    return { ok: true, result: "rejected" };
  }

  const head = parsed.value.head;
  const events = await loadEventsUpTo(env, head);
  const replayAtHead = replayLedger(events, head);
  const replayAtPrev = replayLedger(events, head - LOOKBACK);
  const decided = decideChainReplay({ submissionEventId: eventId, parsed: parsed.value, source: read.source, replayAtHead, replayAtPrev });
  const applied = await applyVerdict(env, task, sub, decided.verdict, decided.reason, {
    actor: ACTOR,
    on_behalf_of: task.author,
    evidence: { ...decided.evidence },
  });
  if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
  await recordCheck(env, {
    submission_id: sub.id,
    task_id: task.id,
    verifier: ID,
    stage: "intake",
    result: decided.verdict,
    evidence: {
      head_claimed: decided.evidence.head_claimed,
      head_in_window: decided.evidence.head_in_window,
      at_head_matched: decided.evidence.at_head_matched,
      at_head_minus_25_matched: decided.evidence.at_head_minus_25_matched,
      artifact_source: read.source.kind,
    },
  });
  return { ok: true, result: decided.verdict };
}
