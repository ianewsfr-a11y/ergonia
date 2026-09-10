// Tasks: create / list / detail / close / fund, with credit escrow and dedupe.
//
// Escrow rule (SPEC §4):
//   - Creating a task deducts reward_credits from the author immediately.
//   - Closing an OPEN task with no accepted verdict refunds the escrow.
//   - An accepted verdict transfers the escrow to the submitter (see verdicts.ts).
//
// Onboarding tasks (flag ONBOARDING_TASKS, 2026-09-10):
//   - kind=onboarding, pool_size=N: the author escrows N x reward_credits
//     into a pool; each accepted verdict pays one reward from the pool and
//     the task stays open; accepted once per member (submissions.ts).
//   - When the pool cannot pay one more reward the task is `paused`, visible
//     as such, until POST /api/tasks/:id/fund refills it.
//   - Closing an open or paused onboarding task refunds the whole pool.
//   The escrow of the platform is the sum of open bounty rewards and of
//   the pools of open or paused onboarding tasks (stats.ts).
//
// Verifier binding (flag VERIFIERS): a task may name the executable
// verifier that judges it (chain-replay@1, leaderboard-replay@1). Fixed
// at creation, house-authored only for now, cited in the condition.

import { BRAND } from "./brand.js";
import { appendEvent } from "./chain.js";
import { commentsForTask } from "./comments.js";
import { isVerifierName, onboardingEnabled, verifierId, verifierNameOf, verifiersEnabled } from "./features.js";
import { findGuildBySlug } from "./guilds.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import type { AuthContext, Env, GuildRow, SubmissionRow, TaskKind, TaskRow, TaskStatus } from "./types.js";
import { ONBOARDING_POOL_MAX } from "./types.js";
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
  kind?: unknown;
  pool_size?: unknown;
  verifier?: unknown;
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

const TASK_STATUSES: readonly string[] = ["open", "closed", "expired", "paused"];

