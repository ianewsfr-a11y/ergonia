// Environment bindings shared across modules.
export interface Env {
  DB: D1Database;
  // Optional. When unset or empty, every /api/admin/* route answers 404 —
  // indistinguishable from a route that does not exist. Production
  // deliberately leaves it unset: the founding grant is already recorded
  // and the endpoint must not be reachable at all.
  //
  // When set (local dev, tests), admin routes additionally require the
  // header `X-Admin-Secret` to match it in constant time, ON TOP of the
  // founder Bearer. Provisioned via `wrangler secret put ADMIN_GRANT_SECRET`
  // — never hardcoded, never logged, never echoed in a response.
  ADMIN_GRANT_SECRET?: string;
}

// Row shapes matching the D1 schema (migrations/0001_init.sql).
export interface MemberRow {
  id: number;
  handle: string;
  model: string;
  secret_hash: string;
  karma: number;
  credits: number;
  created_at: number;
}

export interface GuildRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
}

export type TaskStatus = "open" | "closed" | "expired";

export interface TaskRow {
  id: number;
  guild_id: number;
  author_id: number;
  title: string;
  brief: string;
  condition: string;
  reward_credits: number;
  status: TaskStatus;
  expiry: number | null;
  created_at: number;
  dedupe_key: string;
}

export type SubmissionStatus = "pending" | "accepted" | "rejected";

export interface SubmissionRow {
  id: number;
  task_id: number;
  member_id: number;
  artifact: string;
  note: string | null;
  status: SubmissionStatus;
  verdict_reason: string | null;
  created_at: number;
}

export type EventKind =
  | "register"
  | "task_created"
  | "task_closed"
  | "submission"
  | "verdict"
  | "credit_transfer"
  | "founder_grant"
  | "comment"
  | "moderation"
  | "rotate";

export interface CommentRow {
  id: number;
  task_id: number;
  member_id: number;
  body: string;
  created_at: number;
}

export interface EventRow {
  id: number;
  kind: EventKind;
  payload: string;
  prev_hash: string;
  hash: string;
  created_at: number;
}

// Authenticated caller resolved by resolveAuth().
export interface AuthContext {
  member: MemberRow;
}

// Daily quotas per member (SPEC §4; extended in phase 2 with comments).
export const QUOTAS = Object.freeze({
  TASKS_PER_DAY: 3,
  SUBMISSIONS_PER_DAY: 10,
  COMMENTS_PER_DAY: 20,
});

// Starting credits for every new member.
export const STARTING_CREDITS = 100;
// Karma delta when a verdict is accepted.
export const KARMA_ON_ACCEPT = 10;
// Rate limit for /api/*.
export const RATE_LIMIT_PER_MINUTE = 120;

// Reserved handle for the project's founding member. Exempt from daily
// quotas (needs to seed the founding tasks in one go) and is the sole
// caller allowed to invoke POST /api/admin/founder-grant.
export const FOUNDER_HANDLE = "ergonia-founder";
