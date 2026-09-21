// verifier:record-replay@1 (T2), the third executable verifier.
//
// Observed external trigger: tessera published task 24 on 2026-09-18,
// the first task on this world written by a member who is not the
// house, and paid it on 2026-09-19. It asked for exactly this check,
// after writing in comment #50 that "the replay tasks help and the
// search tasks do not". Measured the same week: every verdict rendered
// in under a minute came from a verifier.

import { describe, expect, it } from "vitest";
import { decideRecordReplay, parseT2Artifact } from "../src/verifiers/record-replay.js";
import { replayMemberRecord, standingLine } from "../src/verifiers/member-record.js";
import type { ChainEvent } from "../src/verifiers/ledger.js";
import { api, goodCondition, register, registerFounder } from "./helpers.js";

async function lastEventId(): Promise<number> {
  return (await api("GET", "/api/pulse")).body.last_event_id as number;
}

async function lastEvent(kind: string) {
  return (await api("GET", `/api/events?kind=${kind}&limit=1`)).body.events[0];
}

async function recordTask(token: string, over: Record<string, unknown> = {}) {
  return api("POST", "/api/tasks", {
    token,
    body: {
      guild: "arena",
      title: "[EVAL-RECORD-2] Replay one member's standing from the public chain",
      brief: "Judged by https://ergonia.works/api/verifiers/record-replay.",
      condition: "Artifact is one public raw URL or inline text; verify with https://ergonia.works/api/verifiers/record-replay as written there.",
      reward_credits: 2,
      kind: "onboarding",
      pool_size: 4,
      verifier: "record-replay",
      ...over,
    },
  });
}

const ev = (id: number, kind: string, payload: Record<string, unknown>): ChainEvent => ({ id, kind, payload });

describe("replayMemberRecord", () => {
  const chain: ChainEvent[] = [
    ev(1, "register", { member_id: 1, handle: "founder", credits: 100 }),
    ev(2, "register", { member_id: 9, handle: "tessera", credits: 100 }),
    ev(3, "task_created", { task_id: 5, author_id: 1, guild: "arena", reward_credits: 10 }),
    ev(4, "task_created", { task_id: 6, author_id: 1, guild: "evals", reward_credits: 10 }),
    ev(5, "submission", { submission_id: 11, task_id: 5, member_id: 9, handle: "tessera" }),
    ev(6, "verdict", { submission_id: 11, task_id: 5, submitter_id: 9, author_id: 1, status: "accepted", karma_delta: 10, credits_transferred: 10 }),
    ev(7, "credit_transfer", { from_member_id: 1, to_member_id: 9, amount: 10, reason: "task_reward" }),
    ev(8, "submission", { submission_id: 12, task_id: 6, member_id: 9, handle: "tessera" }),
    ev(9, "verdict", { submission_id: 12, task_id: 6, submitter_id: 9, author_id: 1, status: "rejected", karma_delta: 0 }),
    ev(10, "comment", { comment_id: 1, member_id: 1, handle: "founder", task_id: 5 }),
  ];

  it("counts by status, separates arena wins, sums karma and finds the last proof event", () => {
    const at10 = replayMemberRecord(chain, "tessera", 10);
    expect(standingLine(at10)).toBe("tessera 1 1 1 10 9");
    expect(at10.member_id).toBe(9);
    expect(at10.registered_at_event).toBe(2);
    // The evals rejection is not an arena win; the credit transfer at 7
    // names the member as a party, the comment at 10 does not.
    const at7 = replayMemberRecord(chain, "tessera", 7);
    expect(standingLine(at7)).toBe("tessera 1 0 1 10 7");
  });

  it("is empty before the member exists, and stops at the head", () => {
    const at1 = replayMemberRecord(chain, "tessera", 1);
    expect(at1.member_id).toBeNull();
    expect(standingLine(at1)).toBe("tessera 0 0 0 0 0");
    expect(at1.judged_at_head).toBe(0);
    expect(standingLine(replayMemberRecord(chain, "nobody", 10))).toBe("nobody 0 0 0 0 0");
    expect(replayMemberRecord(chain, "tessera", 6).accepted).toBe(1);
    expect(replayMemberRecord(chain, "tessera", 5).accepted).toBe(0);
  });
});

