// POST /api/github/webhook
//
// Order of gates, each failing closed:
//   1. integration flag (router: 404 when off)
//   2. secrets present (503, names only)
//   3. X-Hub-Signature-256 over the raw body (401)
//   4. payload shape and event headers (400)
//   5. dogfood allowlist: repository id AND name, or owner account for
//      installation events (202 "ignored", NO database write)
//   6. delivery GUID dedupe (200 "duplicate", no other write)
// Then the event is processed; a thrown error deletes the delivery row
// and answers 500 so GitHub's retry is processed again. Every state
// write downstream is idempotent on natural keys.
//
// Nothing in this file logs a header value, a secret, or a token.

import { appendEvent } from "../chain.js";
import type { Env } from "../types.js";
import { error, json, nowMs } from "../util.js";
import {
  BOUNTY_LABEL,
  allowedOwner,
  allowedRepo,
  integrationEnabled,
  missingSecrets,
  type AllowedRepo,
} from "./config.js";
import {
  closeTaskForIssue,
  openIssueRow,
  openIssueRowsForInstallation,
  openIssueRowsForRepo,
  openTaskForIssue,
} from "./issue.js";
import { ensurePrincipal } from "./principal.js";
import { verifyWebhookSignature } from "./signature.js";
import { verifyPendingForRepo } from "./verifier.js";

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

export async function handleGithubWebhook(env: Env, request: Request): Promise<Response> {
  if (!integrationEnabled(env)) return error(404, "no route for POST /api/github/webhook");
  const missing = missingSecrets(env);
  if (missing.length > 0) {
    console.error("github webhook: missing configuration", missing.join(","));
    return error(503, "github integration is not configured on this deployment");
  }

  const raw = await request.arrayBuffer();
  const ok = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET!, raw, request.headers.get("x-hub-signature-256"));
  if (!ok) return error(401, "invalid webhook signature");

  const event = request.headers.get("x-github-event") ?? "";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(event) || !/^[A-Za-z0-9-]{8,80}$/.test(delivery)) {
    return error(400, "missing or malformed X-GitHub-Event / X-GitHub-Delivery");
  }
  let payload: Obj;
  try {
    payload = obj(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return error(400, "body is not JSON");
  }
  const action = str(payload.action);

  // Gate 5: the allowlist, before any write.
  const repoObj = obj(payload.repository);
  const repo = allowedRepo(num(repoObj.id), str(repoObj.full_name));
  const installationId = num(obj(payload.installation).id);
  if (event === "installation" || event === "installation_repositories") {
    const account = obj(obj(payload.installation).account);
    if (!allowedOwner(num(account.id), str(account.login))) {
      return json({ ok: true, outcome: "ignored", why: "installation account is not in the dogfood allowlist" }, { status: 202 });
    }
  } else if (event !== "ping") {
    if (!repo) {
      return json({ ok: true, outcome: "ignored", why: "repository is not in the dogfood allowlist" }, { status: 202 });
    }
    if (!Number.isInteger(installationId)) {
      return json({ ok: true, outcome: "ignored", why: "no installation on the payload" }, { status: 202 });
    }
  }

  // Gate 6: delivery dedupe.
  const ins = await env.DB
    .prepare("INSERT OR IGNORE INTO github_deliveries (delivery_id, event, action, received_at, outcome) VALUES (?, ?, ?, ?, 'processing')")
    .bind(delivery, event, action || null, nowMs())
    .run();
  if (!ins.meta.changes) {
    return json({ ok: true, outcome: "duplicate", delivery });
  }

  try {
    const outcome = await dispatch(env, { event, action, delivery, payload, repo, installationId });
    await env.DB
      .prepare("UPDATE github_deliveries SET outcome = ? WHERE delivery_id = ?")
      .bind(outcome.startsWith("ignored") ? "ignored" : "processed", delivery)
      .run();
    return json({ ok: true, outcome, delivery, event, action });
  } catch (e: unknown) {
    await env.DB.prepare("DELETE FROM github_deliveries WHERE delivery_id = ?").bind(delivery).run();
    console.error("github webhook processing failed", event, action, e instanceof Error ? e.message : String(e));
    return error(500, "webhook processing failed; GitHub may retry this delivery");
  }
}

interface Ctx {
  event: string;
  action: string;
  delivery: string;
  payload: Obj;
  repo: AllowedRepo | null;
  installationId: number;
}

async function dispatch(env: Env, c: Ctx): Promise<string> {
  switch (c.event) {
    case "ping":
      return "pong";
    case "installation":
      return onInstallation(env, c);
    case "installation_repositories":
      return onInstallationRepositories(env, c);
    case "issues":
      return onIssues(env, c);
    case "pull_request":
      return onPullRequest(env, c);
    case "check_run":
      return onCheckRun(env, c);
    default:
      return `ignored: event ${c.event} is not handled`;
  }
}

