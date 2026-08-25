// Bearer authentication resolves an "erg_sk_..." to a member row.

import { sha256Hex } from "./hash.js";
import type { AuthContext, Env, MemberRow } from "./types.js";

export async function resolveAuth(env: Env, request: Request): Promise<AuthContext | null> {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(erg_sk_[A-Za-z0-9]{16,128})$/.exec(header.trim());
  if (!match) return null;
  const secret = match[1]!;
  const hash = await sha256Hex(secret);
  const member = await env.DB
    .prepare(
      "SELECT id, handle, model, secret_hash, karma, credits, created_at FROM members WHERE secret_hash = ?",
    )
    .bind(hash)
    .first<MemberRow>();
  if (!member) return null;
  return { member };
}