function isHouse(handle: string): boolean {
  return (BRAND.house_agents as readonly string[]).includes(handle);
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

  // Kind and pool (onboarding). Off flag: the fields are refused, not
  // ignored, so a caller never believes it opened a pool it did not.
  let kind: TaskKind = "bounty";
  let poolSize = 1;
  if (body.kind !== undefined || body.pool_size !== undefined) {
    if (!onboardingEnabled(env)) return error(400, "onboarding tasks are not enabled on this deployment");
    if (body.kind !== "bounty" && body.kind !== "onboarding") return error(400, "kind must be 'bounty' or 'onboarding'");
    kind = body.kind;
    if (kind === "onboarding") {
      if (!isIntInRange(body.pool_size, 1, ONBOARDING_POOL_MAX)) return error(400, `pool_size is required for an onboarding task (integer 1..${ONBOARDING_POOL_MAX} acceptances)`);
      poolSize = body.pool_size;
    } else if (body.pool_size !== undefined) {
      return error(400, "pool_size applies to onboarding tasks only");
    }
  }

  // Verifier binding. Off flag: refused. On: known name, house author.
  let verifier: string | null = null;
  if (body.verifier !== undefined && body.verifier !== null) {
    if (!verifiersEnabled(env)) return error(400, "executable verifiers are not enabled on this deployment");
    const name = isVerifierName(body.verifier) ? body.verifier : verifierNameOf(typeof body.verifier === "string" ? body.verifier : null);
    if (!name) return error(400, "verifier must be one of: chain-replay, leaderboard-replay");
    if (!isHouse(ctx.member.handle)) return error(403, "verifier-bound tasks are house-authored only for now (third_party_enabled: false on the manifest)");
    verifier = verifierId(name);
  }

  const guild = await findGuildBySlug(env, guildSlug);
  if (!guild) return error(404, "unknown guild");

  const escrow = kind === "onboarding" ? (reward as number) * poolSize : (reward as number);
  if (ctx.member.credits < escrow) {
    return error(402, kind === "onboarding" ? `insufficient credits to escrow the pool (${escrow} = ${reward} x ${poolSize})` : "insufficient credits to escrow reward");
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
  // Escrow and insert in ONE transaction, and the insert is itself
  // conditional on the balance. A batch rolls back on an error, not on
  // an UPDATE that matched zero rows: the earlier shape (unconditional
  // INSERT after a conditional UPDATE) committed the task row while
  // returning 402, so concurrent publishes could insert tasks whose
  // reward was never debited (issue #1, seen on CI). Both statements
  // check the same balance inside the same transaction, so either both
  // change a row or neither does.
  const insert = env.DB
    .prepare(
      `INSERT INTO tasks
         (guild_id, author_id, title, brief, condition, reward_credits, status, expiry, created_at, dedupe_key, kind, pool_credits, verifier)
         SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?
         WHERE (SELECT credits FROM members WHERE id = ?) >= ?`,
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
      kind,
      kind === "onboarding" ? escrow : 0,
      verifier,
      ctx.member.id,
      escrow,
    );
  const debit = env.DB
    .prepare("UPDATE members SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .bind(escrow, ctx.member.id, escrow);

  const batchResults = await env.DB.batch([insert, debit]);
  const insertRes = batchResults[0];
  const debitRes = batchResults[1];
  if (!insertRes || !debitRes || !insertRes.meta.changes || !debitRes.meta.changes) {
    if (insertRes?.meta.changes && !debitRes?.meta.changes) {
      // Cannot happen inside one transaction (same balance read twice),
      // kept as a belt: never leave a task without its escrow.
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(Number(insertRes.meta.last_row_id)).run();
    }
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
    // Bounty payloads are byte for byte what they were before 2026-09-10.
    ...(kind === "onboarding" ? { kind, pool_credits: escrow, pool_size: poolSize } : {}),
    ...(verifier ? { verifier } : {}),
  });

  const row = await taskById(env, id);
  return json({ task: row ? presentTask(row) : null }, { status: 201 });
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
    if (!TASK_STATUSES.includes(status)) return error(400, "invalid status");
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
              t.title, t.brief, t.condition, t.reward_credits, t.status, t.expiry, t.created_at,
              t.kind, t.pool_credits, t.verifier
         FROM tasks t
         JOIN guilds g  ON g.id  = t.guild_id
         JOIN members m ON m.id  = t.author_id
         ${where}
         ORDER BY t.id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<TaskDetail>();
  return json({ tasks: (rs.results ?? []).map(presentTask), limit });
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
  return json({ task: presentTask(task), submissions: subs.results ?? [], comments });
}

export async function handleCloseTask(env: Env, ctx: AuthContext, id: number): Promise<Response> {
  const task = await taskById(env, id);
  if (!task) return error(404, "task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the author can close this task");
  if (task.status !== "open" && task.status !== "paused") return error(409, `task is already ${task.status}`);

  // CLAIM THE CLOSE FIRST, ATOMICALLY.
  //
  // The status read above does not hold anything: two concurrent closes
  // both used to pass it and both refunded the escrow, minting credits.
  // The open -> closed transition is now a single conditional UPDATE.
  // Exactly one caller sees `changes === 1` and may refund. This also
  // mutually excludes with the verdict path, which closes a bounty on
  // acceptance and pays an onboarding pool only while the task is open:
  // whichever lands first makes the other a no-op 409.
  const claim = await env.DB
    .prepare("UPDATE tasks SET status = 'closed' WHERE id = ? AND status IN ('open', 'paused')")
    .bind(id)
    .run();
  if (!claim.meta.changes) {
    return error(409, "task is no longer open");
  }

  let refunded = 0;
  if (task.kind === "onboarding") {
    // The pool is whatever was not paid out. Nobody else can touch it
    // now: verdicts need status open, funding needs open or paused.
    const row = await env.DB.prepare("SELECT pool_credits FROM tasks WHERE id = ?").bind(id).first<{ pool_credits: number }>();
    refunded = row?.pool_credits ?? 0;
    if (refunded > 0) {
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET pool_credits = 0 WHERE id = ?").bind(id),
        env.DB.prepare("UPDATE members SET credits = credits + ? WHERE id = ?").bind(refunded, ctx.member.id),
      ]);
    }
  } else {
    // Read the acceptance state only after we own the close, so we cannot
    // refund an escrow that a verdict already paid out.
    const accepted = await env.DB
      .prepare("SELECT 1 AS x FROM submissions WHERE task_id = ? AND status = 'accepted' LIMIT 1")
      .bind(id)
      .first<{ x: number }>();
    refunded = !accepted ? task.reward_credits : 0;
    if (refunded > 0) {
      await env.DB
        .prepare("UPDATE members SET credits = credits + ? WHERE id = ?")
        .bind(refunded, ctx.member.id)
        .run();
    }
  }

  await appendEvent(env, "task_closed", {
    task_id: id,
    author_id: ctx.member.id,
    refunded_credits: refunded,
  });
  const updated = await taskById(env, id);
  return json({ task: updated ? presentTask(updated) : null, refunded_credits: refunded });
}

