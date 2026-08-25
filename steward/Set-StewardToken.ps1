# Set-StewardToken.ps1 — finish the steward setup from PowerShell.
#
#   powershell -ExecutionPolicy Bypass -File steward\Set-StewardToken.ps1
#
# Runs `claude setup-token` in this terminal (which has a real console,
# unlike the agent's shell), takes the long-lived subscription token, and
# stores it as the CLAUDE_CODE_OAUTH_TOKEN secret on the steward repo.
#
# Written for PowerShell rather than bash because `bash` on this machine
# resolves to WSL, where the Windows drive lives under /mnt/c and the
# Windows claude.exe is not on PATH at all.
#
# The token is never written to disk and never echoed.

$ErrorActionPreference = 'Stop'
$Repo = 'ianewsfr-a11y/ergonia-steward'

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# --- locate the CLIs -------------------------------------------------
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { Fail "claude CLI not found on PATH." }
Write-Host "using claude at: $claude"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "gh CLI not found on PATH." }

# --- borrow the git credential that can reach ianewsfr-a11y ----------
# gh's own login on this machine is a different account (Renfeld) which
# cannot see the steward repo. Nothing is printed.
$credInput = "protocol=https`nhost=github.com`npath=ianewsfr-a11y/ergonia.git`n`n"
$credOut   = $credInput | & git credential fill 2>$null
$ghToken   = ($credOut | Select-String '^password=').ToString() -replace '^password=', ''
if (-not $ghToken) {
  Fail "Could not read the stored git credential for ianewsfr-a11y."
}
$env:GH_TOKEN = $ghToken

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " Step 1 of 2 - authorise Claude Code" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " A browser window will open (or a URL will be printed)."
Write-Host " Click Authorize, then come back here."
Write-Host ""

# Run it and capture what it prints so the token can be picked out.
$out = & $claude setup-token 2>&1 | Tee-Object -Variable captured | Out-String

$token = $null
$m = [regex]::Matches($out, 'sk-ant-[A-Za-z0-9_\-]{20,}')
if ($m.Count -gt 0) { $token = $m[$m.Count - 1].Value }

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " Step 2 of 2 - store it as a repository secret" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

if ($token) {
  $token | & gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $Repo
  Write-Host " Stored CLAUDE_CODE_OAUTH_TOKEN on $Repo (value not shown)." -ForegroundColor Green
  Remove-Variable token
} else {
  Write-Host " Could not read the token automatically from the output."
  Write-Host " Paste it at the prompt below:"
  & gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $Repo
}

Write-Host ""
Write-Host " Secrets now on ${Repo}:"
& gh secret list --repo $Repo
Write-Host ""
Write-Host ' Done. Tell Claude Code "token pose" and it will trigger the run.' -ForegroundColor Green
