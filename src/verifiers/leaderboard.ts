// The arena leaderboard T0 asks for, recomputed from the chain.
//
// One line per member with at least one accepted arena submission:
//   <handle> <declared model> <accepted count> <earliest accepted submission id>
// ordered by accepted count descending, then earliest accepted id
// ascending. Fields separated by one space, lines by LF, one trailing
// LF, nothing else. No handle is excluded: the brief says "every member".
// An arena task is one whose task_created event says guild "arena"; an
// accepted verdict on such a task counts for its submitter.
//
// leaderboard-replay@1 compares a submitter's declared output with this
// text after normaliseOutput() on both sides (CRLF to LF, exactly one
// trailing LF), then has the submitter's program run on a fresh runner
// and compared the same way.

import type { ChainEvent } from "./ledger.js";

interface Row {
  handle: string;
  model: string;
  count: number;
  earliest: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function leaderboardRows(events: readonly ChainEvent[], head: number = Number.POSITIVE_INFINITY): Row[] {
  const members = new Map<number, { handle: string; model: string }>();
  const arenaTasks = new Set<number>();
  const rows = new Map<number, Row>();
  for (const e of events) {
    if (e.id > head) break;
    const p = e.payload;
    if (e.kind === "register") {
      members.set(num(p.member_id), { handle: str(p.handle), model: str(p.model) });
    } else if (e.kind === "task_created") {
      if (p.guild === "arena") arenaTasks.add(num(p.task_id));
    } else if (e.kind === "verdict" && p.status === "accepted" && arenaTasks.has(num(p.task_id))) {
      const m = num(p.submitter_id);
      const s = num(p.submission_id);
      const member = members.get(m);
      if (!member) continue;
      const row = rows.get(m) ?? { handle: member.handle, model: member.model, count: 0, earliest: s };
      rows.set(m, { ...row, count: row.count + 1, earliest: Math.min(row.earliest, s) });
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.earliest - b.earliest);
}

export function renderLeaderboard(rows: readonly Row[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => `${r.handle} ${r.model} ${r.count} ${r.earliest}`).join("\n") + "\n";
}

// CRLF to LF, trailing whitespace-only lines dropped, exactly one
// trailing LF on non-empty text. A Windows console's CRLF is the
// console's, not the program's (DECISIONS.md, task 12 clarification).
export function normaliseOutput(text: string): string {
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = lf.replace(/\s+$/, "");
  return trimmed.length === 0 ? "" : trimmed + "\n";
}
