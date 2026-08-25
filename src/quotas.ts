// Daily quotas (per member) and best-effort rate limit (per IP).
//
// Quotas: SPEC §4 — 3 tasks/day, 10 submissions/day, unlimited reads.
// Phase 2 adds 20 comments/day.
// A validation-rejected write must NOT consume quota, so callers only
// invoke consumeQuota() after every check has passed.
//
// Rate limit: 120 req/min/IP on /api/*. Uses a minute bucket key
// stored in the rate_limits table.

import type { Env, MemberRow } from "./types.js";
import { FOUNDER_HANDLE, QUOTAS, RATE_LIMIT_PER_MINUTE } from "./types.js";
import { nowMs, utcDay } from "./util.js";

export type QuotaKind = "tasks" | "subs" | "comments";

export interface QuotaSnapshot {
  utc_day: string;
  tasks_used: number;
  tasks_left: number;
  subs_used: number;
  subs_left: number;
  comments_used: number;
  comments_left: number;
}

interface QuotaCounters {
  tasks: number;
  subs: number;
  comments: number;
}

async function ensureQuotaRow(env: Env, memberId: number, day: string): Promise<void> {
  await env.DB
    .prepare(
      "INSERT OR IGNORE INTO quotas (member_id, utc_day, tasks, subs, comments) VALUES (?, ?, 0, 0, 0)",
    )
    .bind(memberId, day)
    .run();
}

async function readQuotaRow(env: Env, memberId: number, day: string): Promise<QuotaCounters> {
  const row = await env.DB
    .prepare("SELECT tasks, subs, comments FROM quotas WHERE member_id = ? AND utc_day = ?")
    .bind(memberId, day)
    .first<QuotaCounters>();
  return row ?? { tasks: 0, subs: 0, comments: 0 };
}

export async function snapshotQuotas(env: Env, member: MemberRow): Promise<QuotaSnapshot> {
  const day = utcDay();
  const row = await readQuotaRow(env, member.id, day);
  const founder = member.handle === FOUNDER_HANDLE;
  // The founder gets no daily cap so it can seed the founding tasks +
  // their pinning comments in one run. Snapshot advertises Infinity.
  return {
    utc_day: day,
    tasks_used: row.tasks,
    tasks_left: founder ? Number.POSITIVE_INFINITY : Math.max(0, QUOTAS.TASKS_PER_DAY - row.tasks),
    subs_used: row.subs,
    subs_left: founder ? Number.POSITIVE_INFINITY : Math.max(0, QUOTAS.SUBMISSIONS_PER_DAY - row.subs),
    comments_used: row.comments,
    comments_left: founder ? Number.POSITIVE_INFINITY : Math.max(0, QUOTAS.COMMENTS_PER_DAY - row.comments),
  };
}

const COLS: Record<QuotaKind, keyof QuotaCounters> = {
  tasks: "tasks",
  subs: "subs",
  comments: "comments",
};
const CAPS: Record<QuotaKind, number> = {
  tasks: QUOTAS.TASKS_PER_DAY,
  subs: QUOTAS.SUBMISSIONS_PER_DAY,
  comments: QUOTAS.COMMENTS_PER_DAY,
};

// Returns true if the caller has budget left (does NOT consume).
export async function hasQuota(env: Env, member: MemberRow, kind: QuotaKind): Promise<boolean> {
  if (member.handle === FOUNDER_HANDLE) return true;
  const day = utcDay();
  const row = await readQuotaRow(env, member.id, day);
  return row[COLS[kind]] < CAPS[kind];
}

// Charge one unit of quota. Callers must have already validated inputs.
export async function consumeQuota(env: Env, member: MemberRow, kind: QuotaKind): Promise<void> {
  if (member.handle === FOUNDER_HANDLE) return;
  const day = utcDay();
  await ensureQuotaRow(env, member.id, day);
  const col = COLS[kind];
  await env.DB
    .prepare(`UPDATE quotas SET ${col} = ${col} + 1 WHERE member_id = ? AND utc_day = ?`)
    .bind(member.id, day)
    .run();
}

// Best-effort rate limit per (IP, minute). Returns false when over the cap.
export async function checkRateLimit(env: Env, request: Request): Promise<boolean> {
  const ip = clientIp(request);
  const bucketMin = new Date(nowMs()).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const bucket = `${ip}|${bucketMin}`;
  const expires = nowMs() + 65_000;
  await env.DB
    .prepare(
      "INSERT INTO rate_limits (bucket, hits, expires) VALUES (?, 1, ?) " +
        "ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1, expires = excluded.expires",
    )
    .bind(bucket, expires)
    .run();
  const row = await env.DB
    .prepare("SELECT hits FROM rate_limits WHERE bucket = ?")
    .bind(bucket)
    .first<{ hits: number }>();
  const hits = row?.hits ?? 1;
  // Opportunistic cleanup — cheap.
  if (hits % 30 === 0) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires < ?").bind(nowMs()).run();
  }
  return hits <= RATE_LIMIT_PER_MINUTE;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}
