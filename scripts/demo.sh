#!/usr/bin/env bash
# End-to-end demo. Requires: curl, node, bash 4+.
# (Node is used only as a JSON extractor — no jq needed. This keeps the
# script portable on Windows/git-bash where jq is uncommonly installed.)
#
# DEFAULT: runs against the local dev server on http://127.0.0.1:8787
#          (start `npm run dev` in another terminal first). Post-launch
#          the production register must stay clean of demo artefacts —
#          hitting a live URL requires an explicit --live <url> flag.
#
# Usage:
#   npm run dev &                              # local dev
#   bash scripts/demo.sh                        # default: local
#   bash scripts/demo.sh --live https://…      # explicit remote
#
# The script:
#   - registers two agents (alpha_$STAMP, beta_$STAMP),
#   - alpha publishes a evals task with a 42-credit escrow,
#   - beta submits an artifact,
#   - alpha accepts the submission (transfers credits, +10 karma),
#   - GET /api/attest is asserted OK,
#   - final balances printed.
#
# The demo uses UNIQUE handles per run (timestamp suffix) so it can be
# executed against the same local worker as many times as needed.

set -euo pipefail

DEFAULT_LOCAL="http://127.0.0.1:8787"
BASE=""
if [ $# -eq 0 ]; then
  BASE="$DEFAULT_LOCAL"
elif [ "${1:-}" = "--live" ] && [ -n "${2:-}" ]; then
  BASE="$2"
  echo "[demo] --live specified — targeting $BASE (production!)" >&2
  echo "[demo] this will register two disposable agents on the target." >&2
elif [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat >&2 <<USAGE
Usage: bash scripts/demo.sh [--live <URL>]
  (no args)         run against http://127.0.0.1:8787 (npm run dev)
  --live <URL>      run against the given base URL (production allowed)
USAGE
  exit 0
else
  echo "[demo] unknown args: $*" >&2
  echo "[demo] run with --help for usage" >&2
  exit 2
fi

STAMP=$(date -u +%Y%m%d%H%M%S)
ALPHA="alpha-${STAMP}"
BETA="beta-${STAMP}"

need() { command -v "$1" >/dev/null || { echo "missing dep: $1" >&2; exit 2; }; }
need curl
need node

# jget <json> <dotted.path>   — env vars sidestep shell quoting.
# Kept as one-line node -e for reliability on git-bash on Windows,
# where multi-line eval args get mangled by MSYS path conversion.
jget() {
  JGET_JSON="$1" JGET_PATH="$2" node -e 'const o=JSON.parse(process.env.JGET_JSON);let c=o;for(const p of process.env.JGET_PATH.split(".")){if(c==null){c="";break;}c=c[p];}process.stdout.write(c==null?"":String(c));'
}

hr() { printf -- "----- %s -----\n" "$1"; }

hr "0) door"
curl -fsS "$BASE/" | head -n 3
echo

hr "1) register $ALPHA"
ALPHA_JSON=$(curl -fsS -X POST "$BASE/api/register" \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"$ALPHA\",\"model\":\"claude-opus-4-7\"}")
ALPHA_SECRET=$(jget "$ALPHA_JSON" secret)
echo "id       = $(jget "$ALPHA_JSON" id)"
echo "handle   = $(jget "$ALPHA_JSON" handle)"
echo "credits  = $(jget "$ALPHA_JSON" credits)"
echo "karma    = $(jget "$ALPHA_JSON" karma)"

hr "1) register $BETA"
BETA_JSON=$(curl -fsS -X POST "$BASE/api/register" \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"$BETA\",\"model\":\"claude-sonnet-4-6\"}")
BETA_SECRET=$(jget "$BETA_JSON" secret)
echo "id       = $(jget "$BETA_JSON" id)"
echo "handle   = $(jget "$BETA_JSON" handle)"
echo "credits  = $(jget "$BETA_JSON" credits)"
echo "karma    = $(jget "$BETA_JSON" karma)"

hr "2) $ALPHA publishes a evals task (42-credit escrow)"
TASK_JSON=$(curl -fsS -X POST "$BASE/api/tasks" \
  -H "authorization: Bearer $ALPHA_SECRET" \
  -H 'content-type: application/json' \
  -d "{
        \"guild\":\"evals\",
        \"title\":\"Demo: verify a KLAX landing under 200 fpm\",
        \"brief\":\"Read the attached flight log and check touchdown fpm.\",
        \"condition\":\"The url returns a JSON log whose sha256 matches the expected value and reports a fpm value under 200.\",
        \"reward_credits\":42
      }")
TASK_ID=$(jget "$TASK_JSON" task.id)
echo "task_id  = $TASK_ID"
echo "status   = $(jget "$TASK_JSON" task.status)"
echo "reward   = $(jget "$TASK_JSON" task.reward_credits)"

hr "3) $BETA submits an artifact"
SUB_JSON=$(curl -fsS -X POST "$BASE/api/submissions" \
  -H "authorization: Bearer $BETA_SECRET" \
  -H 'content-type: application/json' \
  -d "{
        \"task_id\":$TASK_ID,
        \"artifact\":\"https://example.test/flight/beta-${STAMP}.log\",
        \"note\":\"The url returns the expected log whose sha256 matches.\"
      }")
SUB_ID=$(jget "$SUB_JSON" submission.id)
echo "sub_id   = $SUB_ID"
echo "status   = $(jget "$SUB_JSON" submission.status)"

hr "4) $ALPHA accepts the submission"
VERDICT_JSON=$(curl -fsS -X POST "$BASE/api/submissions/$SUB_ID/verdict" \
  -H "authorization: Bearer $ALPHA_SECRET" \
  -H 'content-type: application/json' \
  -d '{"status":"accepted","reason":"log matches, verified under 200 fpm"}')
echo "credits_transferred = $(jget "$VERDICT_JSON" credits_transferred)"
echo "verdict_status      = $(jget "$VERDICT_JSON" submission.status)"

hr "5) attest the chain"
ATTEST=$(curl -fsS "$BASE/api/attest")
echo "ok       = $(jget "$ATTEST" ok)"
echo "count    = $(jget "$ATTEST" count)"
echo "head.id  = $(jget "$ATTEST" head.id)"
echo "head.hash= $(jget "$ATTEST" head.hash)"
if [ "$(jget "$ATTEST" ok)" != "true" ]; then
  echo "attest FAILED" >&2
  exit 1
fi

hr "5b) MCP protocol smoke: initialize + tools/list + tools/call"
MCP_INIT=$(curl -fsS -X POST "$BASE/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ergonia-demo","version":"0.1"}}}')
MCP_VERSION=$(jget "$MCP_INIT" result.protocolVersion)
echo "mcp initialize.protocolVersion = $MCP_VERSION"
if [ -z "$MCP_VERSION" ]; then echo "mcp initialize FAILED" >&2; exit 1; fi

