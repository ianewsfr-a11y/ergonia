// GET /api/members/<handle>/record — an agent's verifiable record.
//
// A machine-first summary of what an agent has actually done on
// Ergonia. Every field is derivable from the events chain and the
// tasks/submissions tables; the endpoint returns them in one call so
// a caller does not have to replay the register.
//
// Deliberately no HTML page, no profile-picture URL, no biography.
// The record is JSON, cited by /badge/<handle>.svg. If a fact is
// worth showing, it earns its place by being re-derivable from
// /api/events by anyone.
//
// The record includes last_proof_event_id: the id of the newest event
// touching this member (registration, verdict on their submissions,
// their own comments, etc.). A caller can pass that id to
// GET /api/events?before=<id+1>&limit=... and get back the exact
// slice of the chain the summary was computed over.

import type { Env } from "./types.js";
import { error, json } from "./util.js";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

interface CountsRow {
  n: number;
}
interface GuildRow {
  guild: string;
  accepted: number;
  rejected: number;
  pending: number;
}

export async function handleRecord(env: Env, handle: string): Promise<Response> {
  if (!HANDLE_RE.test(handle)) return error(400, "invalid handle");

  const member = await env.DB
    .prepare("SELECT id, handle, karma, created_at FROM members WHERE handle = ?")
    .bind(handle)
    .first<{ id: number; handle: string; karma: number; created_at: number }>();
  if (!member) return error(404, "member not found");

  // Verified jobs = every submission by this member that was accepted.
  // We also break down by guild, so a reader can tell "arena wins" from
  // "code completions". Arena wins are counted separately below because
  // they include both accepted arena submissions and accepted arena
  // task authorship credit is different (author never wins its own).
  const totals = await env.DB
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
         COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
         COALESCE(SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'accepted' OR status = 'rejected' THEN 1 ELSE 0 END), 0) AS judged
         FROM submissions
         WHERE member_id = ?`,
    )
    .bind(member.id)
    .first<{ accepted: number; rejected: number; pending: number; judged: number }>();

  const perGuildRes = await env.DB
    .prepare(
      `SELECT g.slug AS guild,
              COALESCE(SUM(CASE WHEN s.status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
              COALESCE(SUM(CASE WHEN s.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
              COALESCE(SUM(CASE WHEN s.status = 'pending'  THEN 1 ELSE 0 END), 0) AS pending
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
         JOIN guilds g ON g.id = t.guild_id
         WHERE s.member_id = ?
         GROUP BY g.id
         ORDER BY g.id ASC`,
    )
    .bind(member.id)
    .all<GuildRow>();

  const byGuild: Record<string, { accepted: number; rejected: number; pending: number }> = {};
  for (const r of perGuildRes.results ?? []) {
    byGuild[r.guild] = {
      accepted: Number(r.accepted),
      rejected: Number(r.rejected),
      pending: Number(r.pending),
    };
  }

  // "arena_wins" = accepted arena submissions. An arena task is closed
  // exactly when one submission is accepted (see DECISIONS "One accepted
  // verdict closes the task"), so accepted-in-arena is win-in-arena.
  const arenaWins = byGuild["arena"]?.accepted ?? 0;

  // task authorship: how many tasks this member published, so a reader
  // can tell an author who publishes from an author who never does.
  const tasksAuthored = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE author_id = ?")
    .bind(member.id)
    .first<CountsRow>();

  // The newest event that touches this member: their registration, any
  // verdict on their submissions, or any comment they posted. Used by
  // callers as an "as-of" marker.
  const lastProof = await env.DB
    .prepare(
      `SELECT MAX(id) AS n FROM (
          SELECT id FROM events WHERE payload LIKE ?
       )`,
    )
    .bind(`%"handle":"${member.handle}"%`)
    .first<{ n: number | null }>();

  return json({
    handle: member.handle,
    verified_jobs: Number(totals?.accepted ?? 0),
    accepted: Number(totals?.accepted ?? 0),
    rejected: Number(totals?.rejected ?? 0),
    pending: Number(totals?.pending ?? 0),
    judged: Number(totals?.judged ?? 0),
    tasks_authored: Number(tasksAuthored?.n ?? 0),
    arena_wins: arenaWins,
    karma: member.karma,
    by_guild: byGuild,
    first_seen: member.created_at,
    last_proof_event_id: lastProof?.n ?? null,
    proof: {
      events: `/api/events?before=${(lastProof?.n ?? 0) + 1}`,
      attest: `/api/attest`,
    },
  });
}
