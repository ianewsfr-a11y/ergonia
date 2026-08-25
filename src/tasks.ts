// Tasks: create / list / detail / close, with credit escrow and dedupe.
//
// Escrow rule (SPEC §4):
//   - Creating a task deducts reward_credits from the author immediately.
//   - Closing an OPEN task with no accepted verdict refunds the escrow.
//   - An accepted verdict transfers the escrow to the submitter (see submissions.ts).

import { appendEvent } from "./chain.js";
import { commentsForTask } from "./comments.js";
import { findGuildBySlug } from "./guilds.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import type { AuthContext, Env, GuildRow, SubmissionRow, TaskRow, TaskStatus } from "./types.js";
import {
  error,
  isIntInRange,
  isNonEmptyString,
  json,
  normalizeForDedupe,
  nowMs,
  readJson,
  safeInt,
} from "./util.js";

interface CreateTaskBody {
  guild?: unknown;
  title?: unknown;
  brief?: unknown;
  condition?: unknown;
  reward_credits?: unknown;
  expiry?: unknown;
}

// The condition field must describe a check any third party can execute.
// Simple heuristic (SPEC §4): mention an artifact-like token AND a control verb.
const ARTIFACT_HINTS = [
  "url", "http", "https://", "commit", "hash", "sha", "sha256", "sha-256",
  "file", "log", "json", "response", "endpoint", "artifact", "id ", "record",
];
const CONTROL_VERBS = [
  "verify", "verifies", "matches", "equals", "returns", "contains",
  "shows", "passes", "compares", "reports", "measures", "check", "checks",
  "less than", "greater than", "within", "under", "over", "at most", "at least",
];

function looksVerifiable(condition: string): boolean {
  const lc = condition.toLowerCase();
  const hasArtifact = ARTIFACT_HINTS.some((h) => lc.includes(h));
  const hasVerb = CONTROL_VERBS.some((v) => lc.includes(v));
  return hasArtifact && hasVerb;
}

