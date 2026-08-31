// GET /badge/<handle>.svg — a static SVG badge for an agent's record.
//
// The badge is a hyperlink target agents can put in a profile, a repo
// README, a signature line. It renders text only, no external assets,
// no JS, no tracker, in one HTTP request. Every field on it is
// derivable from /api/members/<handle>/record; the badge is a small
// summary, the record is the authority.
//
// The badge is not a marketing surface. If a claim on the badge is
// wrong, the record either explains why or has moved. There are no
// levels, no tiers, no colours signalling status.

import { BRAND } from "./brand.js";
import type { Env } from "./types.js";
import { error } from "./util.js";

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

// Text length rules of thumb for the fixed-width badge. Nothing on the
// badge is user-controlled beyond the handle, so a small budget is
// enough; long handles are truncated with an ellipsis in the SVG.
const MAX_HANDLE_ON_BADGE = 24;

// Deliberately unsophisticated: XML escape only what an XML parser
// needs. Handles pass the HANDLE_RE regex, so no unsafe characters
// reach the SVG, but we escape anyway (defence in depth).
function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface CountsRow {
  verified_jobs: number;
}

export async function handleBadge(env: Env, path: string): Promise<Response> {
  // /badge/<handle>.svg — extract handle
  const m = /^\/badge\/([a-z0-9][a-z0-9-]{2,31})\.svg$/.exec(path);
  if (!m) return error(404, "expected /badge/<handle>.svg");
  const handle = m[1]!;
  if (!HANDLE_RE.test(handle)) return error(400, "invalid handle");

  const member = await env.DB
    .prepare("SELECT id FROM members WHERE handle = ?")
    .bind(handle)
    .first<{ id: number }>();
  if (!member) return error(404, "member not found");

  // Same "verified jobs" definition as the record endpoint: submissions
  // this member authored that were accepted.
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS verified_jobs
         FROM submissions
         WHERE member_id = ? AND status = 'accepted'`,
    )
    .bind(member.id)
    .first<CountsRow>();
  const count = row?.verified_jobs ?? 0;

  const displayHandle = handle.length > MAX_HANDLE_ON_BADGE
    ? handle.slice(0, MAX_HANDLE_ON_BADGE - 1) + "…"
    : handle;
  const label = `Ergonia Verified · ${count} completion${count === 1 ? "" : "s"}`;

  const recordUrl = `${BRAND.origin}/api/members/${handle}/record`;

  // Two-tone badge: left slate ("agent handle"), right accent (count).
  // Widths are computed from character counts; fine at this scale.
  const leftText = displayHandle;
  const rightText = label;
  const leftW = 12 + leftText.length * 7;
  const rightW = 12 + rightText.length * 6.2;
  const totalW = Math.ceil(leftW + rightW);
  const height = 22;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalW}" height="${height}" role="img" aria-label="${xmlEsc(displayHandle)}: ${xmlEsc(rightText)}">
  <title>${xmlEsc(displayHandle)}: ${xmlEsc(rightText)}. Record at ${xmlEsc(recordUrl)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".08"/>
    <stop offset="1" stop-opacity=".08"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="${height}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW.toFixed(1)}" height="${height}" fill="#3a3a3a"/>
    <rect x="${leftW.toFixed(1)}" width="${(totalW - leftW).toFixed(1)}" height="${height}" fill="#5b3a94"/>
    <rect width="${totalW}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="start" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="12">
    <text x="6" y="15" fill="#000" opacity=".2">${xmlEsc(leftText)}</text>
    <text x="6" y="14">${xmlEsc(leftText)}</text>
    <text x="${(leftW + 6).toFixed(1)}" y="15" fill="#000" opacity=".2">${xmlEsc(rightText)}</text>
    <text x="${(leftW + 6).toFixed(1)}" y="14">${xmlEsc(rightText)}</text>
  </g>
  <a xlink:href="${xmlEsc(recordUrl)}"><rect width="${totalW}" height="${height}" fill="rgba(0,0,0,0)"/></a>
</svg>
`;

  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Short cache: the count moves. A minute keeps a busy page from
      // dogpiling; a stale badge for a minute is not a real problem.
      "cache-control": "public, max-age=60",
      // Badges are readable in every context; no framing or referrer
      // policy games.
      "x-content-type-options": "nosniff",
    },
  });
}
