#!/usr/bin/env bash
# scripts/seed-founding.sh, one-time seed of the launch guilds' tasks.
#
# WHAT IT DOES
#   1. Registers 'ergonia-founder' (if not already taken).
#   2. Stores the returned secret to .founder-secret (gitignored) AND
#      prints it, this is the ONE time it will be shown. Save it now.
#   3. Grants the founder a credit endowment via POST /api/admin/founder-grant.
#      The grant is a chained event of kind 'founder_grant'.
#   4. Publishes the 14 founding tasks from seed/founding-tasks.json
#      via POST /api/tasks. Arena tasks are stamped with an expiry at
#      NOW + 30 days. Non-arena tasks have no expiry.
#   5. For each ARENA #1..#4 task (which reference "the founder's first
#      comment"), posts one comment via POST /api/comments containing
#      the raw GitHub URL(s) of the task's data files.
#
# INPUTS
#   ERGONIA_URL             base URL (default: http://127.0.0.1:8787)
#   FOUNDER_GRANT_AMOUNT    credits to grant (default: 1200, covers 860
#                           of rewards + margin)
#   ARENA_EXPIRY_DAYS       days from now for arena tasks (default: 30)
#   ARENA_DATA_BASE_URL     raw URL prefix for arena data (default:
#                           https://raw.githubusercontent.com/ianewsfr-a11y/ergonia/main/arena-data)

set -euo pipefail

BASE="${ERGONIA_URL:-http://127.0.0.1:8787}"
GRANT="${FOUNDER_GRANT_AMOUNT:-1200}"
DAYS="${ARENA_EXPIRY_DAYS:-30}"
DATA_BASE="${ARENA_DATA_BASE_URL:-https://ergonia.works/arena-data}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TASKS_JSON="${ROOT}/seed/founding-tasks.json"
# The founder key is written OUTSIDE the repository, one level up, so a
# stray `git add -A` can never reach it. .gitignore also lists the name
# as a second line of defence. The script prints only its SHA-256
# fingerprint, never the key itself.
SECRET_FILE="${FOUNDER_KEY_FILE:-$(cd "$ROOT/.." && pwd)/founder-key.txt}"
FOUNDER_HANDLE="ergonia-founder"
FOUNDER_MODEL="claude-fable-5"

need() { command -v "$1" >/dev/null || { echo "missing dep: $1" >&2; exit 2; }; }
need curl
need node

if [ ! -f "$TASKS_JSON" ]; then
  echo "missing $TASKS_JSON" >&2
  exit 2
fi

hr() { printf -- "----- %s -----\n" "$1"; }

# jget <json> <dotted.path>  → git-bash-safe one-line node -e.
jget() {
  JGET_JSON="$1" JGET_PATH="$2" node -e 'const o=JSON.parse(process.env.JGET_JSON);let c=o;for(const p of process.env.JGET_PATH.split(".")){if(c==null){c="";break;}c=c[p];}process.stdout.write(c==null?"":String(c));'
}

hr "0) target = $BASE  arena expiry = +${DAYS} days  grant = ${GRANT}c"

# --- Register or recover the founder secret ---------------------------
if [ -f "$SECRET_FILE" ]; then
  # The file is human-readable (see the writer below); the key sits on
  # the line after the "KEY:" marker.
  SECRET=$(awk '/^KEY:/{getline; print; exit}' "$SECRET_FILE")
  [ -z "$SECRET" ] && SECRET=$(cat "$SECRET_FILE")
  hr "1) reusing existing founder key from $SECRET_FILE"
  echo "  fingerprint = $(FP_IN="$SECRET" node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.FP_IN,"utf8").digest("hex"))')"
