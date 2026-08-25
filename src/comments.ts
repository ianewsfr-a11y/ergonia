// Comments on tasks.
//
//   POST /api/comments {task_id, body}
//     - Bearer auth required.
//     - 20/day quota per member.
//     - body: 1-2000 chars, trimmed.
//     - Chained: emits kind "comment".
//
// The endpoint exists so arena challenges can pin their dataset URLs
// in the task author's first comment (see seed/founding-tasks.json,
// arena tasks #1-#4). Every other member can add commentary too.
//
// Comments are surfaced on GET /api/tasks/:id (last 50, newest first)
// and can also be paginated via GET /api/tasks/:id/comments.

import { appendEvent } from "./chain.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import { taskById } from "./tasks.js";
import type { AuthContext, CommentRow, Env } from "./types.js";
import { error, isNonEmptyString, json, nowMs, readJson, safeInt } from "./util.js";

interface CreateCommentBody {
  task_id?: unknown;
  body?: unknown;
}

export async function handleCreateComment(
  env: Env,
  ctx: AuthContext,
  request: Request,
): Promise<Response> {
  const body = await readJson<CreateCommentBody>(request);
  if (!body) return error(400, "expected application/json body");
  const taskId = Number(body.task_id);
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!Number.isInteger(taskId) || taskId <= 0) {
    return error(400, "task_id must be a positive integer");
  }
  if (!isNonEmptyString(text, 1, 2000)) {
    return error(400, "body must be 1-2000 chars");
  }

  const task = await taskById(env, taskId);
  if (!task) return error(404, "task not found");

  if (!(await hasQuota(env, ctx.member, "comments"))) {
    return error(429, "daily comment quota exhausted (20/day, resets 00:00 UTC)");
  }

  const createdAt = nowMs();
  const inserted = await env.DB
    .prepare(
      "INSERT INTO comments (task_id, member_id, body, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(taskId, ctx.member.id, text, createdAt)
    .run();
  const id = Number(inserted.meta.last_row_id);

  await consumeQuota(env, ctx.member, "comments");
  await appendEvent(env, "comment", {
    comment_id: id,
    task_id: taskId,
    member_id: ctx.member.id,
    handle: ctx.member.handle,
  });

  return json({ comment: await commentById(env, id) }, { status: 201 });
}

export async function handleListComments(env: Env, taskId: number, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(safeInt(url.searchParams.get("limit") ?? "50", 50), 1), 200);
  const before = safeInt(url.searchParams.get("before") ?? "0", 0);
  const task = await taskById(env, taskId);
  if (!task) return error(404, "task not found");
  const args: (number)[] = [taskId];
  let where = "c.task_id = ?";
  if (before > 0) {
    where += " AND c.id < ?";
    args.push(before);
  }
  const rs = await env.DB
    .prepare(
      `SELECT c.id, c.task_id, c.member_id, m.handle AS author, c.body, c.created_at
         FROM comments c JOIN members m ON m.id = c.member_id
         WHERE ${where}
         ORDER BY c.id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all();
  return json({ comments: rs.results ?? [], limit });
}

export async function commentsForTask(env: Env, taskId: number, limit = 50) {
  const rs = await env.DB
    .prepare(
      `SELECT c.id, c.task_id, c.member_id, m.handle AS author, c.body, c.created_at
         FROM comments c JOIN members m ON m.id = c.member_id
         WHERE c.task_id = ? ORDER BY c.id DESC LIMIT ?`,
    )
    .bind(taskId, limit)
    .all();
  return rs.results ?? [];
}

async function commentById(env: Env, id: number): Promise<CommentRow | null> {
  return (
    (await env.DB
      .prepare(
        `SELECT c.id, c.task_id, c.member_id, c.body, c.created_at,
                m.handle AS author
           FROM comments c JOIN members m ON m.id = c.member_id
           WHERE c.id = ?`,
      )
      .bind(id)
      .first<CommentRow & { author: string }>()) ?? null
  );
}
