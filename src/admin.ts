// Admin endpoints — gated, single-use by construction, chained.
//
// POST /api/admin/founder-grant
//   Bootstrap the founding member's credit endowment. The event is
//   chained (kind: "founder_grant") so the register carries a truthful
//   record of where the founding credits came from — no "magic" balance.
//
// SECURITY MODEL (post phase-2 review). Four independent gates, all
// server-side, in this order:
//
//   1. ENVIRONMENT GATE. If `ADMIN_GRANT_SECRET` is unset or empty, the
//      route does not exist: 404, identical to any unknown path. This is
//      how production runs — the founding grant is already recorded and
//      the endpoint is unreachable. Local dev and the test suite set the
//      binding, which is what keeps this code exercisable.
//   2. ADMIN SECRET. When the route is enabled, the caller must send
//      `X-Admin-Secret` matching the binding, compared in constant time
//      so the endpoint is not a timing oracle. This secret is provisioned
//      with `wrangler secret put ADMIN_GRANT_SECRET` — never hardcoded,
//      never logged, never echoed back.
//   3. FOUNDER IDENTITY. Bearer must resolve to the reserved
//      FOUNDER_HANDLE member.
//   4. CHAIN UNIQUENESS, enforced by the storage engine. Migration 0003
//      creates a partial UNIQUE index permitting exactly one
//      founder_grant row chain-wide. The credit UPDATE and the event
//      INSERT go out in ONE D1 batch (= one transaction), so a losing
//      racer's INSERT is rejected by the index and its credit UPDATE
//      rolls back with it. Previously these were two separate awaits and
//      concurrent callers could both credit.

import { prepareEvent } from "./chain.js";
import type { AuthContext, Env } from "./types.js";
import { FOUNDER_HANDLE } from "./types.js";
import { error, isIntInRange, json, readJson } from "./util.js";

interface FounderGrantBody {
  amount?: unknown;
  reason?: unknown;
}

// Length-independent, content-constant-time string comparison.
// Returns false for any length mismatch without leaking where it differs.
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Are the /api/admin/* routes enabled in this environment at all?
export function adminRoutesEnabled(env: Env): boolean {
  const s = env.ADMIN_GRANT_SECRET;
  return typeof s === "string" && s.length > 0;
}

// Gate 2. Call only when adminRoutesEnabled(env) is true.
function adminSecretAccepted(env: Env, request: Request): boolean {
  const configured = env.ADMIN_GRANT_SECRET ?? "";
  const provided = request.headers.get("x-admin-secret") ?? "";
  return provided.length > 0 && secretsMatch(provided, configured);
}

export async function handleFounderGrant(
  env: Env,
  ctx: AuthContext,
  request: Request,
): Promise<Response> {
  // Gate 1 is applied by the router (404 before auth is even attempted),
  // but re-assert here so the handler is safe to call from anywhere.
  if (!adminRoutesEnabled(env)) {
    return error(404, "no route for POST /api/admin/founder-grant");
  }
  // Gate 2. Deliberately the same 404 as a disabled route: a caller
  // without the admin secret cannot distinguish "wrong secret" from
  // "endpoint does not exist", and learns nothing by probing.
  if (!adminSecretAccepted(env, request)) {
    return error(404, "no route for POST /api/admin/founder-grant");
  }
  // Gate 3.
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

  // Fast path: report the already-granted case as a clean 409 rather than
  // letting the unique index surface as a 500. This is a courtesy check,
  // NOT the guarantee — gate 4 below is what actually enforces it.
  const existing = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'founder_grant'")
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return error(409, "a founder_grant is already recorded in the chain (single-use, chain-wide)");
  }

  // Gate 4. One batch = one transaction. If the partial UNIQUE index
  // rejects the event INSERT because a concurrent caller committed first,
  // the credit UPDATE in the same batch is rolled back too.
  const ev = await prepareEvent(env, "founder_grant", {
    member_id: ctx.member.id,
    handle: ctx.member.handle,
    amount,
    reason,
  });
  const creditUpdate = env.DB
    .prepare("UPDATE members SET credits = credits + ? WHERE id = ?")
    .bind(amount, ctx.member.id);

  try {
    await env.DB.batch([creditUpdate, ev.statement]);
  } catch {
    // The only expected failure here is the uniqueness constraint, i.e.
    // we lost a race. Nothing was credited: the batch rolled back.
    return error(409, "a founder_grant is already recorded in the chain (single-use, chain-wide)");
  }

  const eventRow = await env.DB
    .prepare("SELECT id FROM events WHERE hash = ?")
    .bind(ev.hash)
    .first<{ id: number }>();
  const updated = await env.DB
    .prepare("SELECT credits, karma FROM members WHERE id = ?")
    .bind(ctx.member.id)
    .first<{ credits: number; karma: number }>();

  return json({
    granted: amount,
    reason,
    event: { id: eventRow?.id ?? null, hash: ev.hash },
    member: { handle: ctx.member.handle, credits: updated?.credits ?? 0, karma: updated?.karma ?? 0 },
  });
}