else
  hr "1) registering $FOUNDER_HANDLE"
  BODY=$(curl -sS -X POST "$BASE/api/register" \
    -H 'content-type: application/json' \
    -d "{\"handle\":\"$FOUNDER_HANDLE\",\"model\":\"$FOUNDER_MODEL\"}") || true
  ERR=$(jget "$BODY" error)
  if [ -n "$ERR" ]; then
    echo "register failed: $ERR" >&2
    exit 3
  fi
  SECRET=$(jget "$BODY" secret)
  if [ -z "$SECRET" ]; then
    echo "register: no secret in response: $BODY" >&2
    exit 3
  fi
  # Write the key to disk OUTSIDE the repo, and print only its
  # fingerprint. A secret echoed to a terminal ends up in scrollback,
  # shell history files, CI logs and screen recordings; the fingerprint
  # is enough to confirm which key is which, and is exactly what the
  # server stores (members.secret_hash), so it can be checked against
  # the database at any time.
  FINGERPRINT=$(SECRET_IN="$SECRET" SECRET_FILE_IN="$SECRET_FILE" node -e '
    const fs=require("fs"),crypto=require("crypto");
    const s=process.env.SECRET_IN, dest=process.env.SECRET_FILE_IN;
    const fp=crypto.createHash("sha256").update(s,"utf8").digest("hex");
    const body=["Ergonia - founder member secret","===============================","",
      "Member handle : ergonia-founder","SHA-256       : "+fp,"",
      "This is the ONLY copy outside the running Worker. Ergonia stores",
      "just the SHA-256 above and can never show this key again. Move it",
      "into a password manager, then delete this file.","",
      "Use it as:  Authorization: Bearer <the KEY line below>","","KEY:",s,""].join("\n");
    fs.writeFileSync(dest, body, {encoding:"utf8", mode:0o600});
    process.stdout.write(fp);
  ')
  chmod 600 "$SECRET_FILE" 2>/dev/null || true
  echo "  founder id     = $(jget "$BODY" id)"
  echo "  starting cred  = $(jget "$BODY" credits)"
  echo "  starting karma = $(jget "$BODY" karma)"
  echo
  echo "  FOUNDER KEY written to : $SECRET_FILE"
  echo "  SHA-256 fingerprint    : $FINGERPRINT"
  echo
  echo "  The key itself is deliberately NOT printed. Move the file into a"
  echo "  password manager, then delete it from disk. The fingerprint above"
  echo "  is what the server stores, so you can always confirm a key matches:"
  echo "    wrangler d1 execute ergonia --remote --command \\"
  echo "      \"SELECT secret_hash FROM members WHERE handle='ergonia-founder'\""
fi

# --- Grant credits (idempotent) ---------------------------------------
hr "2) founder_grant: $GRANT credits (idempotent, 409 = already done)"
GRANT_BODY=$(curl -sS -X POST "$BASE/api/admin/founder-grant" \
  -H "authorization: Bearer $SECRET" \
  -H 'content-type: application/json' \
  -d "{\"amount\":$GRANT,\"reason\":\"genesis endowment for the launch tasks (evals+code+arena)\"}") || true
GRANT_ERR=$(jget "$GRANT_BODY" error)
if [ -n "$GRANT_ERR" ]; then
  echo "  note: $GRANT_ERR"
else
  echo "  granted = $(jget "$GRANT_BODY" granted)"
  echo "  event   = #$(jget "$GRANT_BODY" event.id) hash=$(jget "$GRANT_BODY" event.hash)"
  echo "  balance = $(jget "$GRANT_BODY" member.credits) credits"
fi

# --- Publish tasks + pin arena comments -------------------------------
hr "3) publishing tasks + pinning arena comments from $TASKS_JSON"

# Prepare per-task JSON payloads (with arena expiry) and per-arena
# comment bodies via a Node helper. This keeps quoting simple.
export SEED_FILE="$TASKS_JSON"
export SEED_DAYS="$DAYS"
export SEED_DATA_BASE="$DATA_BASE"

COUNT=$(SEED_FILE_ARG="$TASKS_JSON" node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.env.SEED_FILE_ARG,"utf8")).tasks.length));')
echo "  planned = $COUNT tasks"

PUBLISHED=0
SKIPPED=0
COMMENTS_POSTED=0
ARENA_SEEN=0

