// A labelled GitHub issue becomes an Ergonia task; the task closes when
// the label goes, the issue closes, or a verdict lands.
//
// Every state change here is chained (task_created / task_closed /
// github_comment) and every outward comment is claimed in
// github_comments BEFORE it is posted, so a retried delivery cannot
// post the same transition twice.

import { BRAND } from "../brand.js";
import { appendEvent } from "../chain.js";
import { findGuildBySlug } from "../guilds.js";
import { consumeQuota, hasQuota } from "../quotas.js";
import type { Env, MemberRow } from "../types.js";
import { nowMs, nowUtcISO } from "../util.js";
import { postIssueComment, listCheckRuns } from "./api.js";
import { installationToken } from "./app-auth.js";
import {
  expiredComment,
  labelRemovedComment,
  openedComment,
  type CommentKind,
} from "./comments.js";
import {
  DEFAULT_EXPIRY_DAYS,
  DEFAULT_REWARD_CREDITS,
  VERIFIER_ACTOR,
  type AllowedRepo,
} from "./config.js";
import { ensurePrincipal } from "./principal.js";

export interface GithubIssueRow {
  id: number;
  installation_id: number;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  issue_url: string;
  base_branch: string;
  required_checks: string; // JSON array
  task_id: number;
  delivery_id: string;
  opened_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

const ISSUE_COLS =
  "id, installation_id, repo_id, repo_full_name, issue_number, issue_url, base_branch, required_checks, task_id, delivery_id, opened_at, closed_at, close_reason";

export async function githubIssueForTask(env: Env, taskId: number): Promise<GithubIssueRow | null> {
  return (
    (await env.DB
      .prepare(`SELECT ${ISSUE_COLS} FROM github_issues WHERE task_id = ?`)
      .bind(taskId)
      .first<GithubIssueRow>()) ?? null
  );
}

export async function openIssueRow(env: Env, repoId: number, issueNumber: number): Promise<GithubIssueRow | null> {
  return (
    (await env.DB
      .prepare(`SELECT ${ISSUE_COLS} FROM github_issues WHERE repo_id = ? AND issue_number = ? AND closed_at IS NULL`)
      .bind(repoId, issueNumber)
      .first<GithubIssueRow>()) ?? null
  );
}

export async function openIssueRowsForRepo(env: Env, repoId: number): Promise<GithubIssueRow[]> {
  const rs = await env.DB
    .prepare(`SELECT ${ISSUE_COLS} FROM github_issues WHERE repo_id = ? AND closed_at IS NULL ORDER BY id ASC`)
    .bind(repoId)
    .all<GithubIssueRow>();
  return rs.results ?? [];
}

export async function openIssueRowsForInstallation(env: Env, installationId: number): Promise<GithubIssueRow[]> {
  const rs = await env.DB
    .prepare(`SELECT ${ISSUE_COLS} FROM github_issues WHERE installation_id = ? AND closed_at IS NULL ORDER BY id ASC`)
    .bind(installationId)
    .all<GithubIssueRow>();
  return rs.results ?? [];
}

export function taskUrl(taskId: number): string {
  return `${BRAND.origin}/api/tasks/${taskId}`;
}

export function requiredChecksOf(row: GithubIssueRow): string[] {
  try {
    const v = JSON.parse(row.required_checks) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// Comments: claim, post, record. The UNIQUE (github_issue_id, kind, ref)
// is the idempotency key. A failed post releases the claim so a retry
// can post; a successful post is chained as github_comment.
// ---------------------------------------------------------------------
export async function postTransitionComment(
  env: Env,
  row: GithubIssueRow,
  kind: CommentKind,
  ref: number,
  body: string,
): Promise<{ posted: boolean; comment_id?: number; html_url?: string }> {
  const claim = await env.DB
    .prepare(
      "INSERT OR IGNORE INTO github_comments (github_issue_id, kind, ref, github_comment_id, posted_at) VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(row.id, kind, ref, nowMs())
    .run();
  if (!claim.meta.changes) return { posted: false }; // already posted (or being posted)
  try {
    const token = await installationToken(env, row.installation_id);
    const posted = await postIssueComment(env, token, row.repo_full_name, row.issue_number, body);
    await env.DB
      .prepare("UPDATE github_comments SET github_comment_id = ?, posted_at = ? WHERE github_issue_id = ? AND kind = ? AND ref = ?")
      .bind(posted.id, nowMs(), row.id, kind, ref)
      .run();
    await appendEvent(env, "github_comment", {
      task_id: row.task_id,
      repo: row.repo_full_name,
      repo_id: row.repo_id,
      issue_number: row.issue_number,
      kind,
      ref,
      github_comment_id: posted.id,
      url: posted.html_url,
    });
    return { posted: true, comment_id: posted.id, html_url: posted.html_url };
  } catch (e: unknown) {
    // Release the claim so a retry can post. Log the class of failure only.
    await env.DB
      .prepare("DELETE FROM github_comments WHERE github_issue_id = ? AND kind = ? AND ref = ? AND github_comment_id IS NULL")
      .bind(row.id, kind, ref)
      .run();
    console.error("github comment failed", kind, e instanceof Error ? e.message : String(e));
    return { posted: false };
  }
}

// ---------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------
export interface IssueInput {
  number: number;
  title: string;
  body: string;
  html_url: string;
}

export type OpenOutcome =
  | { outcome: "opened"; task_id: number }
  | { outcome: "already_open"; task_id: number }
  | { outcome: "escrow_failed" }
  | { outcome: "quota_exhausted" };

function truncateTitle(t: string): string {
  const clean = t.replace(/\s+/g, " ").trim();
  if (clean.length <= 120) return clean.length >= 3 ? clean : `Issue: ${clean}`.slice(0, 120);
  return clean.slice(0, 117) + "...";
}

function buildBrief(repo: string, issue: IssueInput, base: string): string {
  const preamble =
    `This task mirrors GitHub issue ${repo}#${issue.number} (${issue.html_url}) on behalf of the maintainer's \`ergonia-bounty\` label. ` +
    `To submit, open a pull request against ${repo} (base branch ${base}) that references this issue, and pass its CI. Anyone can submit.\n\n` +
    `Verdicts on this task are issued automatically by ${VERIFIER_ACTOR} on behalf of the task author ergonia-bounties, a declared house principal (see ${BRAND.origin}/api/verifiers/github-checks). ` +
    `A green check set is evidence that the named checks passed on the head commit; it is not a claim that the issue is fixed.\n\n` +
    `--- Issue body, verbatim ---\n`;
  const budget = 8000 - preamble.length - 60;
  const body = issue.body.trim().length > 0 ? issue.body.trim() : "(the issue has no body)";
  const truncated = body.length > budget ? body.slice(0, budget) + "\n[truncated by Ergonia at the 8000-char brief limit]" : body;
  return preamble + truncated;
}

function buildCondition(repo: string, issue: IssueInput, base: string, required: string[]): string {
  const req =
    required.length > 0
      ? `, and the check runs named ${required.map((n) => `"${n}"`).join(", ")} (recorded from ${base} when this task opened) are all present among them`
      : "";
  return (
    `A pull request against ${repo}, whose body references issue #${issue.number} (${issue.html_url}) with a keyword GitHub recognises (Closes, Fixes, Resolves, followed by #${issue.number} or the full issue URL), ` +
    `is either open or merged with base branch ${base}, and every check run on its current head commit, as listed by GET https://api.github.com/repos/${repo}/commits/<sha>/check-runs, ` +
    `has status completed and a conclusion of success, neutral or skipped${req}. ` +
    `Any other conclusion (failure, cancelled, timed_out, action_required, stale) fails the condition. A head commit with zero check runs does not pass.`
  ).slice(0, 2000);
}

async function checkNamesOnBranch(env: Env, installationId: number, repo: string, branch: string): Promise<string[]> {
  try {
    const token = await installationToken(env, installationId);
    const runs = await listCheckRuns(env, token, repo, branch);
    return [...new Set(runs.check_runs.map((r) => r.name).filter((n) => n.length > 0))].sort();
  } catch (e: unknown) {
    console.error("required checks read failed", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function openTaskForIssue(
  env: Env,
  p: { deliveryId: string; installationId: number; repo: AllowedRepo; issue: IssueInput; defaultBranch: string },
): Promise<OpenOutcome> {
  const principal = await ensurePrincipal(env);
  const existing = await openIssueRow(env, p.repo.id, p.issue.number);
  if (existing) {
    // Idempotent completion: a retried delivery whose first run created
    // the task but failed to comment gets its comment now.
    await ensureOpenedComment(env, existing);
    return { outcome: "already_open", task_id: existing.task_id };
  }

  const guild = await findGuildBySlug(env, "code");
  if (!guild) throw new Error("the code guild is missing");
  const reward = DEFAULT_REWARD_CREDITS;
  if (principal.credits < reward) return { outcome: "escrow_failed" };
  if (!(await hasQuota(env, principal, "tasks"))) return { outcome: "quota_exhausted" };

  const required = await checkNamesOnBranch(env, p.installationId, p.repo.full_name, p.defaultBranch);
  const title = truncateTitle(p.issue.title);
  const brief = buildBrief(p.repo.full_name, p.issue, p.defaultBranch);
  const condition = buildCondition(p.repo.full_name, p.issue, p.defaultBranch, required);
  const createdAt = nowMs();
  const expiry = Math.floor(createdAt / 1000) + DEFAULT_EXPIRY_DAYS * 86400;
  const dedupeKey = `github:${p.repo.id}:${p.issue.number}:${createdAt}`;

  const escrow = env.DB
    .prepare("UPDATE members SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .bind(reward, principal.id, reward);
  const insertTask = env.DB
    .prepare(
      `INSERT INTO tasks (guild_id, author_id, title, brief, condition, reward_credits, status, expiry, created_at, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .bind(guild.id, principal.id, title, brief, condition, reward, expiry, createdAt, dedupeKey);
  // last_insert_rowid() is the task id just inserted, inside the same transaction.
  const insertIssue = env.DB
    .prepare(
      `INSERT INTO github_issues (installation_id, repo_id, repo_full_name, issue_number, issue_url, base_branch, required_checks, task_id, delivery_id, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, last_insert_rowid(), ?, ?)`,
    )
    .bind(
      p.installationId,
      p.repo.id,
      p.repo.full_name,
      p.issue.number,
      p.issue.html_url,
      p.defaultBranch,
      JSON.stringify(required),
      p.deliveryId,
      createdAt,
    );

  let results: D1Result[];
  try {
    results = await env.DB.batch([escrow, insertTask, insertIssue]);
  } catch {
    // The partial unique index refused a second open row: someone opened
    // it between our read and here. The whole batch rolled back.
    const raced = await openIssueRow(env, p.repo.id, p.issue.number);
    if (raced) return { outcome: "already_open", task_id: raced.task_id };
    throw new Error("task open batch failed");
  }
  if (!results[0]?.meta.changes) return { outcome: "escrow_failed" };
  const taskId = Number(results[1]?.meta.last_row_id);

  await consumeQuota(env, principal, "tasks");
  await appendEvent(env, "task_created", {
    task_id: taskId,
    guild: guild.slug,
    author_id: principal.id,
    author: principal.handle,
    title,
    reward_credits: reward,
    expiry,
    source: "github",
    github: {
      repo: p.repo.full_name,
      repo_id: p.repo.id,
      installation_id: p.installationId,
      issue_number: p.issue.number,
      issue_url: p.issue.html_url,
      base_branch: p.defaultBranch,
      required_checks: required,
      delivery_id: p.deliveryId,
    },
    verdict_by: VERIFIER_ACTOR,
  });

  const row = await openIssueRow(env, p.repo.id, p.issue.number);
  if (row) await ensureOpenedComment(env, row);
  return { outcome: "opened", task_id: taskId };
}

async function ensureOpenedComment(env: Env, row: GithubIssueRow): Promise<void> {
  const task = await env.DB
    .prepare("SELECT reward_credits, expiry FROM tasks WHERE id = ?")
    .bind(row.task_id)
    .first<{ reward_credits: number; expiry: number | null }>();
  if (!task) return;
  const expiryUtc = task.expiry ? nowUtcISO(task.expiry * 1000) : "never";
  await postTransitionComment(
    env,
    row,
    "opened",
    0,
    openedComment({ task_url: taskUrl(row.task_id), reward: task.reward_credits, expiry_utc: expiryUtc }),
  );
}

// ---------------------------------------------------------------------
// Closing (label removed, issue closed or deleted, repository or
// installation removed). Escrow returns to the principal when nothing
// was accepted; pending submissions become `superseded`.
// ---------------------------------------------------------------------
export type CloseReason =
  | "label_removed"
  | "issue_closed"
  | "issue_deleted"
  | "repo_removed"
  | "installation_removed"
  | "expired";

export async function closeTaskForIssue(
  env: Env,
  row: GithubIssueRow,
  reason: CloseReason,
  principal: MemberRow,
  opts: { comment: boolean },
): Promise<{ closed: boolean; refunded: number }> {
  const claim = await env.DB
    .prepare("UPDATE tasks SET status = 'closed' WHERE id = ? AND status = 'open'")
    .bind(row.task_id)
    .run();
  const closedAt = nowMs();
  let refunded = 0;
  if (claim.meta.changes) {
    const accepted = await env.DB
      .prepare("SELECT 1 AS x FROM submissions WHERE task_id = ? AND status = 'accepted' LIMIT 1")
      .bind(row.task_id)
      .first<{ x: number }>();
    const task = await env.DB
      .prepare("SELECT reward_credits FROM tasks WHERE id = ?")
      .bind(row.task_id)
      .first<{ reward_credits: number }>();
    refunded = !accepted && task ? task.reward_credits : 0;
    const stmts: D1PreparedStatement[] = [
      env.DB
        .prepare("UPDATE submissions SET status = 'superseded', verdict_reason = ? WHERE task_id = ? AND status = 'pending'")
        .bind(`task closed (${reason}) before a verdict; no credits move`, row.task_id),
    ];
    if (refunded > 0) {
      stmts.push(env.DB.prepare("UPDATE members SET credits = credits + ? WHERE id = ?").bind(refunded, principal.id));
    }
    await env.DB.batch(stmts);
    await appendEvent(env, "task_closed", {
      task_id: row.task_id,
      author_id: principal.id,
      refunded_credits: refunded,
      source: "github",
      close_reason: reason,
      repo: row.repo_full_name,
      issue_number: row.issue_number,
    });
  }
  await env.DB
    .prepare("UPDATE github_issues SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL")
    .bind(closedAt, reason, row.id)
    .run();
  if (opts.comment) {
    if (reason === "expired") {
      await postTransitionComment(env, row, "expired", 0, expiredComment({ expiry_utc: nowUtcISO(closedAt) }));
    } else if (reason === "label_removed" || reason === "issue_closed") {
      // The spec posts the label-removed shape for a maintainer close too.
      await postTransitionComment(env, row, "label_removed", 0, labelRemovedComment());
    }
  }
  return { closed: Boolean(claim.meta.changes), refunded };
}