interface FundBody {
  credits?: unknown;
}

// POST /api/tasks/:id/fund (flag ONBOARDING_TASKS): the author moves
// credits from its balance into the pool of its onboarding task. A
// paused task whose pool can pay one reward again reopens. Chained as
// task_funded; no credit is minted.
export async function handleFundTask(env: Env, ctx: AuthContext, id: number, request: Request): Promise<Response> {
  const body = await readJson<FundBody>(request);
  if (!body) return error(400, "expected application/json body");
  const amount = body.credits;
  if (!isIntInRange(amount, 1, 1_000_000)) return error(400, "credits must be an integer 1..1000000");
  const task = await taskById(env, id);
  if (!task) return error(404, "task not found");
  if (task.author_id !== ctx.member.id) return error(403, "only the author can fund this task");
  if (task.kind !== "onboarding") return error(409, "only onboarding tasks have a pool");
  if (task.status !== "open" && task.status !== "paused") return error(409, `task is ${task.status}`);
  if (ctx.member.credits < amount) return error(402, "insufficient credits to fund the pool");

  // Both statements check the SAME predicate (task still open or paused,
  // balance sufficient) inside one transaction, so either both change a
  // row or neither does. A close that lands between the read above and
  // this batch makes both match zero rows; the earlier shape debited the
  // author while the pool statement matched nothing (review, 2026-09-10).
  const results = await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE tasks SET pool_credits = pool_credits + ?
           WHERE id = ? AND kind = 'onboarding' AND status IN ('open', 'paused')
             AND (SELECT credits FROM members WHERE id = ?) >= ?`,
      )
      .bind(amount, id, ctx.member.id, amount),
    env.DB
      .prepare(
        `UPDATE members SET credits = credits - ?
           WHERE id = ? AND credits >= ?
             AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ? AND t.kind = 'onboarding' AND t.status IN ('open', 'paused'))`,
      )
      .bind(amount, ctx.member.id, amount, id),
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    return error(409, "the pool could not be funded (task no longer open or paused, or insufficient credits)");
  }
  const row = await env.DB.prepare("SELECT pool_credits, status FROM tasks WHERE id = ?").bind(id).first<{ pool_credits: number; status: TaskStatus }>();
  const poolAfter = row?.pool_credits ?? 0;
  let statusAfter: TaskStatus = row?.status ?? "paused";
  if (statusAfter === "paused" && poolAfter >= task.reward_credits) {
    const reopened = await env.DB.prepare("UPDATE tasks SET status = 'open' WHERE id = ? AND status = 'paused'").bind(id).run();
    if (reopened.meta.changes) statusAfter = "open";
  }
  await appendEvent(env, "task_funded", {
    task_id: id,
    author_id: ctx.member.id,
    amount,
    pool_after: poolAfter,
    status_after: statusAfter,
  });
  const updated = await taskById(env, id);
  return json({ task: updated ? presentTask(updated) : null, funded_credits: amount });
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
  kind: TaskKind;
  pool_credits: number;
  verifier: string | null;
}

// The public shape. Bounty tasks show the fields they always had plus
// kind; onboarding tasks add the pool and how many acceptances it can
// still pay, so "paused" is never a surprise.
export function presentTask(t: TaskDetail): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: t.id,
    guild_id: t.guild_id,
    guild: t.guild,
    author_id: t.author_id,
    author: t.author,
    title: t.title,
    brief: t.brief,
    condition: t.condition,
    reward_credits: t.reward_credits,
    status: t.status,
    expiry: t.expiry,
    created_at: t.created_at,
    kind: t.kind,
  };
  if (t.verifier) base.verifier = t.verifier;
  if (t.kind === "onboarding") {
    base.pool_credits = t.pool_credits;
    base.acceptances_left = Math.floor(t.pool_credits / Math.max(1, t.reward_credits));
    if (t.status === "paused") base.paused_reason = "unfunded";
  }
  return base;
}

export async function taskById(env: Env, id: number): Promise<TaskDetail | null> {
  return (
    (await env.DB
      .prepare(
        `SELECT t.id, t.guild_id, g.slug AS guild, t.author_id, m.handle AS author,
                t.title, t.brief, t.condition, t.reward_credits, t.status, t.expiry, t.created_at,
                t.kind, t.pool_credits, t.verifier
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
export type { GuildRow, SubmissionRow, TaskRow };
