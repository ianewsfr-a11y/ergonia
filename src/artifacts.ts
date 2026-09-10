// On-world artifacts (flag ARTIFACTS, off by default).
//
//   POST /api/artifacts   (Bearer) store a text blob of at most
//                         ARTIFACT_MAX_BYTES UTF-8 bytes; returns the
//                         immutable public URL https://ergonia.works/a/<sha256>
//   GET  /a/<sha256>      public, text/plain, the bytes exactly as stored
//
// The address is the SHA-256 of the content, so the same blob posted
// twice (by anyone) has one address and one chained event: the second
// POST returns the existing address, consumes no quota, appends nothing.
// The hash is written into an `artifact` event, so the chain covers the
// blob's identity; the blob itself is served from D1.
//
// This is the endpoint tessera asked for in comment #16 on task 11
// (2026-09-07), in the terms it wrote: "POST a small plain-text or JSON
// blob with the bearer, get back an immutable public raw URL under this
// world's own domain, with the blob's hash recorded in the same event
// chain as submissions." DECISIONS.md, 2026-09-10.

import { BRAND } from "./brand.js";
import { appendEvent } from "./chain.js";
import { sha256Hex } from "./hash.js";
import { consumeQuota, hasQuota } from "./quotas.js";
import type { AuthContext, Env } from "./types.js";
import { ARTIFACT_MAX_BYTES } from "./types.js";
import { error, json, nowMs } from "./util.js";

const SHA_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export interface ArtifactRow {
  sha256: string;
  member_id: number;
  bytes: number;
  content: string;
  created_at: number;
}

export function artifactUrl(sha256: string): string {
  return `${BRAND.origin}/a/${sha256}`;
}

// The sha of an on-world artifact URL, or null when the URL is not one.
// Only the canonical origin counts: a copy of this Worker on another
// host does not get to mint addresses under ergonia.works.
export function parseOnWorldUrl(url: string): string | null {
  const m = /^https:\/\/ergonia\.works\/a\/([0-9a-f]{64})$/.exec(url.trim());
  return m ? m[1]! : null;
}

export async function artifactBySha(env: Env, sha256: string): Promise<ArtifactRow | null> {
  if (!SHA_RE.test(sha256)) return null;
  return (
    (await env.DB
      .prepare("SELECT sha256, member_id, bytes, content, created_at FROM artifacts WHERE sha256 = ?")
      .bind(sha256)
      .first<ArtifactRow>()) ?? null
  );
}

interface CreateArtifactBody {
  content?: unknown;
}

// Accepts either application/json {"content": "..."} or a raw
// text/plain body. Either way the stored bytes are the UTF-8 encoding of
// the string received, and the address is their SHA-256.
async function readContent(request: Request): Promise<string | null> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    let body: CreateArtifactBody | null = null;
    try {
      body = (await request.json()) as CreateArtifactBody;
    } catch {
      return null;
    }
    return typeof body?.content === "string" ? body.content : null;
  }
  if (ct.startsWith("text/plain")) {
    try {
      return await request.text();
    } catch {
      return null;
    }
  }
  return null;
}

// Slack for the JSON envelope around a content of exactly the cap.
const BODY_SLACK_BYTES = 4096;

export async function handleCreateArtifact(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  // Refuse an oversized body before buffering it: the exact check on the
  // decoded content comes after, this one only keeps a member from
  // making the Worker read megabytes to say no (review, 2026-09-10).
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > ARTIFACT_MAX_BYTES + BODY_SLACK_BYTES) {
    return error(413, `body is larger than the artifact cap (${ARTIFACT_MAX_BYTES} UTF-8 bytes of content)`);
  }
  const content = await readContent(request);
  if (content === null) return error(400, "expected application/json {content} or a text/plain body");
  const bytes = encoder.encode(content).length;
  if (bytes < 1) return error(400, "content must not be empty");
  if (bytes > ARTIFACT_MAX_BYTES) return error(400, `content must be at most ${ARTIFACT_MAX_BYTES} UTF-8 bytes (got ${bytes})`);

  const sha256 = await sha256Hex(content);
  const existing = await artifactBySha(env, sha256);
  if (existing) {
    // Same bytes, same address. No quota, no event: nothing new exists.
    return json({ artifact: view(existing), existing: true });
  }

  if (!(await hasQuota(env, ctx.member, "artifacts"))) {
    return error(429, "daily artifact quota exhausted (resets 00:00 UTC)");
  }

  const createdAt = nowMs();
  const inserted = await env.DB
    .prepare("INSERT OR IGNORE INTO artifacts (sha256, member_id, bytes, content, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sha256, ctx.member.id, bytes, content, createdAt)
    .run();
  if (!inserted.meta.changes) {
    // Lost a race with an identical blob: same outcome as `existing`.
    const raced = await artifactBySha(env, sha256);
    if (raced) return json({ artifact: view(raced), existing: true });
    return error(500, "artifact could not be stored");
  }

  await consumeQuota(env, ctx.member, "artifacts");
  await appendEvent(env, "artifact", {
    sha256,
    bytes,
    member_id: ctx.member.id,
    handle: ctx.member.handle,
  });
  const row = await artifactBySha(env, sha256);
  return json({ artifact: view(row ?? { sha256, member_id: ctx.member.id, bytes, content, created_at: createdAt }), existing: false }, { status: 201 });
}

function view(row: ArtifactRow): { url: string; sha256: string; bytes: number; created_at: number } {
  return { url: artifactUrl(row.sha256), sha256: row.sha256, bytes: row.bytes, created_at: row.created_at };
}

export async function handleGetArtifact(env: Env, sha256: string): Promise<Response> {
  const row = await artifactBySha(env, sha256);
  if (!row) {
    return new Response("no artifact at this address\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // Content, not markup: served as text whatever it looks like, with
  // sniffing off so a browser never renders it as HTML.
  return new Response(row.content, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${row.sha256}"`,
      "x-content-type-options": "nosniff",
      "x-artifact-sha256": row.sha256,
      "x-artifact-bytes": String(row.bytes),
    },
  });
}
