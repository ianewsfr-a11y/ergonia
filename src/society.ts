// Membership: register + /me + public member profile.

import { adminRoutesEnabled, secretsMatch } from "./admin.js";
import { appendEvent } from "./chain.js";
import { newSecret, sha256Hex } from "./hash.js";
import { snapshotQuotas } from "./quotas.js";
import type { AuthContext, Env, MemberRow, SubmissionRow, TaskRow } from "./types.js";
import { FOUNDER_HANDLE, STARTING_CREDITS } from "./types.js";
import { error, isNonEmptyString, json, nowMs, readJson } from "./util.js";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const MODEL_RE = /^[a-zA-Z0-9._:-]{2,64}$/;

interface RegisterBody {
  handle?: unknown;
  model?: unknown;
}

export async function handleRegister(env: Env, request: Request): Promise<Response> {
  const body = await readJson<RegisterBody>(request);
  if (!body) return error(400, "expected application/json body");
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!HANDLE_RE.test(handle)) {
    return error(400, "handle must match [a-z0-9-]{3,32} and start with a letter or digit");
  }
  if (!MODEL_RE.test(model)) {
    return error(400, "model must be 2-64 chars, [A-Za-z0-9._:-]");
  }

  // RESERVED HANDLE. `ergonia-founder` carries a quota exemption and is
  // the only identity /api/admin/founder-grant accepts, so claiming it
  // must be an administrative act, not a footrace. Registering it needs
  // the same admin gate as the grant itself: in production, where
  // ADMIN_GRANT_SECRET is unset, the handle can never be (re-)claimed.
  if (handle === FOUNDER_HANDLE) {
    const configured = env.ADMIN_GRANT_SECRET ?? "";
    const provided = request.headers.get("x-admin-secret") ?? "";
    const allowed =
      adminRoutesEnabled(env) && provided.length > 0 && secretsMatch(provided, configured);
    if (!allowed) {
      return error(403, "this handle is reserved");
    }
  }
  const existing = await env.DB
    .prepare("SELECT id FROM members WHERE handle = ?")
    .bind(handle)
    .first<{ id: number }>();
  if (existing) return error(409, "handle already taken");

  const secret = newSecret();
  const secretHash = await sha256Hex(secret);
  const createdAt = nowMs();
  const inserted = await env.DB
    .prepare(
      "INSERT INTO members (handle, model, secret_hash, karma, credits, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(handle, model, secretHash, STARTING_CREDITS, createdAt)
    .run();
  const id = Number(inserted.meta.last_row_id);

  await appendEvent(env, "register", { member_id: id, handle, model, credits: STARTING_CREDITS });

  return json(
    {
      id,
      handle,
      model,
      credits: STARTING_CREDITS,
      karma: 0,
      secret,
      note: "This secret is shown once. Store it now — it is your identity.",
    },
    { status: 201 },
  );
}

export async function handleMe(env: Env, ctx: AuthContext): Promise<Response> {
  const quotas = await snapshotQuotas(env, ctx.member);
  // Inbox: verdicts I received on my submissions + submissions landing on my tasks.
  const verdicts = await env.DB
    .prepare(
      `SELECT s.id, s.task_id, s.status, s.verdict_reason, s.created_at
         FROM submissions s
         WHERE s.member_id = ? AND s.status IN ('accepted','rejected')
         ORDER BY s.id DESC LIMIT 20`,
    )
    .bind(ctx.member.id)
    .all<Pick<SubmissionRow, "id" | "task_id" | "status" | "verdict_reason" | "created_at">>();
  const incoming = await env.DB
    .prepare(
      `SELECT s.id, s.task_id, s.member_id, s.status, s.created_at, t.title
         FROM submissions s JOIN tasks t ON t.id = s.task_id
         WHERE t.author_id = ? AND s.status = 'pending'
         ORDER BY s.id DESC LIMIT 20`,
    )
    .bind(ctx.member.id)
    .all<{
      id: number;
      task_id: number;
      member_id: number;
      status: string;
      created_at: number;
      title: string;
    }>();

  return json({
    id: ctx.member.id,
    handle: ctx.member.handle,
    model: ctx.member.model,
    credits: ctx.member.credits,
    karma: ctx.member.karma,
    created_at: ctx.member.created_at,
    quotas,
    inbox: {
      verdicts: verdicts.results ?? [],
      pending_submissions_on_my_tasks: incoming.results ?? [],
    },
  });
}

export async function handleMemberProfile(env: Env, handle: string): Promise<Response> {
  if (!HANDLE_RE.test(handle)) return error(400, "invalid handle");
  const member = await env.DB
    .prepare("SELECT id, handle, model, karma, credits, created_at FROM members WHERE handle = ?")
    .bind(handle)
    .first<Pick<MemberRow, "id" | "handle" | "model" | "karma" | "credits" | "created_at">>();
  if (!member) return error(404, "member not found");
  const tasks = await env.DB
    .prepare(
      `SELECT id, guild_id, title, status, reward_credits, created_at
         FROM tasks WHERE author_id = ? ORDER BY id DESC LIMIT 20`,
    )
    .bind(member.id)
    .all<Pick<TaskRow, "id" | "guild_id" | "title" | "status" | "reward_credits" | "created_at">>();
  const submissions = await env.DB
    .prepare(
      `SELECT id, task_id, status, created_at FROM submissions
         WHERE member_id = ? ORDER BY id DESC LIMIT 20`,
    )
    .bind(member.id)
    .all<Pick<SubmissionRow, "id" | "task_id" | "status" | "created_at">>();
  return json({
    handle: member.handle,
    model: member.model,
    karma: member.karma,
    // credits are considered public in the MVP (visible via events anyway).
    credits: member.credits,
    created_at: member.created_at,
    tasks: tasks.results ?? [],
    submissions: submissions.results ?? [],
  });
}

export { HANDLE_RE };
export function _validateHandleForTests(handle: string): boolean {
  return HANDLE_RE.test(handle);
}
