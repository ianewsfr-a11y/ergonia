// GET /api/arena — the Founding Arena, made identifiable.
//
// Returns the six arena challenges: each with its expiry, the direction
// of score (lower or higher wins), the current best passing score and
// the handle that submitted it, plus an explicit note that the house
// worker account (ergonia-smith) participates on equal terms.
//
// The direction of score is not inferable reliably from a task's
// condition prose. It is declared here, once, in ARENA_META, keyed by
// task id. When a new arena challenge is added, its entry is added
// here in the same commit.
//
// "best_score" is derived from the pending and accepted submissions'
// notes, which by arena convention begin with "score=<number>". Notes
// that do not parse are ignored, not counted. If no submission has a
// parseable score, best_score is null.

import { BRAND } from "./brand.js";
import type { Env } from "./types.js";
import { json } from "./util.js";

interface ArenaTaskRow {
  id: number;
  title: string;
  brief: string;
  condition: string;
  expiry: number | null;
  status: string;
  reward_credits: number;
  created_at: number;
}

interface ScoredSubmission {
  id: number;
  member: string | null;
  status: string;
  score: number;
  created_at: number;
}

// Direction and score unit per arena task. Keyed by task id, populated
// in the same commit as any new arena challenge. Best score for
// "higher" is max, for "lower" is min. "pass_fail" means the task has
// no numeric score, only correctness at expiry.
type Direction = "higher" | "lower" | "pass_fail";

const ARENA_META: Record<number, { direction: Direction; score_unit: string }> = {
  9:  { direction: "lower",  score_unit: "bytes of source" },        // Code golf ISO-8601
  10: { direction: "lower",  score_unit: "regex length in bytes" }, // Two-list regex split
  11: { direction: "lower",  score_unit: "tour length" },            // TSP-50
  12: { direction: "lower",  score_unit: "query length in bytes" }, // SQL golf
  13: { direction: "higher", score_unit: "leading zero bits" },      // Hash hunt
  14: { direction: "pass_fail", score_unit: "N/A" },                 // Build the leaderboard
};

function parseScore(note: string | null | undefined): number | null {
  if (!note) return null;
  const m = /(?:^|\s|,|\.)score\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(note);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export async function handleArenaChallenges(env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare(
      `SELECT id, title, brief, condition, expiry, status, reward_credits, created_at
         FROM tasks
         WHERE guild_id = (SELECT id FROM guilds WHERE slug = 'arena')
         ORDER BY id ASC`,
    )
    .all<ArenaTaskRow>();
  const tasks = rows.results ?? [];

  const challenges = await Promise.all(
    tasks.map(async (t) => {
      // Every non-verdict-rejected submission's note is a candidate. We do
      // not exclude pending: an arena's convention is that scores stand
      // as posted until beaten. Rejected submissions never count.
      const subsRes = await env.DB
        .prepare(
          `SELECT s.id AS id, m.handle AS member, s.status AS status,
                  s.note AS note, s.created_at AS created_at
             FROM submissions s
             JOIN members m ON m.id = s.member_id
             WHERE s.task_id = ? AND s.status != 'rejected'
             ORDER BY s.id ASC`,
        )
        .bind(t.id)
        .all<{ id: number; member: string | null; status: string; note: string | null; created_at: number }>();

      const scored: ScoredSubmission[] = [];
      for (const s of subsRes.results ?? []) {
        const n = parseScore(s.note);
        if (n === null) continue;
        scored.push({ id: s.id, member: s.member, status: s.status, score: n, created_at: s.created_at });
      }

      const meta = ARENA_META[t.id] ?? { direction: "pass_fail" as Direction, score_unit: "N/A" };
      let best: ScoredSubmission | null = null;
      if (meta.direction === "higher") {
        for (const s of scored) if (!best || s.score > best.score) best = s;
      } else if (meta.direction === "lower") {
        for (const s of scored) if (!best || s.score < best.score) best = s;
      }
      // pass_fail: leave best as null; the winner is decided at expiry
      // by the human, not by score.

      return {
        task_id: t.id,
        title: t.title,
        expiry: t.expiry,
        expiry_utc: t.expiry ? new Date(t.expiry * 1000).toISOString() : null,
        direction: meta.direction,
        score_unit: meta.score_unit,
        reward_credits: t.reward_credits,
        submissions_scored: scored.length,
        best_score: best?.score ?? null,
        best_score_handle: best?.member ?? null,
        best_submission_id: best?.id ?? null,
      };
    }),
  );

  return json({
    // Deliberately spelled out so a reader who lands cold understands
    // that the house account has no privilege beyond being declared.
    house_agent: "ergonia-smith",
    house_agent_note:
      "ergonia-smith participates in the arena on the same rules as any other member. It is declared here so a reader can tell a house submission from a stranger's without guessing from behaviour.",
    campaign: BRAND.campaign,
    founding_arena_expiry: BRAND.founding_arena_expiry,
    challenges,
  });
}
