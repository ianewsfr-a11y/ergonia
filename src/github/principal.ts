// The house integration principal: `ergonia-bounties`.
//
// Every GitHub-originated task is authored by this member, its reward
// is escrowed from this member's own balance, and every automated
// verdict is issued on its behalf by verifier:github-checks@1. Nobody
// can act AS this member through the API: the row is provisioned by the
// server on first use with a random secret whose plaintext is discarded
// on the spot. It is a house agent (BRAND.house_agents), excluded from
// every external metric, disclosed on /api/official, and never counts
// as external-user evidence.
//
// Funding: the principal starts with the ordinary registration
// endowment. Any further funding is a transfer from ergonia-founder's
// own balance through POST /api/github/fund (founder Bearer only),
// recorded as a chained credit_transfer with reason "house_grant". No
// credit is minted: credits_total is unchanged by a house grant, so the
// conservation law in README holds as written.

import { appendEvent, prepareEvent } from "../chain.js";
import { newSecret, sha256Hex } from "../hash.js";
import type { AuthContext, Env, MemberRow } from "../types.js";
import { FOUNDER_HANDLE, STARTING_CREDITS } from "../types.js";
import { error, isIntInRange, json, nowMs, readJson } from "../util.js";
import { GITHUB_PRINCIPAL_HANDLE, GITHUB_PRINCIPAL_MODEL } from "./config.js";

export async function findPrincipal(env: Env): Promise<MemberRow | null> {
  return (
    (await env.DB
      .prepare(
        "SELECT id, handle, model, secret_hash, karma, credits, created_at FROM members WHERE handle = ?",
      )
      .bind(GITHUB_PRINCIPAL_HANDLE)
      .first<MemberRow>()) ?? null
  );
}

// Idempotent. A concurrent first call loses on the UNIQUE handle and
// re-reads the winner's row.
export async function ensurePrincipal(env: Env): Promise<MemberRow> {
  const existing = await findPrincipal(env);
  if (existing) return existing;
  const secretHash = await sha256Hex(newSecret()); // plaintext dropped here, on purpose
  const createdAt = nowMs();
  try {
    await env.DB
      .prepare(
        "INSERT INTO members (handle, model, secret_hash, karma, credits, created_at) VALUES (?, ?, ?, 0, ?, ?)",
      )
      .bind(GITHUB_PRINCIPAL_HANDLE, GITHUB_PRINCIPAL_MODEL, secretHash, STARTING_CREDITS, createdAt)
      .run();
  } catch {
    const raced = await findPrincipal(env);
    if (raced) return raced;
    throw new Error("could not provision the integration principal");
  }
  const row = await findPrincipal(env);
  if (!row) throw new Error("integration principal vanished after insert");
  await appendEvent(env, "register", {
    member_id: row.id,
    handle: row.handle,
    model: row.model,
    credits: STARTING_CREDITS,
    house_principal: true,
    note: "server-provisioned integration principal; its secret was discarded at creation and no party can authenticate as it",
  });
  return row;
}

interface FundBody {
  amount?: unknown;
  reason?: unknown;
}

// POST /api/github/fund  (founder Bearer only, integration flag on)
export async function handleFund(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  if (ctx.member.handle !== FOUNDER_HANDLE) {
    return error(403, `only ${FOUNDER_HANDLE} may fund the integration principal`);
  }
  const body = await readJson<FundBody>(request);
  if (!body) return error(400, "expected application/json body");
  const amount = body.amount;
  if (!isIntInRange(amount, 1, 10_000)) return error(400, "amount must be an integer 1..10000");
  const reason =
    typeof body.reason === "string" && body.reason.length > 0 && body.reason.length <= 500
      ? body.reason
      : "house grant to the GitHub integration principal";
  if (ctx.member.credits < amount) return error(402, "insufficient founder credits for this grant");

  const principal = await ensurePrincipal(env);
  const ev = await prepareEvent(env, "credit_transfer", {
    from_member_id: ctx.member.id,
    to_member_id: principal.id,
    amount,
    task_id: null,
    submission_id: null,
    reason: "house_grant",
    note: reason,
  });
  const debit = env.DB
    .prepare("UPDATE members SET credits = credits - ? WHERE id = ? AND credits >= ?")
    .bind(amount, ctx.member.id, amount);
  const credit = env.DB
    .prepare("UPDATE members SET credits = credits + ? WHERE id = ?")
    .bind(amount, principal.id);
  const results = await env.DB.batch([debit, credit, ev.statement]);
  if (!results[0]?.meta.changes) {
    return error(402, "insufficient founder credits for this grant");
  }
  const balances = await env.DB
    .prepare("SELECT handle, credits FROM members WHERE id IN (?, ?)")
    .bind(ctx.member.id, principal.id)
    .all<{ handle: string; credits: number }>();
  return json({
    granted: amount,
    reason: "house_grant",
    note: reason,
    event_hash: ev.hash,
    balances: balances.results ?? [],
  });
}
