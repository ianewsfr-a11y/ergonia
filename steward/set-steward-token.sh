#!/usr/bin/env bash
# One command to finish the steward setup.
#
#   bash steward/set-steward-token.sh
#
# It runs `claude setup-token` in YOUR terminal (which has a TTY, unlike
# the agent's shell), takes the long-lived subscription token it prints,
# and stores it as the CLAUDE_CODE_OAUTH_TOKEN secret on
# ianewsfr-a11y/ergonia-steward.
#
# The token is never written to disk, never echoed, and never leaves this
# process except as the body of the `gh secret set` call.

set -euo pipefail

REPO="ianewsfr-a11y/ergonia-steward"

command -v claude >/dev/null || { echo "claude CLI not found on PATH" >&2; exit 2; }
command -v gh     >/dev/null || { echo "gh CLI not found on PATH" >&2; exit 2; }

# gh's default login is a different account (Renfeld) which cannot see
# this repo, so borrow the git credential that already works for
# ianewsfr-a11y. Nothing is printed.
GH_TOKEN=$(printf 'protocol=https\nhost=github.com\npath=ianewsfr-a11y/ergonia.git\n\n' \
           | git credential fill 2>/dev/null | sed -n 's/^password=//p')
if [ -z "${GH_TOKEN:-}" ]; then
  echo "Could not read the stored git credential for ianewsfr-a11y." >&2
  echo "Run:  gh auth login   (as ianewsfr-a11y)  and re-run this script." >&2
  exit 3
fi
export GH_TOKEN

echo
echo "=============================================================="
echo " Step 1 of 2 — authorise Claude Code"
echo "=============================================================="
echo " A browser window will open (or a URL will be printed)."
echo " Click Authorize, then come back here."
echo

# Run interactively so the OAuth flow works, while capturing stdout so we
# can pick the token out of it.
TMP_OUT="$(mktemp)"
chmod 600 "$TMP_OUT"
trap 'rm -f "$TMP_OUT"' EXIT

set +e
claude setup-token 2>&1 | tee "$TMP_OUT"
rc=${PIPESTATUS[0]}
set -e

TOKEN=""
if [ $rc -eq 0 ]; then
  # The long-lived token looks like sk-ant-oat...; take the last match.
  TOKEN=$(grep -oE 'sk-ant-[A-Za-z0-9_-]{20,}' "$TMP_OUT" | tail -1 || true)
fi
rm -f "$TMP_OUT"
trap - EXIT

echo
echo "=============================================================="
echo " Step 2 of 2 — store it as a repository secret"
echo "=============================================================="

if [ -n "$TOKEN" ]; then
  printf '%s' "$TOKEN" | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$REPO"
  echo " Stored CLAUDE_CODE_OAUTH_TOKEN on $REPO (value not shown)."
  unset TOKEN
else
  echo " Could not read the token automatically."
  echo " Paste it at the prompt below (input is hidden):"
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$REPO"
fi

echo
echo " Secrets now on $REPO:"
gh secret list --repo "$REPO"
echo
echo " Done. Tell Claude Code \"token posé\" and it will trigger the run."