for i in $(seq 0 $((COUNT - 1))); do
  export SEED_IDX="$i"
  # Full task payload (JSON), arena expiry injected by the helper.
  TASK=$(node "$HERE/lib/seed-task-payload.mjs")
  TITLE=$(jget "$TASK" title)
  REWARD=$(jget "$TASK" reward_credits)
  GUILD=$(jget "$TASK" guild)

  RESP=$(curl -sS -X POST "$BASE/api/tasks" \
    -H "authorization: Bearer $SECRET" \
    -H 'content-type: application/json' \
    -d "$TASK") || true
  ERR=$(jget "$RESP" error)
  TID=""
  if [ -n "$ERR" ]; then
    case "$ERR" in
      *duplicate*) echo "  [$((i+1))/$COUNT] SKIP dup, $TITLE"; SKIPPED=$((SKIPPED+1));;
      *)           echo "  [$((i+1))/$COUNT] FAIL: $ERR: $TITLE" >&2; exit 4;;
    esac
    # find the existing task id so we can still post the comment
    if [ "$GUILD" = "arena" ]; then
      RESP_ALL=$(curl -sS "$BASE/api/tasks?guild=arena&limit=50")
      TID=$(NEEDLE_TITLE="$TITLE" RESP_JSON="$RESP_ALL" node -e 'const o=JSON.parse(process.env.RESP_JSON);const t=(o.tasks||[]).find(x=>x.title===process.env.NEEDLE_TITLE);process.stdout.write(t?String(t.id):"");')
    fi
  else
    TID=$(jget "$RESP" task.id)
    echo "  [$((i+1))/$COUNT] task#$TID guild=$GUILD reward=${REWARD}c: $TITLE"
    PUBLISHED=$((PUBLISHED+1))
  fi

  # Post the pinning comment for arena tasks #1..#4 only. Task title
  # starts with "ARENA #N:" and we key off the number.
  case "$TITLE" in
    "ARENA #1:"*|"ARENA #2:"*|"ARENA #3:"*|"ARENA #4:"*)
      ARENA_SEEN=$((ARENA_SEEN+1))
      [ -z "$TID" ] && { echo "    (no task id; cannot post comment)" >&2; continue; }
      # Compose comment body per arena.
      case "$TITLE" in
        "ARENA #1:"*)
          BODY="Data files for ARENA #1: code golf ISO-8601 duration.

  Vectors : $DATA_BASE/arena-1-vectors.json
  Harness : $DATA_BASE/arena-1-harness.js

Usage:
  node arena-1-harness.js path/to/submission.js
Score = byte count of submission.js (LF line endings). Exit 0 = valid."
          ;;
        "ARENA #2:"*)
          BODY="Data files for ARENA #2: one regex to split two lists.

  List A (must ALL match) : $DATA_BASE/arena-2-A.json
  List B (must NONE match): $DATA_BASE/arena-2-B.json

Score = pattern length in characters (ECMAScript regex). Lowest valid wins."
          ;;
        "ARENA #3:"*)
          BODY="Data files for ARENA #3: TSP-50 shortest tour.

  Distance matrix (50x50, symmetric, integer) : $DATA_BASE/arena-3-matrix.json

Submit a public raw URL to a JSON array of 50 node indices (permutation of 0..49).
Score = sum of matrix distances along the closed tour. Lowest valid wins."
          ;;
        "ARENA #4:"*)
          BODY="Data files for ARENA #4: SQL golf on the public events feed.

  SQLite dump   : $DATA_BASE/arena-4-dump.sql
  Question      : $DATA_BASE/arena-4-question.md
  Expected out  : $DATA_BASE/arena-4-expected.txt

Load: sqlite3 arena4.db < arena-4-dump.sql
Submit a public raw URL to a single SELECT whose output byte-matches expected."
          ;;
      esac

      # POST /api/comments with a properly JSON-encoded body (single-line node -e).
      CBODY_JSON=$(BODY_TEXT="$BODY" TID_STR="$TID" node -e 'process.stdout.write(JSON.stringify({task_id:Number(process.env.TID_STR),body:process.env.BODY_TEXT}));')
      CRESP=$(curl -sS -X POST "$BASE/api/comments" \
        -H "authorization: Bearer $SECRET" \
        -H 'content-type: application/json' \
        -d "$CBODY_JSON") || true
      CERR=$(jget "$CRESP" error)
      if [ -n "$CERR" ]; then
        echo "    comment FAIL: $CERR" >&2
      else
        CID=$(jget "$CRESP" comment.id)
        echo "    comment#$CID pinned"
        COMMENTS_POSTED=$((COMMENTS_POSTED+1))
      fi
      ;;
  esac
done

hr "4) summary"
echo "  tasks published this run = $PUBLISHED"
echo "  tasks skipped (dup)      = $SKIPPED"
echo "  arena comments posted    = $COMMENTS_POSTED / $ARENA_SEEN expected"

STATS=$(curl -sS "$BASE/api/stats") || true
echo
echo "  /api/stats:"
echo "    members             = $(jget "$STATS" members)"
echo "    guilds              = $(jget "$STATS" guilds)"
echo "    tasks_total         = $(jget "$STATS" tasks_total)"
echo "    tasks_open          = $(jget "$STATS" tasks_open)"
echo "    submissions_total   = $(jget "$STATS" submissions_total)"
echo "    comments_total      = $(jget "$STATS" comments_total)"
echo "    credits_circulating = $(jget "$STATS" credits_circulating)"
echo "    events_total        = $(jget "$STATS" events_total)"
echo "    latest_event_id     = $(jget "$STATS" latest_event_id)"

hr "seed done"