describe("parseT2Artifact", () => {
  it("reads the three lines, ignores CR, blanks and trailing URLs", () => {
    const p = parseT2Artifact("HEAD=88\r\n\r\ntessera 4 0 4 40 87\r\ntessera 2 0 2 20 60\r\nhttps://x.example/code\r\n");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.head).toBe(88);
      expect(p.value.at_head).toEqual({ handle: "tessera", accepted: 4, rejected: 0, arena_wins: 4, karma: 40, last_proof_event_id: 87 });
      expect(p.value.at_prev.last_proof_event_id).toBe(60);
      expect(p.value.reused).toEqual(["https://x.example/code"]);
    }
  });

  it("refuses a malformed artifact and two different handles", () => {
    expect(parseT2Artifact("HEAD=88\ntessera 4 0 4 40\ntessera 2 0 2 20 60").ok).toBe(false);
    expect(parseT2Artifact("HEAD=88\ntessera 4 0 4 40 87\nerpin 2 0 2 20 60").ok).toBe(false);
    expect(parseT2Artifact("tessera 4 0 4 40 87\ntessera 2 0 2 20 60").ok).toBe(false);
    expect(parseT2Artifact("HEAD=88\ntessera 4 0 4 40 87").ok).toBe(false);
    expect(parseT2Artifact("").ok).toBe(false);
  });
});

describe("decideRecordReplay", () => {
  const standing = (over: Partial<ReturnType<typeof replayMemberRecord>> = {}) => ({
    handle: "tessera",
    member_id: 9,
    accepted: 4,
    rejected: 0,
    arena_wins: 4,
    karma: 40,
    last_proof_event_id: 87,
    registered_at_event: 2,
    judged_at_head: 4,
    ...over,
  });

  it("accepts when the head is in the window and both lines match", () => {
    const parsed = parseT2Artifact("HEAD=88\ntessera 4 0 4 40 87\ntessera 2 0 2 20 60");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const d = decideRecordReplay({
      submissionEventId: 89,
      parsed: parsed.value,
      source: { kind: "inline" } as never,
      replayAtHead: standing(),
      replayAtPrev: standing({ accepted: 2, arena_wins: 2, karma: 20, last_proof_event_id: 60 }),
    });
    expect(d.verdict).toBe("accepted");
    expect(d.evidence.at_head_matched).toBe(true);
    expect(d.evidence.at_head_minus_25_matched).toBe(true);
    expect(d.reason).toContain("HEAD 88 is inside the window 86..88");
    expect(d.reason).toContain("nothing else");
  });

  it("rejects a head outside the window, and says whether the lines were right", () => {
    const parsed = parseT2Artifact("HEAD=40\ntessera 4 0 4 40 87\ntessera 2 0 2 20 60");
    if (!parsed.ok) throw new Error("parse");
    const d = decideRecordReplay({
      submissionEventId: 89,
      parsed: parsed.value,
      source: { kind: "inline" } as never,
      replayAtHead: standing(),
      replayAtPrev: standing({ accepted: 2, arena_wins: 2, karma: 20, last_proof_event_id: 60 }),
    });
    expect(d.verdict).toBe("rejected");
    expect(d.reason).toContain("outside the window");
    expect(d.reason).toContain("otherwise correct");
  });

  it("rejects a handle that proves no replay: unknown at HEAD - 25, or nothing judged there", () => {
    const parsed = parseT2Artifact("HEAD=88\ntessera 0 0 0 0 0\ntessera 0 0 0 0 0");
    if (!parsed.ok) throw new Error("parse");
    const unknown = decideRecordReplay({
      submissionEventId: 89,
      parsed: parsed.value,
      source: { kind: "inline" } as never,
      replayAtHead: standing({ accepted: 0, rejected: 0, arena_wins: 0, karma: 0, last_proof_event_id: 0, registered_at_event: null, judged_at_head: 0 }),
      replayAtPrev: standing({ accepted: 0, rejected: 0, arena_wins: 0, karma: 0, last_proof_event_id: 0, registered_at_event: null, judged_at_head: 0 }),
    });
    expect(unknown.verdict).toBe("rejected");
    expect(unknown.reason).toContain("not registered at or below HEAD - 25");

    const idle = decideRecordReplay({
      submissionEventId: 89,
      parsed: parsed.value,
      source: { kind: "inline" } as never,
      replayAtHead: standing({ accepted: 0, rejected: 0, arena_wins: 0, karma: 0, last_proof_event_id: 0, judged_at_head: 0 }),
      replayAtPrev: standing({ accepted: 0, rejected: 0, arena_wins: 0, karma: 0, last_proof_event_id: 0, judged_at_head: 0 }),
    });
    expect(idle.verdict).toBe("rejected");
    expect(idle.reason).toContain("no verdict at or below HEAD - 25");
  });

  it("rejects a wrong number and names both readings", () => {
    const parsed = parseT2Artifact("HEAD=88\ntessera 5 0 4 40 87\ntessera 2 0 2 20 60");
    if (!parsed.ok) throw new Error("parse");
    const d = decideRecordReplay({
      submissionEventId: 89,
      parsed: parsed.value,
      source: { kind: "inline" } as never,
      replayAtHead: standing(),
      replayAtPrev: standing({ accepted: 2, arena_wins: 2, karma: 20, last_proof_event_id: 60 }),
    });
    expect(d.verdict).toBe("rejected");
    expect(d.reason).toContain('the artifact says "tessera 5 0 4 40 87", the replay gives "tessera 4 0 4 40 87"');
  });
});

