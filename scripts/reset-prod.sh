#!/usr/bin/env bash
# scripts/reset-prod.sh — one-time production wipe.
#
# WHY THIS EXISTS
#   Phase 1.5 left demo artefacts on the remote D1 (test members from
#   the pre-launch demo runs). Before public launch, the register must
#   restart from GENESIS with only the founding events.
#
# SAFETY GATES (mandatory, non-negotiable)
#   1. Requires you to type "RESET" verbatim (or set RESET_CONFIRM=RESET
#      when running non-interactively — CI/pipes).
#   2. Refuses to run if the database already carries more than 50
#      events (proxy for "we are past pre-launch — do not do this").
#   3. Requires wrangler to be authenticated (CLOUDFLARE_API_TOKEN in
#      env). We verify with `wrangler whoami`, never printing the token.
#
# SIDE EFFECTS
#   Wipes: members, tasks, submissions, events, quotas, rate_limits,
#          and the sqlite_sequence rows for autoincrement counters.
#   Keeps: the guilds table (which carries the seeded 'flightsim' row
#          from migration 0001).
#
# AFTER RUNNING THIS ONCE, DELETE OR ARCHIVE IT. It is not a maintenance
# tool — it is a bootstrap wipe.

set -euo pipefail

DB="${ERGONIA_DB:-ergonia}"
MAX_EVENTS="${RESET_MAX_EVENTS:-50}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="${ROOT}/.reset-prod.sql"
trap 'rm -f "$TMP"' EXIT

need() { command -v "$1" >/dev/null || { echo "missing dep: $1" >&2; exit 2; }; }
need node
need npx

hr() { printf -- "----- %s -----\n" "$1"; }

# d1_count <sql-command>  → prints the single number `n` from `SELECT ... AS n`.
# Buffers wrangler's full stdout+stderr into a bash variable first, then
# feeds only that string to a helper node script — piping wrangler
# directly into node has tripped a Windows libuv assertion in the past,
# and multi-line `node -e` strings get mangled by git-bash's MSYS layer.
d1_count() {
  local sql="$1"
  local raw
  raw=$(RAW_SQL="$sql" bash -c 'npx wrangler d1 execute "$0" --remote --json --command "$RAW_SQL" 2>&1' "$DB") || true
  printf '%s' "$raw" | node "$HERE/lib/d1-json-count.mjs" n
}

hr "0) verifying wrangler auth (token stays in env, never printed)"
if ! WHOAMI=$(npx wrangler whoami 2>&1); then
  echo "wrangler whoami failed" >&2
  exit 3
fi
printf '%s\n' "$WHOAMI" | grep -E "Account (Name|ID)" | head -2 || \
  printf '%s\n' "$WHOAMI" | grep -Ei "logged in|account" | head -2

hr "1) counting current events on remote D1"
EVENTS=$(d1_count "SELECT COUNT(*) AS n FROM events")
echo "events on remote = $EVENTS"
case "$EVENTS" in
  ""|"?")
    echo "could not read event count — refusing to reset." >&2
    exit 4
    ;;
esac
if [ "$EVENTS" -gt "$MAX_EVENTS" ]; then
  echo "REFUSE: remote has $EVENTS events (> $MAX_EVENTS). This script is a" >&2
  echo "  bootstrap wipe, not a maintenance tool. If you really need to reset" >&2
  echo "  a live database, do it by hand with full awareness." >&2
  exit 5
fi

hr "2) explicit confirmation"
echo "About to WIPE members, tasks, submissions, events, quotas, rate_limits"
echo "on D1 database '$DB' (--remote). The seeded guilds row is preserved."
if [ -n "${RESET_CONFIRM:-}" ]; then
  CONFIRM="$RESET_CONFIRM"
  echo "(non-interactive: RESET_CONFIRM=$RESET_CONFIRM)"
else
  printf "Type RESET (uppercase) to proceed: "
  read -r CONFIRM
fi
if [ "$CONFIRM" != "RESET" ]; then
  echo "aborted: expected 'RESET', got '$CONFIRM'" >&2
  exit 6
fi

hr "3) executing wipe (SQL file: $TMP)"
cat > "$TMP" <<'SQL'
DELETE FROM submissions;
DELETE FROM tasks;
DELETE FROM quotas;
DELETE FROM rate_limits;
DELETE FROM events;
DELETE FROM members;
DELETE FROM sqlite_sequence WHERE name IN ('events','submissions','tasks','members');
SQL
npx wrangler d1 execute "$DB" --remote --file "$TMP" 2>&1 | tail -20

hr "4) verifying"
for tbl in members tasks submissions events quotas; do
  n=$(d1_count "SELECT COUNT(*) AS n FROM $tbl")
  printf "  %-13s = %s\n" "$tbl" "$n"
done
n=$(d1_count "SELECT COUNT(*) AS n FROM guilds")
printf "  %-13s = %s  (preserved seed)\n" "guilds" "$n"

hr "reset OK — chain will restart from GENESIS on the next mutation"
