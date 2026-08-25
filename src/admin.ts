// Admin endpoints — carefully scoped, idempotent, chained.
//
// POST /api/admin/founder-grant
//   Bootstrap the founding member's credit endowment. The event is
//   chained (kind: "founder_grant") so the register carries a truthful
//   record of where the founding credits came from — no "magic" balance.
//
// Constraints (all enforced server-side):
//   - Bearer auth required.
//   - Caller must be the reserved FOUNDER_HANDLE.
//   - Amount is a positive integer in [1, 100000].
//   - Only one founder_grant event may exist per member, ever. Second
//     attempt returns 409. This turns the endpoint into a single-use
//     bootstrap and lets it stay in the codebase safely.

import { appendEvent } from "./chain.js";
import type { AuthContext, Env } from "./types.js";
import { FOUNDER_HANDLE } from "./types.js";
import { error, isIntInRange, json, readJson } from "./util.js";

interface FounderGrantBody {
  amount?: unknown;
  reason?: unknown;
}

export async function handleFounderGrant(
  env: Env,
  ctx: AuthContext,
  request: Request,
): Promise<Response> {
  if (ctx.member.handle !== FOUNDER_HANDLE) {
    return error(403, `only ${FOUNDER_HANDLE} may call this endpoint`);
  }
  const body = await readJson<FounderGrantBody>(request);
  if (!body) return error(400, "expected application/json body");
  const amount = body.amount;
  if (!isIntInRange(amount, 1, 100_000)) {
    return error(400, "amount must be an integer 1..100000");
  }
  const reason =
    typeof body.reason === "string" && body.reason.length <= 500 && body.reason.length > 0
      ? body.reason
      : "genesis endowment for the founding tasks";

  const existing = await env.DB
    .prepare(
      "SELECT COUNT(*) AS n FROM events WHERE kind = 'founder_grant' AND json_extract(payload, '$.member_id') = ?",
    )
    .bind(ctx.member.id)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return error(409, "founder_grant already recorded for this member (single-use)");
  }

  await env.DB
    .prepare("UPDATE members SET credits = credits + ? WHERE id = ?")
    .bind(amount, ctx.member.id)
    .run();

  const ev = await appendEvent(env, "founder_grant", {
    member_id: ctx.member.id,
    handle: ctx.member.handle,
    amount,
    reason,
  });

  const updated = await env.DB
    .prepare("SELECT credits, karma FROM members WHERE id = ?")
    .bind(ctx.member.id)
    .first<{ credits: number; karma: number }>();

  return json({
    granted: amount,
    reason,
    event: { id: ev.id, hash: ev.hash },
    member: { handle: ctx.member.handle, credits: updated?.credits ?? 0, karma: updated?.karma ?? 0 },
  });
}
