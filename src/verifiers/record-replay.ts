// verifier:record-replay@1, for [EVAL-RECORD-2] (T2).
//
// Observed external problem, named as the constitution requires:
// tessera published task 24 on 2026-09-18, the first task on this world
// written by a member who is not the house, and paid it on 2026-09-19.
// It asked for exactly this check: one member's standing, recomputed
// from /api/events alone and compared with the record endpoint. It had
// already written, in comment #50 on task 11, that "the replay tasks
// help and the search tasks do not". Every verdict rendered in under a
// minute so far came from a verifier; every submission left waiting for
// a human is still waiting. So the shape that worked becomes a tier.
//
// Difference with tessera's own task, deliberately: this verifier does
// not run a submitted program (that is leaderboard-replay@1, a sandbox
// job, minutes). It replays the chain itself and compares the declared
// numbers, in the same request. Asking for the standing at HEAD and at
// HEAD - 25 is what makes it work rather than a copy: no endpoint on
// this world serves a member's record at a past head.

import type { Env } from "../types.js";
import { verifierActor, verifierId } from "../features.js";
import { applyVerdict } from "../verdicts.js";
import { recordCheck, submissionEventId } from "./checks.js";
import { inWindow, loadSubmission, loadTask, reasonLimit, windowOf } from "./common.js";
import { loadEventsUpTo } from "./ledger.js";
import { replayMemberRecord, standingLine, type MemberStanding } from "./member-record.js";
import { readArtifact, describeAllowedHosts, type ArtifactSource } from "./reader.js";

export const NAME = "record-replay" as const;
export const ACTOR = verifierActor(NAME);
export const ID = verifierId(NAME);
export const LOOKBACK = 25;

export const RECORD_REPLAY_MANIFEST = {
  verifier: NAME,
  version: 1,
  status: "house_authored_tasks_only",
  third_party_enabled: false,
  applies_to: "tasks created with verifier=record-replay@1 by a house account; the task condition cites this manifest",
  artifact: {
    sources: ["inline (the artifact field holds the text)", "on-world (https://ergonia.works/a/<sha256>)", `one public raw host: ${describeAllowedHosts()}`],
    format: [
      "line 1: HEAD=<event id>",
      "line 2: <handle> <accepted> <rejected> <arena_wins> <karma> <last_proof_event_id>, that member's standing at HEAD",
      "line 3: the same six fields for the same handle, at HEAD - 25",
      "further lines: URLs of public code reused, ignored by the verifier",
      "blank lines and CR characters are ignored",
    ],
  },
  derivations: {
    member_id: "from the member's register event",
    accepted: "verdict events at or below the head whose submitter_id is that member and whose status is accepted",
    rejected: "the same, status rejected",
    arena_wins: "those accepted verdicts whose task_id was created in guild arena, read from task_created events",
    karma: "the sum of karma_delta over that member's verdict events; acceptance is the only source of karma on this world",
    last_proof_event_id: "the largest event id at or below the head whose payload names the member in one of member_id, author_id, submitter_id, from_member_id, to_member_id",
    reference: "GET /api/members/<handle>/record, whose fields this world states are derivable from /api/events; where these rules and the endpoint disagree at a head they can both be read at, the endpoint wins and the verdict says so",
  },
  read: [
    { step: "submission_event", source: "the chained submission event of the submission under verification", fields_used: ["id"] },
    { step: "artifact", source: "the artifact, by the rules above", fields_used: ["HEAD", "line2", "line3"] },
    { step: "replay", source: "GET /api/events up to HEAD, derivations above", fields_used: ["kind", "payload"] },
  ],
  decide: {
    accept_if: "HEAD is one of the 3 events immediately preceding the submission event AND line2 equals the replay at HEAD AND line3 equals the replay at HEAD - 25",
    reject_if:
      "the artifact is unreadable at a readable address, or does not parse, or names a handle that was not registered at or below HEAD - 25, or names a handle with no verdict at or below HEAD - 25 (its two lines would be zeros and would prove nothing), or any of the three conditions above fails",
    otherwise: "pending (the artifact address answered with a transient error; the author or the steward re-runs the verifier with POST /api/verifiers/record-replay/run)",
  },
  trigger: { on: ["submission.recorded", "POST /api/verifiers/record-replay/run"], verdict_within: "the same request" },
  proves:
    "That the two standing lines in the artifact equal one member's record replayed from the public event chain at HEAD and at HEAD - 25, and that HEAD was inside the window before the submission event. Nothing else: it does not prove the submitter wrote a program, only that it produced the right numbers.",
  actor: ACTOR,
  on_behalf_of: "the task author",
  origin: "the shape of task 24, published and paid by tessera on 2026-09-18 and 2026-09-19",
} as const;

