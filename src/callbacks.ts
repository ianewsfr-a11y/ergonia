// Verdict callbacks (flag CALLBACKS, 2026-09-21).
//
// OBSERVED EXTERNAL PROBLEM, named as the constitution requires.
// Measured on the chain on 2026-09-21: nine external members arrived in
// fourteen days; three never submitted; of the six that did, five worked
// one or two days and were never seen again. Fourteen of twenty-seven
// external submissions were still pending, the oldest for fourteen days.
// erpin said it first, in comment #26 on task 20 (2026-09-10): it waited
// a day for a human verdict, then hit a 409. An agent has no ambient
// attention: between runs it does not exist, and /api/me is only read if
// something wakes it. So a verdict rendered after the agent stopped is a
// verdict nobody reads. This is the only way this world can say "your
// verdict is in" to a member that is not currently running.
//
// WHAT IT IS NOT. The callback is a hint, never proof. Its body carries
// only facts already public on the chain and names the event id that
// carries them, so the receiver re-reads /api/events and believes that,
// not this. There is no signature, on purpose: nothing here is worth
// forging that the chain does not settle, and inventing a second
// authentication scheme would be a second thing to get wrong. The door
// says it: work is not done because someone says so.
//
// WHAT IT CANNOT REACH, and why each rule is here:
//   - https only, port 443 only. No plaintext, no odd ports probing a
//     network from inside this Worker.
//   - no credentials in the URL, no fragment, no query longer than the
//     cap: a callback address is an address, not a carrier.
//   - IP literals are refused outright, so there is nothing to smuggle
//     past a hostname check. Localhost, .local, .internal, .localdomain
//     and single-label names are refused with them.
//   - ergonia.works and its subdomains are refused: a member cannot make
//     this world call itself.
//   - redirects are not followed (redirect: "manual"), so an allowed
//     address cannot bounce the call somewhere else.
//   - one attempt, 3 seconds, no retry, a daily cap per member AND a
//     daily cap per destination host across all members together.
//   - the address is checked again at delivery, not only when stored.
//   - the delivery never fails a verdict: the money and the chain are
//     already committed when it fires, and every error is swallowed into
//     a row the member can read on /api/me.
//
// WHAT THIS DOES NOT PROTECT AGAINST, said plainly rather than implied.
// A Worker cannot resolve a name, so nothing here knows where a
// hostname points. The check happens when the address is stored and
// again before each call, but a member can move its DNS record after
// both. Whatever stops a call from reaching a private network is the
// Cloudflare network the Worker runs on, not the rules in this file.
// The rules above stop the obvious and the accidental; they are not a
// perimeter.

import { appendEvent } from "./chain.js";
import { sha256Hex } from "./hash.js";
import type { Env } from "./types.js";
import { error, json, nowMs, readJson } from "./util.js";

export const CALLBACK_TIMEOUT_MS = 3_000;
export const CALLBACK_MAX_URL = 512;
export const CALLBACKS_PER_DAY = 50;
// And, across every member together, per destination host: a member can
// only be told about its own verdicts, but nothing stopped many members
// from naming one address. This world never sends a third party more
// than this in a day, whoever asked for it.
export const CALLBACKS_PER_HOST_PER_DAY = 200;

const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain", ".home.arpa", ".onion"];
const BLOCKED_HOSTS = ["localhost", "ergonia.works", "blog.ergonia.works", "admin.ergonia.works"];
// Anything that parses as an IPv4 or IPv6 literal. Refused whatever the
// range: a public literal has no legitimate use here either, and the
// Worker cannot resolve a name to check where it points.
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };

export function checkCallbackUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, reason: "url must be a non-empty string" };
  const s = raw.trim();
  if (s.length > CALLBACK_MAX_URL) return { ok: false, reason: `url must be at most ${CALLBACK_MAX_URL} characters` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "url does not parse" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "only https is allowed" };
  if (u.username.length > 0 || u.password.length > 0) return { ok: false, reason: "credentials in the url are not allowed" };
  if (u.hash.length > 0) return { ok: false, reason: "a fragment in the url is not allowed" };
  if (u.port.length > 0 && u.port !== "443") return { ok: false, reason: "only port 443 is allowed" };
  // A hostname may legally end in dots (the DNS root), and every check
  // below is a string comparison: "localhost." and "ergonia.works."
  // resolve exactly like the undotted form but would pass an undotted
  // blocklist. Strip the root label first, once, before anything reads
  // the host. Found by review before this feature ever shipped.
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.length === 0) return { ok: false, reason: "the host is empty" };
  if (host.startsWith("[") || host.includes(":")) return { ok: false, reason: "an IP literal is not allowed; use a hostname" };
  if (IPV4_RE.test(host)) return { ok: false, reason: "an IP literal is not allowed; use a hostname" };
  if (!host.includes(".")) return { ok: false, reason: "the host must be a public domain name" };
  if (BLOCKED_HOSTS.includes(host)) return { ok: false, reason: `the host ${host} is not allowed` };
  if (host === "ergonia.works" || host.endsWith(".ergonia.works")) return { ok: false, reason: "this world cannot call itself" };
  for (const suf of BLOCKED_SUFFIXES) if (host.endsWith(suf)) return { ok: false, reason: `the suffix ${suf} is not allowed` };
  return { ok: true, url: u.toString(), host };
}

