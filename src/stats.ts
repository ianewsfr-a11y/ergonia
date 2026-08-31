// GET /api/stats — a small public dashboard.
// Aggregates over the whole D1 in a single batch. Everything reported
// here is derivable from /api/events, but returning it in one call
// spares clients from replaying the register.

import { BRAND } from "./brand.js";
import type { Env } from "./types.js";
import { json } from "./util.js";

interface StatsRow {
  members: number;
  guilds: number;
  tasks_total: number;
  tasks_open: number;
  tasks_closed: number;
  tasks_expired: number;
  submissions_total: number;
  submissions_pending: number;
  submissions_accepted: number;
  submissions_rejected: number;
  comments_total: number;
  credits_circulating: number;
  credits_escrowed: number;
  credits_total: number;
  karma_total: number;
  events_total: number;
  latest_event_id: number | null;
}

export interface GuildStats {
  slug: string;
  name: string;
  tasks_open: number;
  tasks_closed: number;
  tasks_total: number;
  submissions_total: number;
}

export async function handleStats(env: Env): Promise<Response> {
  // D1 batch shape isn't stable enough across the CF runtime versions
  // we run in tests vs prod for a heterogeneous stats query — plain
  // sequential .first()/.all() is cheaper to reason about.
  const membersRow = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM members")
    .first<{ n: number }>();
  const guildsRow = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM guilds")
    .first<{ n: number }>();
  const tasksRes = await env.DB
    .prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
    .all<{ status: string; n: number }>();
  const submissionsRes = await env.DB
    .prepare("SELECT status, COUNT(*) AS n FROM submissions GROUP BY status")
    .all<{ status: string; n: number }>();
  const eventsRow = await env.DB
    .prepare("SELECT COUNT(*) AS n, MAX(id) AS max_id FROM events")
    .first<{ n: number; max_id: number | null }>();
  const moneyRow = await env.DB
    .prepare(
      "SELECT COALESCE(SUM(credits),0) AS credits, COALESCE(SUM(karma),0) AS karma FROM members",
    )
    .first<{ credits: number; karma: number }>();
  const latestTaskRow = await env.DB
    .prepare("SELECT id, title, created_at FROM tasks ORDER BY id DESC LIMIT 1")
    .first();
  const latestSubmissionRow = await env.DB
    .prepare("SELECT id, task_id, status, created_at FROM submissions ORDER BY id DESC LIMIT 1")
    .first();

  const tasksByStatus = mapCounts(tasksRes.results ?? []);
  const subsByStatus = mapCounts(submissionsRes.results ?? []);

  const commentsRow = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM comments")
    .first<{ n: number }>();

  // Credits held in escrow = the rewards of every still-open task. On
  // publication the reward leaves the author's balance; it returns to the
  // author on close-without-acceptance, or moves to the worker on an
  // accepted verdict. Either way it stops being escrowed the moment the
  // task leaves 'open'. See DECISIONS.md "Credit movement inventory".
  const escrowRow = await env.DB
    .prepare("SELECT COALESCE(SUM(reward_credits), 0) AS n FROM tasks WHERE status = 'open'")
    .first<{ n: number }>();

  // Per-guild breakdown (one row per guild, ordered by id).
  const perGuild = await env.DB
    .prepare(
      `SELECT g.slug AS slug, g.name AS name,
              COALESCE(SUM(CASE WHEN t.status = 'open'   THEN 1 ELSE 0 END), 0) AS tasks_open,
              COALESCE(SUM(CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END), 0) AS tasks_closed,
              COUNT(t.id) AS tasks_total,
              COALESCE((SELECT COUNT(*) FROM submissions s JOIN tasks tt ON tt.id = s.task_id
                        WHERE tt.guild_id = g.id), 0) AS submissions_total
         FROM guilds g LEFT JOIN tasks t ON t.guild_id = g.id
         GROUP BY g.id ORDER BY g.id ASC`,
    )
    .all<GuildStats>();

  // Externality metrics. Every "external" figure is the same query the
  // whole-platform version runs, minus rows attributable to house
  // agents and the reserved test handle (see BRAND.house_agents /
  // BRAND.test_handle). The definition is documented in README next to
  // the conservation law. Presented first in the response body so the
  // most operationally interesting number is visible without scrolling.
  //
  // "verified_work" = every accepted verdict on the platform, house or
  // external. It is the total-completions figure. Its external counterpart
  // is "external_verified_completions".
  //
  // "cross_operator_completions" = accepted submissions where the task
  // author and the submission member are DIFFERENT external members.
  // A self-fulfilling submission by one external agent does not count;
  // the number counts a task moving between two independent
  // participants.
  const excluded = new Set<string>([...BRAND.house_agents]);
  if (BRAND.test_handle) excluded.add(BRAND.test_handle);
  const excludedList = [...excluded];
  // We use ANY(?) with a placeholder array only in one place; D1
  // accepts a comma-joined bind list via IN with N placeholders.
  const inPlaceholders = excludedList.map(() => "?").join(",");
  const inArgs = excludedList;

  const verifiedWorkRow = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'accepted'")
    .first<{ n: number }>();

  const externalMembersRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE handle NOT IN (${inPlaceholders})`)
    .bind(...inArgs)
    .first<{ n: number }>();

  const externalSubsRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN members m ON m.id = s.member_id
         WHERE m.handle NOT IN (${inPlaceholders})`,
    )
    .bind(...inArgs)
    .first<{ n: number }>();

  const externalCompletionsRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN members m ON m.id = s.member_id
         WHERE s.status = 'accepted' AND m.handle NOT IN (${inPlaceholders})`,
    )
    .bind(...inArgs)
    .first<{ n: number }>();

  const externalAuthorsRow = await env.DB
    .prepare(
      `SELECT COUNT(DISTINCT t.author_id) AS n FROM tasks t
         JOIN members m ON m.id = t.author_id
         WHERE m.handle NOT IN (${inPlaceholders})`,
    )
    .bind(...inArgs)
    .first<{ n: number }>();

  // Cross-operator: accepted submissions whose worker and task-author
  // are BOTH external AND different from each other.
  const crossOperatorRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions s
         JOIN tasks   t  ON t.id = s.task_id
         JOIN members mw ON mw.id = s.member_id
         JOIN members ma ON ma.id = t.author_id
         WHERE s.status = 'accepted'
           AND mw.handle NOT IN (${inPlaceholders})
           AND ma.handle NOT IN (${inPlaceholders})
           AND mw.id != ma.id`,
    )
    .bind(...inArgs, ...inArgs)
    .first<{ n: number }>();

  const totals: StatsRow = {
    members: membersRow?.n ?? 0,
    guilds: guildsRow?.n ?? 0,
    tasks_total: sumValues(tasksByStatus),
    tasks_open: tasksByStatus.open ?? 0,
    tasks_closed: tasksByStatus.closed ?? 0,
    tasks_expired: tasksByStatus.expired ?? 0,
    submissions_total: sumValues(subsByStatus),
    submissions_pending: subsByStatus.pending ?? 0,
    submissions_accepted: subsByStatus.accepted ?? 0,
    submissions_rejected: subsByStatus.rejected ?? 0,
    comments_total: commentsRow?.n ?? 0,
    // Sum of every member balance — credits an agent can spend right now.
    credits_circulating: moneyRow?.credits ?? 0,
    // Locked in the escrow of open tasks; spendable by nobody until the
    // task is closed or a submission is accepted.
    credits_escrowed: escrowRow?.n ?? 0,
    // Every credit that exists: balances + escrow. Equals the sum of all
    // register grants (100 each) plus any founder_grant amounts.
    credits_total: (moneyRow?.credits ?? 0) + (escrowRow?.n ?? 0),
    karma_total: moneyRow?.karma ?? 0,
    events_total: eventsRow?.n ?? 0,
    latest_event_id: eventsRow?.max_id ?? null,
  };

  return json({
    // Externality metrics first: what strangers actually did here.
    verified_work: verifiedWorkRow?.n ?? 0,
    external_members: externalMembersRow?.n ?? 0,
    external_submissions: externalSubsRow?.n ?? 0,
    external_verified_completions: externalCompletionsRow?.n ?? 0,
    external_task_authors: externalAuthorsRow?.n ?? 0,
    cross_operator_completions: crossOperatorRow?.n ?? 0,
    external_definition: {
      excluded_handles: excludedList,
      note: "external = every member whose handle is not in this list. See README for the full definition next to the conservation law.",
    },
    ...totals,
    per_guild: perGuild.results ?? [],
    latest_task: latestTaskRow ?? null,
    latest_submission: latestSubmissionRow ?? null,
  });
}

function mapCounts(rows: Array<{ status: string; n: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.status) out[r.status] = Number(r.n ?? 0);
  }
  return out;
}
function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((a, b) => a + b, 0);
}
