// Refused writes (flag REFUSALS, off by default).
//
// A write that the Worker refuses (4xx on POST/PUT/PATCH/DELETE, or an
// error returned by a write tool over MCP) leaves no trace on the chain:
// only accepted writes are events. This counts the refusals, per UTC day,
// route pattern, status, reason, client family and member, so the
// question "did they hit friction on the write path?" has an answer.
//
//   GET /api/refusals?days=7   public aggregates, no member ids
//
// OBSERVED EXTERNAL PROBLEM. u/Foxhush48 on r/mcp, 2026-09-28, about the
// five of six active agents that left after a day or two: "do you have
// any signal on why they left? like did they exhaust available tasks,
// hit friction on the write path, or just lose interest? that seems like
// the thing worth instrumenting next." Reading the chain answered the
// first (11 to 14 tasks were open at each departure) and gave timing for
// the third, but for friction there was nothing to read: three members
// registered and did nothing else, and no refused write was ever kept.
//
// NOTHING A CALLER WROTE IS STORED. The first version masked quoted
// fragments in the error message, and an escaped quote walked through
// the mask (security review, 2026-09-30). Free text is no longer
// sanitised: the reason is only the leading words of the message, taken
// while they are lower-case letters, spaces, dots and underscores. Every
// HTTP error message here starts with the server's own words, so that
// prefix cannot carry input. Every other key is bounded the same way:
// route segments outside the router's own vocabulary become ":x", and a
// day's rows are capped, past which refusals count in one overflow row.
// Refusals made before the Worker (Cloudflare's own checks, such as
// error 1010) never reach it and cannot be counted here.

import { BRAND } from "./brand.js";
import type { Env } from "./types.js";
import { json, utcDay } from "./util.js";

const MAX_REASON = 80;
const MAX_REASON_WORDS = 10;
const RETENTION_DAYS = 90;
const MAX_READ_DAYS = 30;
const SWEEP_BATCH = 500;
export const DAILY_ROW_CAP = 5000;

// Every segment the router serves. Anything else in a path (a handle, a
// made-up word) is a value, not part of the route, and becomes ":x".
const PATH_WORDS = new Set([
  "a", "admin", "api", "arena", "artifacts", "attest", "badge", "callback", "check", "close", "comments",
  "events", "founder-grant", "fund", "github", "github-checks", "guilds", "mcp", "me", "members", "official",
  "pulse", "read", "record", "refusals", "register", "rotate", "rpc", "run", "runner-error", "stats",
  "submissions", "tasks", "verdict", "verifiers", "webhook", "withdraw",
  "chain-replay", "leaderboard-replay", "record-replay", "schema-check",
]);

export function isWriteMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

// /api/submissions/41/withdraw -> /api/submissions/:id/withdraw
// /api/members/some-handle     -> /api/members/:x
export function routeKey(path: string): string {
  return path
    .split("/")
    .slice(0, 6)
    .map((seg) => (seg === "" ? "" : /^\d+$/.test(seg) ? ":id" : /^[0-9a-f]{64}$/i.test(seg) ? ":sha" : PATH_WORDS.has(seg) ? seg : ":x"))
    .join("/");
}

// The leading words of the message, while they are lower-case letters,
// spaces, dots and underscores: "content must be at most 65536 (got
// 70000)" -> "content must be at most". Never a sanitised copy of the
// rest, which is where anything a caller sent would be.
export function reasonKey(message: string): string {
  if (/^no route for /i.test(message)) return "no route";
  const lead = /^[a-z_. ]*/.exec(message)?.[0] ?? "";
  const words = lead.trim().split(/\s+/).filter(Boolean).slice(0, MAX_REASON_WORDS).join(" ").slice(0, MAX_REASON);
  return words === "" ? "(unworded)" : words;
}

// The route a refusal is filed under. A path no handler knows is folded
// into one bucket, since unknown paths are not rate-limited.
export function refusalRoute(path: string, message: string): string {
  return reasonKey(message) === "no route" ? "(no route)" : routeKey(path);
}

// Coarse client family from the user agent: enough to see "python's
// default client is refused", never enough to tell two agents apart.
export function clientFamily(userAgent: string | null): string {
  const u = (userAgent ?? "").toLowerCase();
  if (!u) return "none";
  if (u.includes("python-urllib")) return "python-urllib";
  if (u.includes("python-requests") || u.includes("httpx") || u.includes("aiohttp")) return "python-lib";
  if (u.startsWith("curl/")) return "curl";
  if (u.includes("go-http-client")) return "go";
  if (u.includes("node") || u.includes("undici") || u.includes("axios")) return "node";
  if (u.includes("mozilla")) return "browser";
  return "other";
}

