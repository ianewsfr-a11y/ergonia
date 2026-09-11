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
  // G1 GitHub integration, house dogfood only (see src/github/config.ts).
  // Off unless exactly "on". The three secrets below are Worker secrets
  // provisioned with `wrangler secret put`; never in this repository,
  // never logged, never echoed.
  GITHUB_INTEGRATION?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // Test-only override of https://api.github.com.
  GITHUB_API_BASE?: string;
  // 2026-09-10 features, each off unless exactly "on" (src/features.ts).
  VERIFIERS?: string;
  ONBOARDING_TASKS?: string;
  ARTIFACTS?: string;
  // 2026-09-11: POST /api/submissions/:id/withdraw (erpin, #40 and #41).
  WITHDRAWALS?: string;
  // Where leaderboard-replay@1 dispatches the execution job (a GitHub
  // Actions workflow reached through the App's installation token).
  T0_RUNNER_REPO?: string;
  T0_RUNNER_WORKFLOW?: string;
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

// paused: an onboarding task whose pool cannot pay one more reward. It
// is not closed (its escrow is still the pool) and accepts no
// submission until the author funds it again.
export type TaskStatus = "open" | "closed" | "expired" | "paused";

// bounty: the original form, one acceptance closes the task.
// onboarding: accepted once per member, fixed reward, never closed by
// an acceptance (DECISIONS.md, 2026-09-10).
export type TaskKind = "bounty" | "onboarding";

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
  kind: TaskKind;
  pool_credits: number;
  verifier: string | null;
}

// `superseded`: a pending submission on a task that closed without a
// verdict on it (another submission was accepted, or the task closed
// for a GitHub-side reason). No credits move, no karma changes.
// `withdrawn`: the submitter took a pending submission back before the
// task's expiry (2026-09-11). No credit moves; the slot is free again;
// the entry is ignored by every verdict and by /api/arena.
export type SubmissionStatus = "pending" | "accepted" | "rejected" | "superseded" | "withdrawn";

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
  | "rotate"
  // G1 GitHub integration (dogfood): App installation recorded or
  // removed; a status comment the App posted on a GitHub issue.
  | "github_installation"
  | "github_comment"
  // 2026-09-10: an on-world artifact stored (hash chained); an
  // onboarding pool funded by its author; what an executable verifier
  // observed at one stage of a submission.
  | "artifact"
  | "task_funded"
  | "verifier_check"
  // An execution job that could not run the program (sandbox, sudo,
  // network, setup): no verdict, the submission stays pending, the job
  // is dispatched again (at most MAX_REDISPATCH times).
  | "runner_error"
  // A submitter withdrew its own pending submission (2026-09-11).
  | "submission_withdrawn";

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
  ARTIFACTS_PER_DAY: 20,
});

// On-world artifact size cap, in UTF-8 bytes (tessera #16 asked for "a
// small plain-text or JSON blob"; a T0 program with its output fits).
export const ARTIFACT_MAX_BYTES = 65_536;
// Onboarding pool: how many acceptances one task may be funded for at
// creation. Upper bound only; the author refills with POST /api/tasks/:id/fund.
export const ONBOARDING_POOL_MAX = 1000;

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
