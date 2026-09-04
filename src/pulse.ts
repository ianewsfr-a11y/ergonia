// /api/pulse, /api/events, /api/attest.

import { attestChain } from "./chain.js";
import type { Env, EventKind, EventRow } from "./types.js";
import { error, json, safeInt } from "./util.js";

export async function handlePulse(env: Env): Promise<Response> {
  const t = await env.DB.prepare("SELECT MAX(id) AS id FROM tasks").first<{ id: number | null }>();
  const s = await env.DB.prepare("SELECT MAX(id) AS id FROM submissions").first<{ id: number | null }>();
  const e = await env.DB.prepare("SELECT MAX(id) AS id FROM events").first<{ id: number | null }>();
  const m = await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first<{ n: number }>();
  return json({
    last_task_id: t?.id ?? 0,
    last_submission_id: s?.id ?? 0,
    last_event_id: e?.id ?? 0,
    members: m?.n ?? 0,
  });
}

const VALID_KINDS: EventKind[] = [
  "register",
  "task_created",
  "task_closed",
  "submission",
  "verdict",
  "credit_transfer",
  "founder_grant",
  "comment",
  "moderation",
  "rotate",
  "github_installation",
  "github_comment",
];

export async function handleEvents(env: Env, url: URL): Promise<Response> {
  const kind = url.searchParams.get("kind");
  const before = safeInt(url.searchParams.get("before") ?? "0", 0);
  const limit = Math.min(Math.max(safeInt(url.searchParams.get("limit") ?? "50", 50), 1), 200);
  const args: (string | number)[] = [];
  const clauses: string[] = [];
  if (kind) {
    if (!VALID_KINDS.includes(kind as EventKind)) return error(400, "invalid kind");
    clauses.push("kind = ?");
    args.push(kind);
  }
  if (before > 0) {
    clauses.push("id < ?");
    args.push(before);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const rs = await env.DB
    .prepare(
      `SELECT id, kind, payload, prev_hash, hash, created_at
         FROM events ${where} ORDER BY id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<EventRow>();
  const rows = (rs.results ?? []).map((r) => ({
    ...r,
    payload: safeParse(r.payload),
  }));
  return json({ events: rows, limit });
}

export async function handleAttest(env: Env): Promise<Response> {
  const report = await attestChain(env);
  return json(report, { status: report.ok ? 200 : 409 });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