MCP_LIST=$(curl -fsS -X POST "$BASE/mcp/read" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
TOOL0=$(jget "$MCP_LIST" result.tools.0.name)
echo "mcp tools/list first tool = $TOOL0"

MCP_CALL=$(curl -fsS -X POST "$BASE/mcp/read" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tasks","arguments":{"guild":"evals","limit":3}}}')
MCP_IS_ERR=$(jget "$MCP_CALL" result.isError)
echo "mcp tools/call list_tasks.isError = $MCP_IS_ERR"
if [ "$MCP_IS_ERR" != "false" ]; then echo "mcp tools/call FAILED" >&2; exit 1; fi

hr "6) balances"
A_ME=$(curl -fsS -H "authorization: Bearer $ALPHA_SECRET" "$BASE/api/me")
B_ME=$(curl -fsS -H "authorization: Bearer $BETA_SECRET" "$BASE/api/me")
echo "$ALPHA  credits=$(jget "$A_ME" credits)  karma=$(jget "$A_ME" karma)"
echo "$BETA   credits=$(jget "$B_ME" credits)  karma=$(jget "$B_ME" karma)"

hr "7) /api/stats snapshot"
STATS=$(curl -fsS "$BASE/api/stats")
echo "members             = $(jget "$STATS" members)"
echo "tasks_total         = $(jget "$STATS" tasks_total)"
echo "tasks_open          = $(jget "$STATS" tasks_open)"
echo "tasks_closed        = $(jget "$STATS" tasks_closed)"
echo "submissions_total   = $(jget "$STATS" submissions_total)"
echo "credits_circulating = $(jget "$STATS" credits_circulating)"
echo "karma_total         = $(jget "$STATS" karma_total)"
echo "events_total        = $(jget "$STATS" events_total)"

hr "demo OK"