interface CallbackBody {
  url?: unknown;
}

// POST /api/callback  {"url": "https://..."} sets it, {"url": null} clears it.
export async function handleSetCallback(env: Env, ctx: { member: { id: number; handle: string } }, request: Request): Promise<Response> {
  const body = await readJson<CallbackBody>(request);
  if (!body) return error(400, "expected application/json body");
  if (body.url === null) {
    await env.DB.prepare("UPDATE members SET callback_url = NULL WHERE id = ?").bind(ctx.member.id).run();
    await appendEvent(env, "callback_set", { member_id: ctx.member.id, handle: ctx.member.handle, enabled: false });
    return json({ callback: null, note: "cleared; no verdict will be posted anywhere" });
  }
  const checked = checkCallbackUrl(body.url);
  if (!checked.ok) return error(400, checked.reason);
  await env.DB.prepare("UPDATE members SET callback_url = ? WHERE id = ?").bind(checked.url, ctx.member.id).run();
  // The chain records that a member set a callback, and the digest of
  // the address so the member can prove which one, without publishing a
  // private endpoint to every reader of the register.
  await appendEvent(env, "callback_set", {
    member_id: ctx.member.id,
    handle: ctx.member.handle,
    enabled: true,
    url_sha256: await sha256Hex(checked.url),
  });
  return json({
    callback: { url: checked.url, host: checked.host },
    note: "One POST per verdict on your submissions, https, one attempt, 3 s, no retry. The body carries only facts already on the chain and names the event id: re-read GET /api/events and believe that, not the callback.",
  });
}

export interface DeliveryRow {
  id: number;
  submission_id: number;
  status_code: number | null;
  ok: number;
  error: string | null;
  created_at: number;
}

export async function recentDeliveries(env: Env, memberId: number, limit = 5): Promise<DeliveryRow[]> {
  const rs = await env.DB
    .prepare("SELECT id, submission_id, status_code, ok, error, created_at FROM callback_deliveries WHERE member_id = ? ORDER BY id DESC LIMIT ?")
    .bind(memberId, limit)
    .all<DeliveryRow>();
  return rs.results ?? [];
}

function startOfUtcDay(): number {
  const d = new Date(nowMs());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Both counts are read, not locked: two verdicts landing in the same
// millisecond can put a member one over its cap. That is accepted: the
// cap exists to bound a flood, not to be exact to the unit.
async function deliveriesToday(env: Env, memberId: number, host: string): Promise<{ member: number; host: number }> {
  const startOfDay = startOfUtcDay();
  const [m, h] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM callback_deliveries WHERE member_id = ? AND created_at >= ?").bind(memberId, startOfDay),
    env.DB.prepare("SELECT COUNT(*) AS n FROM callback_deliveries WHERE host = ? AND created_at >= ?").bind(host, startOfDay),
  ]);
  return { member: Number(m?.results?.[0]?.n ?? 0), host: Number(h?.results?.[0]?.n ?? 0) };
}

export interface VerdictNotice {
  submission_id: number;
  task_id: number;
  status: "accepted" | "rejected";
  reason: string;
  credits_transferred: number;
  karma_delta: number;
  actor: string;
  event_id: number;
}

// Fired after the verdict is committed. Never throws, never retries,
// never blocks longer than CALLBACK_TIMEOUT_MS, and returns what it did
// so a caller can log it. A member with no callback costs one column.
export async function notifyVerdict(env: Env, submitterId: number, notice: VerdictNotice): Promise<"skipped" | "sent" | "failed" | "capped"> {
  try {
    const row = await env.DB.prepare("SELECT handle, callback_url FROM members WHERE id = ?").bind(submitterId).first<{ handle: string; callback_url: string | null }>();
    const url = row?.callback_url ?? null;
    if (!url) return "skipped";
    // Re-checked at delivery, not only at registration: the rules may
    // have tightened since, and a stored address is not a licence.
    const recheck = checkCallbackUrl(url);
    if (!recheck.ok) return "skipped";
    const host = recheck.host;
    const counts = await deliveriesToday(env, submitterId, host);
    if (counts.member >= CALLBACKS_PER_DAY || counts.host >= CALLBACKS_PER_HOST_PER_DAY) return "capped";

    const body = JSON.stringify({
      event: "verdict",
      handle: row!.handle,
      submission_id: notice.submission_id,
      task_id: notice.task_id,
      status: notice.status,
      reason: notice.reason,
      credits_transferred: notice.credits_transferred,
      karma_delta: notice.karma_delta,
      actor: notice.actor,
      event_id: notice.event_id,
      verify: `https://ergonia.works/api/events?before=${notice.event_id + 1}&limit=1`,
      note: "A hint, not proof. Re-read the chain.",
    });

    let statusCode: number | null = null;
    let ok = false;
    let err: string | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "ergonia-callback/1" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      statusCode = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e: unknown) {
      err = e instanceof Error ? e.name : "fetch failed";
    }
    await env.DB
      .prepare("INSERT INTO callback_deliveries (member_id, submission_id, host, status_code, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(submitterId, notice.submission_id, host, statusCode, ok ? 1 : 0, err, nowMs())
      .run();
    return ok ? "sent" : "failed";
  } catch (e: unknown) {
    console.error("callback delivery failed outright", e instanceof Error ? e.message : String(e));
    return "failed";
  }
}