export async function handleCreateTask(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  const body = await readJson<CreateTaskBody>(request);
  if (!body) return error(400, "expected application/json body");
  const guildSlug = typeof body.guild === "string" ? body.guild.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  const condition = typeof body.condition === "string" ? body.condition.trim() : "";
  const reward = body.reward_credits;
  const expiry = body.expiry === undefined || body.expiry === null ? null : safeInt(body.expiry, NaN);

  if (!isNonEmptyString(guildSlug, 1, 40)) return error(400, "guild is required");
  if (!isNonEmptyString(title, 3, 120)) return error(400, "title must be 3-120 chars");
  if (!isNonEmptyString(brief, 10, 8000)) return error(400, "brief must be 10-8000 chars");
  if (!isNonEmptyString(condition, 10, 2000)) return error(400, "condition must be 10-2000 chars");
  if (!isIntInRange(reward, 1, 10000)) return error(400, "reward_credits must be an integer 1..10000");
  if (expiry !== null && (!Number.isFinite(expiry) || expiry < Math.floor(nowMs() / 1000))) {
    return error(400, "expiry must be a future epoch-seconds timestamp");
  }
  if (!looksVerifiable(condition)) {
    return error(
      400,
      "condition must describe a check a stranger can run (mention an artifact — url/hash/file/etc. — and a control verb like 'verify', 'matches', 'returns')",
    );
  }

  const guild = await findGuildBySlug(env, guildSlug);
  if (!guild) return error(404, "unknown guild");

  if (ctx.member.credits < (reward as number)) {
    return error(402, "insufficient credits to escrow reward");
  }
  if (!(await hasQuota(env, ctx.member, "tasks"))) {
    return error(429, "daily task quota exhausted (resets 00:00 UTC)");
  }

  const dedupeKey = normalizeForDedupe(title, brief).slice(0, 512);
  const dupe = await env.DB
    .prepare("SELECT id FROM tasks WHERE author_id = ? AND dedupe_key = ?")
    .bind(ctx.member.id, dedupeKey)
    .first<{ id: number }>();
  if (dupe) return error(409, "near-duplicate of an existing task from this author");

  const createdAt = nowMs();
  // Deduct escrow atomically with insert.
  const escrow = env.DB
    .prepare("UPDATE members SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .bind(reward, ctx.member.id, reward);
  const insert = env.DB
    .prepare(
      `INSERT INTO tasks
         (guild_id, author_id, title, brief, condition, reward_credits, status, expiry, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .bind(
      guild.id,
      ctx.member.id,
      title,
      brief,
      condition,
      reward,
      expiry,
      createdAt,
      dedupeKey,
    );

  const batchResults = await env.DB.batch([escrow, insert]);
  const escrowRes = batchResults[0];
  const insertRes = batchResults[1];
  if (!escrowRes || !insertRes || !escrowRes.meta.changes) {
    return error(402, "insufficient credits to escrow reward");
  }
  const id = Number(insertRes.meta.last_row_id);

  await consumeQuota(env, ctx.member, "tasks");
  await appendEvent(env, "task_created", {
    task_id: id,
    guild: guild.slug,
    author_id: ctx.member.id,
    author: ctx.member.handle,
    title,
    reward_credits: reward,
    expiry,
  });

  const row = await taskById(env, id);
  return json({ task: row }, { status: 201 });
}

export async function handleListTasks(env: Env, url: URL): Promise<Response> {
  const guildSlug = url.searchParams.get("guild");
  const status = url.searchParams.get("status") as TaskStatus | null;
  const before = safeInt(url.searchParams.get("before") ?? "0", 0);
  const limit = Math.min(Math.max(safeInt(url.searchParams.get("limit") ?? "20", 20), 1), 50);

  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (guildSlug) {
    const g = await findGuildBySlug(env, guildSlug);
    if (!g) return error(404, "unknown guild");
    clauses.push("t.guild_id = ?");
    args.push(g.id);
  }
  if (status) {
    if (!["open", "closed", "expired"].includes(status)) return error(400, "invalid status");
    clauses.push("t.status = ?");
    args.push(status);
  }
  if (before > 0) {
    clauses.push("t.id < ?");
    args.push(before);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const rs = await env.DB
    .prepare(
      `SELECT t.id, t.guild_id, g.slug AS guild, t.author_id, m.handle AS author,
              t.title, t.brief, t.condition, t.reward_credits, t.status, t.expiry, t.created_at
         FROM tasks t
         JOIN guilds g  ON g.id  = t.guild_id
         JOIN members m ON m.id  = t.author_id
         ${where}
         ORDER BY t.id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all();
  return json({ tasks: rs.results ?? [], limit });
}

export async function handleGetTask(env: Env, id: number): Promise<Response> {
  const task = await taskById(env, id);
  if (!task) return error(404, "task not found");
  const subs = await env.DB
    .prepare(
      `SELECT s.id, s.member_id, m.handle AS submitter, s.artifact, s.note,
              s.status, s.verdict_reason, s.created_at
         FROM submissions s JOIN members m ON m.id = s.member_id
         WHERE s.task_id = ? ORDER BY s.id DESC`,
    )
    .bind(id)
    .all();
  const comments = await commentsForTask(env, id, 50);
  return json({ task, submissions: subs.results ?? [], comments });
}

export async function handleCloseTask(env: Env, ctx: AuthContext, id: number): Promise<Response> {
  const task = await taskById(env, id);
  if (!task) return error(404, "task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the author can close this task");
  if (task.status !== "open") return error(409, `task is already ${task.status}`);

  // CLAIM THE CLOSE FIRST, ATOMICALLY.
  //
  // The status read above does not hold anything: two concurrent closes
  // both used to pass it and both refunded the escrow, minting credits.
  // The open -> closed transition is now a single conditional UPDATE.
  // Exactly one caller sees `changes === 1` and may refund. This also
  // mutually excludes with the verdict path, which closes the task on
  // acceptance: whichever lands first makes the other a no-op 409.
  const claim = await env.DB
    .prepare("UPDATE tasks SET status = 'closed' WHERE id = ? AND status = 'open'")
    .bind(id)
    .run();
  if (!claim.meta.changes) {
    return error(409, "task is no longer open");
  }

  // Read the acceptance state only after we own the close, so we cannot
  // refund an escrow that a verdict already paid out.
  const accepted = await env.DB
    .prepare("SELECT 1 AS x FROM submissions WHERE task_id = ? AND status = 'accepted' LIMIT 1")
    .bind(id)
    .first<{ x: number }>();

  const refunded = !accepted ? task.reward_credits : 0;
  if (refunded > 0) {
    await env.DB
      .prepare("UPDATE members SET credits = credits + ? WHERE id = ?")
      .bind(refunded, ctx.member.id)
      .run();
  }

  await appendEvent(env, "task_closed", {
    task_id: id,
    author_id: ctx.member.id,
    refunded_credits: refunded,
  });
  const updated = await taskById(env, id);
  return json({ task: updated, refunded_credits: refunded });
}

export interface TaskDetail {
  id: number;
  guild_id: number;
  guild: string;
  author_id: number;
  author: string;
  title: string;
  brief: string;
  condition: string;
  reward_credits: number;
  status: TaskStatus;
  expiry: number | null;
  created_at: number;
}

export async function taskById(env: Env, id: number): Promise<TaskDetail | null> {
  return (
    (await env.DB
      .prepare(
        `SELECT t.id, t.guild_id, g.slug AS guild, t.author_id, m.handle AS author,
                t.title, t.brief, t.condition, t.reward_credits, t.status, t.expiry, t.created_at
           FROM tasks t
           JOIN guilds g  ON g.id  = t.guild_id
           JOIN members m ON m.id  = t.author_id
           WHERE t.id = ?`,
      )
      .bind(id)
      .first<TaskDetail>()) ?? null
  );
}

export { looksVerifiable as _looksVerifiableForTests };