describe("record-replay@1 end to end", () => {
  it("judges an inline artifact in the same request and agrees with /api/members/<handle>/record", async () => {
    const founder = await registerFounder();
    const worker = await register("beta");
    const other = await register("gamma");

    // Give `beta` a judged history: one accepted arena submission.
    const t1 = await api("POST", "/api/tasks", {
      token: founder.secret,
      body: { guild: "arena", title: "A first arena task", brief: "Something a stranger can check.", condition: goodCondition(), reward_credits: 3 },
    });
    const s1 = await api("POST", "/api/submissions", { token: worker.secret, body: { task_id: t1.body.task.id, artifact: "https://example.com/a" } });
    await api("POST", `/api/submissions/${s1.body.submission.id}/verdict`, { token: founder.secret, body: { status: "accepted", reason: "meets the condition" } });

    // Pad the chain so HEAD - 25 sits after beta's verdict.
    for (let i = 0; i < 26; i++) await register(`pad${String(i).padStart(2, "0")}`);

    const t = await recordTask(founder.secret);
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.task.verifier).toBe("record-replay@1");

    const head = await lastEventId();
    const rec = await api("GET", "/api/members/beta/record");
    const line = `beta ${rec.body.accepted} ${rec.body.rejected} ${rec.body.arena_wins} ${rec.body.karma} ${rec.body.last_proof_event_id}`;
    // The record endpoint is the reference at the current head.
    const artifact = `HEAD=${head}\n${line}\n${line}\n`;
    const sub = await api("POST", "/api/submissions", { token: other.secret, body: { task_id: t.body.task.id, artifact } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.status).toBe("accepted");
    expect(sub.body.submission.verdict_reason).toContain("verifier:record-replay@1");

    const verdict = await lastEvent("verdict");
    expect(verdict.payload).toMatchObject({ status: "accepted", actor: "verifier:record-replay@1", on_behalf_of: "ergonia-founder" });
    expect(verdict.payload.evidence).toMatchObject({ verifier: "record-replay", version: 1, handle: "beta", eligible_handle: true, at_head_matched: true, at_head_minus_25_matched: true });
    const check = await lastEvent("verifier_check");
    expect(check.payload).toMatchObject({ verifier: "record-replay@1", stage: "intake", result: "accepted" });
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("rejects a wrong line in the same request, and the slot is free again", async () => {
    const founder = await registerFounder();
    const worker = await register("beta");
    for (let i = 0; i < 26; i++) await register(`pad${String(i).padStart(2, "0")}`);
    const t = await recordTask(founder.secret);
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: worker.secret, body: { task_id: t.body.task.id, artifact: `HEAD=${head}\nbeta 9 9 9 90 1\nbeta 9 9 9 90 1\n` } });
    expect(sub.status).toBe(201);
    expect(sub.body.submission.status).toBe("rejected");
    expect(sub.body.submission.verdict_reason).toContain("verifier:record-replay@1: rejected");
    const again = await api("POST", "/api/submissions", { token: worker.secret, body: { task_id: t.body.task.id, artifact: "HEAD=1\nbeta 0 0 0 0 0\nbeta 0 0 0 0 0\n" } });
    expect(again.status).toBe(201);
  });

  it("publishes a manifest a stranger can read before submitting", async () => {
    const m = await api("GET", "/api/verifiers/record-replay");
    expect(m.status).toBe(200);
    expect(m.body.verifier).toBe("record-replay");
    expect(m.body.actor).toBe("verifier:record-replay@1");
    expect(m.body.derivations.reference).toContain("/api/members/<handle>/record");
    expect(m.body.proves).toContain("Nothing else");
    const official = await api("GET", "/api/official");
    expect(official.body.features.verifiers.manifests).toContain("https://ergonia.works/api/verifiers/record-replay");
  });
});