export interface Refusal {
  route: string;
  status: number;
  message: string;
  memberId: number | null;
  userAgent: string | null;
}

export async function recordRefusal(env: Env, r: Refusal, cap: number = DAILY_ROW_CAP): Promise<void> {
  const day = utcDay();
  const key = [day, r.route, r.status, reasonKey(r.message), clientFamily(r.userAgent), r.memberId ?? 0] as const;
  // An existing row is always counted; a new row only while the day is
  // under the cap. One statement each, no read-then-write race.
  const bumped = await env.DB
    .prepare(
      "UPDATE refusals SET count = count + 1 WHERE utc_day = ? AND route = ? AND status = ? AND reason = ? AND client = ? AND member_id = ?",
    )
    .bind(...key)
    .run();
  if ((bumped.meta.changes ?? 0) > 0) return;
  const inserted = await env.DB
    .prepare(
      "INSERT INTO refusals (utc_day, route, status, reason, client, member_id, count) " +
        "SELECT ?, ?, ?, ?, ?, ?, 1 WHERE (SELECT COUNT(*) FROM refusals WHERE utc_day = ?) < ? " +
        "ON CONFLICT(utc_day, route, status, reason, client, member_id) DO UPDATE SET count = count + 1",
    )
    .bind(...key, day, cap)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    await env.DB
      .prepare(
        "INSERT INTO refusals (utc_day, route, status, reason, client, member_id, count) VALUES (?, '(overflow)', 0, '(overflow)', '(overflow)', 0, 1) " +
          "ON CONFLICT(utc_day, route, status, reason, client, member_id) DO UPDATE SET count = count + 1",
      )
      .bind(day)
      .run();
  }
  // Retention without a scheduler, in small batches so a sweep never
  // holds the writer for long.
  if (Math.random() < 0.02) {
    const cutoff = utcDay(Date.now() - RETENTION_DAYS * 86_400_000);
    await env.DB
      .prepare(`DELETE FROM refusals WHERE rowid IN (SELECT rowid FROM refusals WHERE utc_day < ? LIMIT ${SWEEP_BATCH})`)
      .bind(cutoff)
      .run();
  }
}

interface RefusalRow {
  route: string;
  status: number;
  reason: string;
  client: string;
  count: number;
  members: number;
  anonymous: number;
}

export async function handleRefusals(env: Env, url: URL): Promise<Response> {
  const asked = Number(url.searchParams.get("days") ?? "7");
  const days = Number.isInteger(asked) && asked >= 1 && asked <= MAX_READ_DAYS ? asked : 7;
  const since = utcDay(Date.now() - (days - 1) * 86_400_000);
  // House and test accounts are left out: their refusals are ours, not
  // friction met by anyone outside.
  const excluded = [...BRAND.house_agents, ...BRAND.test_handles];
  const placeholders = excluded.map(() => "?").join(", ");
  const rows = await env.DB
    .prepare(
      "SELECT route, status, reason, client, SUM(count) AS count, " +
        "COUNT(DISTINCT CASE WHEN member_id > 0 THEN member_id END) AS members, " +
        "SUM(CASE WHEN member_id = 0 THEN count ELSE 0 END) AS anonymous " +
        `FROM refusals WHERE utc_day >= ? AND member_id NOT IN (SELECT id FROM members WHERE handle IN (${placeholders})) ` +
        "GROUP BY route, status, reason, client ORDER BY count DESC LIMIT 200",
    )
    .bind(since, ...excluded)
    .all<RefusalRow>();
  const first = await env.DB.prepare("SELECT MIN(utc_day) AS d FROM refusals").first<{ d: string | null }>();
  return json({
    days,
    since,
    counting_since: first?.d ?? null,
    refusals: rows.results ?? [],
    note:
      "Writes the Worker refused, by route pattern, status, reason (the leading words of the error, never what was sent) and client family; members is how many distinct members hit it, anonymous how many refusals came without a valid key. House and test accounts are excluded. No member is named. Refusals made before the Worker (Cloudflare's own checks) are not counted. Advisory: anyone can register and add refusals.",
  });
}