async function onInstallation(env: Env, c: Ctx): Promise<string> {
  const inst = obj(c.payload.installation);
  const account = obj(inst.account);
  const id = num(inst.id);
  if (!Number.isInteger(id)) return "ignored: installation without id";
  if (c.action === "created") {
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO github_installations (installation_id, account_id, account_login, account_type, installed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, num(account.id), str(account.login), str(account.type) || "User", nowMs())
      .run();
    await appendEvent(env, "github_installation", { action: "created", installation_id: id, account_id: num(account.id), account_login: str(account.login), delivery_id: c.delivery });
    return "installation recorded";
  }
  if (c.action === "deleted") {
    await env.DB.prepare("UPDATE github_installations SET removed_at = ? WHERE installation_id = ? AND removed_at IS NULL").bind(nowMs(), id).run();
    const principal = await ensurePrincipal(env);
    const rows = await openIssueRowsForInstallation(env, id);
    for (const row of rows) await closeTaskForIssue(env, row, "installation_removed", principal, { comment: false });
    await appendEvent(env, "github_installation", { action: "deleted", installation_id: id, closed_tasks: rows.map((r) => r.task_id), delivery_id: c.delivery });
    return `installation removed; ${rows.length} task(s) closed`;
  }
  return `ignored: installation.${c.action}`;
}

async function onInstallationRepositories(env: Env, c: Ctx): Promise<string> {
  if (c.action !== "removed") return `ignored: installation_repositories.${c.action}`;
  const removed = Array.isArray(c.payload.repositories_removed) ? (c.payload.repositories_removed as unknown[]) : [];
  const principal = await ensurePrincipal(env);
  let closed = 0;
  for (const r of removed) {
    const repo = allowedRepo(num(obj(r).id), str(obj(r).full_name));
    if (!repo) continue;
    for (const row of await openIssueRowsForRepo(env, repo.id)) {
      await closeTaskForIssue(env, row, "repo_removed", principal, { comment: false });
      closed++;
    }
  }
  return `repositories removed; ${closed} task(s) closed`;
}

async function onIssues(env: Env, c: Ctx): Promise<string> {
  const repo = c.repo!;
  const issue = obj(c.payload.issue);
  const number = num(issue.number);
  if (!Number.isInteger(number) || number <= 0) return "ignored: issue without number";
  const label = str(obj(c.payload.label).name);
  const isPr = obj(issue.pull_request).url !== undefined;
  if (isPr) return "ignored: the labelled item is a pull request, not an issue";

  if (c.action === "labeled") {
    if (label !== BOUNTY_LABEL) return `ignored: label ${JSON.stringify(label)} is not ${BOUNTY_LABEL}`;
    if (str(issue.state) !== "open") return "ignored: issue is not open";
    const r = await openTaskForIssue(env, {
      deliveryId: c.delivery,
      installationId: c.installationId,
      repo,
      issue: { number, title: str(issue.title), body: str(issue.body), html_url: str(issue.html_url) },
      defaultBranch: str(obj(c.payload.repository).default_branch) || "main",
    });
    return r.outcome === "opened" || r.outcome === "already_open" ? `${r.outcome}: task ${r.task_id}` : r.outcome;
  }
  if (c.action === "unlabeled" && label === BOUNTY_LABEL) {
    return closeOpen(env, repo.id, number, "label_removed");
  }
  if (c.action === "closed") return closeOpen(env, repo.id, number, "issue_closed");
  if (c.action === "deleted") return closeOpen(env, repo.id, number, "issue_deleted");
  return `ignored: issues.${c.action}`;
}

async function closeOpen(env: Env, repoId: number, number: number, reason: "label_removed" | "issue_closed" | "issue_deleted"): Promise<string> {
  const row = await openIssueRow(env, repoId, number);
  if (!row) return `ignored: no open task for issue #${number}`;
  const principal = await ensurePrincipal(env);
  const r = await closeTaskForIssue(env, row, reason, principal, { comment: reason !== "issue_deleted" });
  return `${reason}: task ${row.task_id} ${r.closed ? "closed" : "was already closed"}; refunded ${r.refunded}`;
}

async function onPullRequest(env: Env, c: Ctx): Promise<string> {
  const repo = c.repo!;
  if (!["synchronize", "closed", "reopened", "opened", "edited"].includes(c.action)) {
    return `ignored: pull_request.${c.action}`;
  }
  const number = num(obj(c.payload.pull_request).number);
  if (!Number.isInteger(number)) return "ignored: pull_request without number";
  const results = await verifyPendingForRepo(env, repo.id, { prNumber: number });
  return `verified ${results.length} submission(s): ${results.map((r) => `${r.submission_id}=${r.verdict}`).join(",") || "none"}`;
}

async function onCheckRun(env: Env, c: Ctx): Promise<string> {
  const repo = c.repo!;
  if (c.action !== "completed") return `ignored: check_run.${c.action}`;
  const sha = str(obj(c.payload.check_run).head_sha);
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return "ignored: check_run without head_sha";
  const results = await verifyPendingForRepo(env, repo.id, { headSha: sha });
  return `verified ${results.length} submission(s): ${results.map((r) => `${r.submission_id}=${r.verdict}`).join(",") || "none"}`;
}
