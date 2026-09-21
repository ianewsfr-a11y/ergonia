// Replay of one member's standing from the chain, inside the Worker.
//
// The same derivations GET /api/members/<handle>/record computes from
// the tables, recomputed from /api/events alone, so the two can be
// compared at a head. The record endpoint is the reference: where these
// rules and the endpoint disagree at a head they can both be read at,
// the endpoint wins and the verdict says so (tessera, task 24, brief).
//
// Rules, stated so a submitter can reproduce them:
//   register        binds handle -> member_id, and is the member's birth
//   task_created    binds task_id -> guild, needed for arena_wins
//   verdict         with submitter_id == the member:
//                     status accepted -> accepted + 1
//                     status rejected -> rejected + 1
//                     accepted on a task created in guild arena -> arena_wins + 1
//                     karma += karma_delta (the only source of karma in
//                     the whole platform: src/verdicts.ts grants it on
//                     acceptance and nothing else ever writes the column)
//   any event whose payload names the member by one of the five id
//   fields below is a "proof event"; the newest one at or below the head
//   is last_proof_event_id. The same five fields the record endpoint
//   matches: member_id, author_id, submitter_id, from_member_id,
//   to_member_id. A member named only by handle in a payload that also
//   carries its member_id is already covered.

import type { ChainEvent } from "./ledger.js";

// The id-bearing payload fields that make an event name a member.
// Identical to the list in src/record.ts; a change there is a change
// here in the same commit.
export const PROOF_ID_FIELDS = ["member_id", "author_id", "submitter_id", "from_member_id", "to_member_id"] as const;

export interface MemberStanding {
  handle: string;
  member_id: number | null;
  accepted: number;
  rejected: number;
  arena_wins: number;
  karma: number;
  last_proof_event_id: number | null;
  // Not part of the declared line; used to refuse a head at which the
  // member did not exist or had done nothing yet.
  registered_at_event: number | null;
  judged_at_head: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function replayMemberRecord(events: readonly ChainEvent[], handle: string, head: number): MemberStanding {
  let memberId: number | null = null;
  let registeredAt: number | null = null;
  const guildOf = new Map<number, string>();
  let accepted = 0;
  let rejected = 0;
  let arenaWins = 0;
  let karma = 0;
  let lastProof: number | null = null;

  for (const e of events) {
    if (e.id > head) break;
    const p = e.payload;
    if (e.kind === "register" && p.handle === handle) {
      memberId = num(p.member_id);
      registeredAt = e.id;
    }
    if (e.kind === "task_created") guildOf.set(num(p.task_id), typeof p.guild === "string" ? p.guild : "");
    if (memberId === null) continue;
    if (e.kind === "verdict" && num(p.submitter_id) === memberId) {
      if (p.status === "accepted") {
        accepted += 1;
        if (guildOf.get(num(p.task_id)) === "arena") arenaWins += 1;
      } else if (p.status === "rejected") {
        rejected += 1;
      }
      karma += num(p.karma_delta);
    }
    for (const f of PROOF_ID_FIELDS) {
      if (p[f] === memberId) {
        lastProof = e.id;
        break;
      }
    }
  }

  return {
    handle,
    member_id: memberId,
    accepted,
    rejected,
    arena_wins: arenaWins,
    karma,
    last_proof_event_id: lastProof,
    registered_at_event: registeredAt,
    judged_at_head: accepted + rejected,
  };
}

// The one declared line, in the order the manifest states.
export function standingLine(s: MemberStanding): string {
  return `${s.handle} ${s.accepted} ${s.rejected} ${s.arena_wins} ${s.karma} ${s.last_proof_event_id ?? 0}`;
}