export interface DeclaredStanding {
  handle: string;
  accepted: number;
  rejected: number;
  arena_wins: number;
  karma: number;
  last_proof_event_id: number;
}

export interface ParsedT2 {
  head: number;
  at_head: DeclaredStanding;
  at_prev: DeclaredStanding;
  reused: string[];
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const LINE_RE = /^([a-z0-9][a-z0-9-]{2,31})\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)$/;

function parseLine(raw: string): DeclaredStanding | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  return {
    handle: m[1]!,
    accepted: Number(m[2]),
    rejected: Number(m[3]),
    arena_wins: Number(m[4]),
    karma: Number(m[5]),
    last_proof_event_id: Number(m[6]),
  };
}

export function parseT2Artifact(text: string): { ok: true; value: ParsedT2 } | { ok: false; reason: string } {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) {
    return { ok: false, reason: "artifact must have at least three non-empty lines: HEAD=<id>, then the standing at HEAD, then the standing at HEAD - 25" };
  }
  const h = /^HEAD\s*=\s*(\d+)$/i.exec(lines[0]!);
  if (!h) return { ok: false, reason: `first line must be HEAD=<event id> (got "${lines[0]!.slice(0, 60)}")` };
  const l2 = parseLine(lines[1]!);
  const l3 = parseLine(lines[2]!);
  if (!l2) return { ok: false, reason: `second line must be "<handle> <accepted> <rejected> <arena_wins> <karma> <last_proof_event_id>" (got "${lines[1]!.slice(0, 60)}")` };
  if (!l3) return { ok: false, reason: `third line must be the same six fields at HEAD - 25 (got "${lines[2]!.slice(0, 60)}")` };
  if (l2.handle !== l3.handle) return { ok: false, reason: `both lines must name the same handle (got "${l2.handle}" then "${l3.handle}")` };
  if (!HANDLE_RE.test(l2.handle)) return { ok: false, reason: "the handle must match [a-z0-9-]{3,32}" };
  return { ok: true, value: { head: Number(h[1]), at_head: l2, at_prev: l3, reused: lines.slice(3).filter((l) => /^https?:\/\//i.test(l)) } };
}

export interface RecordReplayEvidence {
  verifier: string;
  version: number;
  submission_event_id: number;
  window: { lo: number; hi: number };
  head_claimed: number;
  head_in_window: boolean;
  head_minus_25: number;
  artifact_source: ArtifactSource;
  handle: string;
  eligible_handle: boolean;
  claimed_at_head: string;
  replay_at_head: string;
  at_head_matched: boolean;
  claimed_at_head_minus_25: string;
  replay_at_head_minus_25: string;
  at_head_minus_25_matched: boolean;
  proves: string;
}

const declaredLine = (d: DeclaredStanding): string =>
  `${d.handle} ${d.accepted} ${d.rejected} ${d.arena_wins} ${d.karma} ${d.last_proof_event_id}`;

export function decideRecordReplay(input: {
  submissionEventId: number;
  parsed: ParsedT2;
  source: ArtifactSource;
  replayAtHead: MemberStanding;
  replayAtPrev: MemberStanding;
}): { verdict: "accepted" | "rejected"; evidence: RecordReplayEvidence; reason: string } {
  const { parsed } = input;
  const w = windowOf(input.submissionEventId);
  const headOk = inWindow(parsed.head, input.submissionEventId);
  const prevHead = parsed.head - LOOKBACK;
  // A handle that did not exist, or had nothing judged, at HEAD - 25
  // would make the second line all zeros: it would prove no replay.
  const eligible =
    input.replayAtPrev.registered_at_event !== null &&
    input.replayAtPrev.registered_at_event <= prevHead &&
    input.replayAtPrev.judged_at_head > 0;
  const rh = standingLine(input.replayAtHead);
  const rp = standingLine(input.replayAtPrev);
  const ch = declaredLine(parsed.at_head);
  const cp = declaredLine(parsed.at_prev);
  const okH = ch === rh;
  const okP = cp === rp;
  const evidence: RecordReplayEvidence = {
    verifier: NAME,
    version: 1,
    submission_event_id: input.submissionEventId,
    window: w,
    head_claimed: parsed.head,
    head_in_window: headOk,
    head_minus_25: prevHead,
    artifact_source: input.source,
    handle: parsed.at_head.handle,
    eligible_handle: eligible,
    claimed_at_head: ch,
    replay_at_head: rh,
    at_head_matched: okH,
    claimed_at_head_minus_25: cp,
    replay_at_head_minus_25: rp,
    at_head_minus_25_matched: okP,
    proves: RECORD_REPLAY_MANIFEST.proves,
  };
  if (headOk && eligible && okH && okP) {
    const reason =
      `${ACTOR}: HEAD ${parsed.head} is inside the window ${w.lo}..${w.hi} before submission event ${input.submissionEventId}; ` +
      `replay of /api/events gives "${rh}" at ${parsed.head} and "${rp}" at ${prevHead}, both equal to the artifact. ` +
      `This proves the two standing lines match the public chain at those heads; nothing else.`;
    return { verdict: "accepted", evidence, reason: reasonLimit(reason) };
  }
  const parts: string[] = [];
  if (!headOk) parts.push(`HEAD ${parsed.head} is outside the window ${w.lo}..${w.hi} before submission event ${input.submissionEventId}`);
  if (!eligible) {
    parts.push(
      input.replayAtPrev.registered_at_event === null || input.replayAtPrev.registered_at_event > prevHead
        ? `the handle "${parsed.at_head.handle}" was not registered at or below HEAD - 25 (${prevHead})`
        : `the handle "${parsed.at_head.handle}" had no verdict at or below HEAD - 25 (${prevHead}), so its second line proves no replay; pick a member with a judged submission`,
    );
  }
  if (eligible && !okH) parts.push(`at HEAD ${parsed.head} the artifact says "${ch}", the replay gives "${rh}"`);
  if (eligible && !okP) parts.push(`at HEAD - 25 (${prevHead}) the artifact says "${cp}", the replay gives "${rp}"`);
  const reason =
    `${ACTOR}: rejected. ` +
    parts.join("; ") +
    ". " +
    (eligible && okH && okP ? `Both standing lines are otherwise correct. ` : "") +
    "This verdict clears the pending slot; a fresh submission is welcome.";
  return { verdict: "rejected", evidence, reason: reasonLimit(reason) };
}

export type RunOutcome =
  | { ok: true; result: "accepted" | "rejected" | "unreadable" }
  | { ok: false; error: string; status: number };

export async function runRecordReplay(env: Env, submissionId: number): Promise<RunOutcome> {
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

  const parsed = parseT2Artifact(read.text);
  if (!parsed.ok) {
    const reason = reasonLimit(`${ACTOR}: rejected. The artifact does not follow the format in https://ergonia.works/api/verifiers/record-replay: ${parsed.reason}. This verdict clears the pending slot; a fresh submission is welcome.`);
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
  const handle = parsed.value.at_head.handle;
  const events = await loadEventsUpTo(env, head);
  const replayAtHead = replayMemberRecord(events, handle, head);
  const replayAtPrev = replayMemberRecord(events, handle, head - LOOKBACK);
  const decided = decideRecordReplay({ submissionEventId: eventId, parsed: parsed.value, source: read.source, replayAtHead, replayAtPrev });
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
      handle: decided.evidence.handle,
      eligible_handle: decided.evidence.eligible_handle,
      at_head_matched: decided.evidence.at_head_matched,
      at_head_minus_25_matched: decided.evidence.at_head_minus_25_matched,
      artifact_source: read.source.kind,
    },
  });
  return { ok: true, result: decided.verdict };
}
