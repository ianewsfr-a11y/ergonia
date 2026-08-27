// POST /api/rotate — a member replaces its own secret.
//
// Why this exists: a member's handle is unique and unclaimable twice, and
// karma and credits hang off the member row. Before this endpoint, a
// member whose key leaked had exactly two options — keep operating with an
// attacker holding the same credentials, or abandon the identity and lose
// the reputation attached to it. Recovery has to be cheaper than that, or
// the honest response to a leak is to say nothing.
//
// Three properties this endpoint is built around:
//
//   1. The old secret dies the moment the new one is issued. There is no
//      grace period and no dual-validity window: overlapping keys would
//      mean a leaked key keeps working for as long as the window lasts,
//      which is the situation rotation exists to end.
//
//   2. Nothing derived from either secret reaches the event chain. The
//      chain is public, so writing the SHA-256 of a key into it would hand
//      an attacker an offline oracle: guess a secret, hash it, compare
//      against the register, no request to Ergonia required. The event
//      records that member N rotated, and nothing else.
//
//   3. Rotation is not a quota'd action. Quotas exist to pace how much a
//      member can put in front of others - tasks, submissions, comments.
//      Rotation puts nothing in front of anyone, and rate-limiting the
//      response to a compromise would be exactly backwards. The per-IP
//      limit on /api/* still applies, which is the right kind of bound.

import { appendEvent } from "./chain.js";
import { newSecret, sha256Hex } from "./hash.js";
import type { AuthContext, Env } from "./types.js";
import { error, json } from "./util.js";

export async function handleRotate(env: Env, ctx: AuthContext): Promise<Response> {
  const secret = newSecret();
  const nextHash = await sha256Hex(secret);

  // Claim the transition, then act - the same shape used for task closure
  // and verdicts. The WHERE clause pins the CURRENT hash, so if two
  // rotations race with the same key exactly one of them can win; the
  // loser changes nothing and is told so, rather than silently minting a
  // second secret and leaving the member unsure which one is live.
  const claim = await env.DB
    .prepare("UPDATE members SET secret_hash = ? WHERE id = ? AND secret_hash = ?")
    .bind(nextHash, ctx.member.id, ctx.member.secret_hash)
    .run();
  if (!claim.meta.changes) {
    return error(409, "the key used for this request was already rotated; retry with the current key");
  }

  await appendEvent(env, "rotate", {
    member_id: ctx.member.id,
    handle: ctx.member.handle,
  });

  return json({
    id: ctx.member.id,
    handle: ctx.member.handle,
    secret,
    note: "This secret is shown once and replaces the previous one, which stopped working the moment this response was produced.",
  });
}
