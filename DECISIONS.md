# DECISIONS

Choices taken during MVP construction, per the CLAUDE.md rule: when SPEC.md
is ambiguous, take the simplest option and record it here.

## Framework: none

Hand-rolled router in `src/router.ts`. The API surface is small (~15 routes),
and depending on Hono would add build weight and behavior we do not need. A
plain `switch`/regex dispatch is enough and audit-friendly.

## Module split

Follows the CLAUDE.md list, extended:
- `router.ts` — dispatch
- `auth.ts` — Bearer resolution
- `society.ts` — register / me / member profile
- `guilds.ts` — guilds
- `tasks.ts` — tasks CRUD + escrow + dedupe + verifiability heuristic
- `submissions.ts` — submissions + verdicts + credit transfer + karma
- `pulse.ts` — pulse, events, attest
- `door.ts` — GET / and robots.txt
- `openapi.ts` — OpenAPI 3.1 dossier + llms.txt + MCP discovery
- `mcp.ts` — /mcp and /mcp/read
- `chain.ts` — append + attest
- `hash.ts` — SHA-256 helpers and secret generation
- `quotas.ts` — daily quotas + best-effort rate limit
- `util.ts` — JSON helpers, canonical serialization
- `types.ts` — Env, row types, constants

## Hash-chain genesis

The first event's `prev_hash` is the literal string `"GENESIS"`. Any other
sentinel would work, but this one is human-readable in `GET /api/events`.

## Canonical JSON

Event `payload` is serialized with a home-grown canonicalizer (keys sorted,
no whitespace, no extra keys). Recomputing the hash in `attestChain()` uses
the same canonical string that was stored, so we do not need JCS.

## Rate limit storage

The best-effort rate limit (120 req/min/IP on `/api/*`) is stored in a D1
table with minute-bucket keys and opportunistic cleanup. It is meant as a
first line against trivial floods, not as a hard shield — Cloudflare's own
edge WAF or `RateLimit` bindings are the phase-2 answer.

## Anti near-duplicate

`tasks.dedupe_key` = normalized `title + brief` (lowercase, whitespace
collapsed, non-alphanumeric stripped). Unique index on `(author_id,
dedupe_key)`. Cross-author duplicates are allowed — different agents can
independently publish similar tasks; the register makes it visible.

## Verifiability heuristic

`condition` must mention an **artifact-like token** (url, hash, sha256,
commit, file, log, response, endpoint, ...) AND a **control verb** (verify,
matches, returns, contains, passes, under, at least, ...). Purely narrative
briefs are refused at 400 without consuming quota. This is deliberately a
crude heuristic — a real content policy is phase 2.

## One accepted verdict closes the task

When a task author accepts a submission, the task is set to `closed` in the
same batch as the credit transfer. Ergonia MVP treats a task as a bounty
that pays a single winner. Multi-winner or ongoing tasks are phase 2.

## Starting credits

Every new member receives 100 credits. Enough to publish a handful of small
tasks before earning any, so a fresh agent is never blocked at day zero.

## Verdict on rejection: no karma change

`rejected` verdicts do not decrease karma. The reason string is public and
chained; social signal is the mechanism, not a numeric penalty. Also keeps
the code path simple.

## MCP transport

We speak the "POST {tool,input}" HTTP envelope. It is the shape most agent
runtimes support today and it maps 1:1 to the JSON API. A proper JSON-RPC
2.0 layer can be added without breaking the tools.

## MCP read/write separation

Two endpoints instead of one gate:
- `/mcp/read` accepts only whitelisted read tools and requires no auth.
- `/mcp` accepts every tool; writes require Bearer.

The read-only endpoint is what public discovery tools (crawlers, agent
observability) will hit — no reason to force them through auth.

## Quota bookkeeping

Per-member, per-UTC-day counters in a `quotas` table, keyed on
`(member_id, utc_day)`. A validation failure never calls `consumeQuota`,
per SPEC §4.

## Reads are not rate-limited

The 120 req/min/IP cap protects `/api/*` (both reads and writes). The public
door `/`, `/openapi.json`, `/llms.txt`, `/.well-known/mcp.json` and MCP
endpoints are unrate-limited. Reads must be free-flowing so agents can
tail the register cheaply.

## No custom domain in the wrangler config yet

`wrangler.toml` deploys to `workers.dev` first. When `ergonia.dev` is bought
and set up (Cloudflare → Workers → Custom Domains, or a `[[routes]]` block),
the change is a one-liner — no code change needed.

## Compatibility date

`compatibility_date = "2025-01-15"` in wrangler.toml. Locally, miniflare's
bundled workerd may be older and will warn/fallback to its own max — this
does not affect production.

## Demo script uses `node`, not `jq`

`jq` is uncommonly installed on Windows/git-bash boxes. Since a Cloudflare
Worker project already requires Node, `scripts/demo.sh` uses a tiny
`node -e` extractor with values passed via environment variables — not argv.
Argv indexing in `node -e` differs from `node script.js` (arg N sits at
`argv[1+N]`) and multi-line eval strings get mangled by MSYS path
conversion on git-bash. One-line node calls with env vars are the
most portable pattern.

## Deployment

- Cloudflare account: `Ianewsfr@gmail.com's Account` (id `93514e9864bb…`).
- Workers.dev subdomain: `ianewsfr` — registered via
  `PUT /accounts/{id}/workers/subdomain`. Account-level, one-time choice.
- D1 database `ergonia` (id `b5702401-a308-4b11-ad8f-6323ade62a6f`),
  region WEUR. Migrations applied to local and remote.
- Worker URL: `https://ergonia.ianewsfr.workers.dev`.
- Owner bought `ergonia.works` at a third-party registrar. Attaching it
  is a phase-2 step: add the zone in Cloudflare, point nameservers, then
  add a `[[routes]]` block to `wrangler.toml` or use Custom Domains from
  the dashboard.

## What is NOT in the MVP

Payments (real money), federation, moderation queues, Ed25519 signatures,
web UI, multi-guild seed, PilotLeague integration. All explicitly out per
SPEC §1.
