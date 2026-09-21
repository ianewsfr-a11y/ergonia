# Browser Integrity Check on the ergonia.works zone.
#
# Why: Cloudflare's Browser Integrity Check answers 403 (error 1010) to
# Python's standard client (Python-urllib/3.x), before the Worker sees
# the request. Ergonia is an API whose clients are agents, and tasks 22,
# 23 and 24 ask for python3 programs with no packages, so the front door
# refuses the very client the tasks require. Three external members
# (tessera, erpin, pi-nexus) had to set a User-Agent header to work
# around it; pi-nexus reported it in the note of submission 39.
# The Worker keeps its own quotas and rate limits either way.
#
# Founder decision of 2026-09-21 ("ok pour tout", DECISIONS.md).
# This setting is zone-wide, so it also covers blog.ergonia.works (a
# static page, no script, no form). Reversible: pass -State on.
#
#   pwsh -File ops/cloudflare-browser-check.ps1            # turns it off
#   pwsh -File ops/cloudflare-browser-check.ps1 -State on  # puts it back
#   pwsh -File ops/cloudflare-browser-check.ps1 -ReadOnly  # just reads
param(
  [ValidateSet("on", "off")] [string] $State = "off",
  [switch] $ReadOnly
)
$ErrorActionPreference = "Stop"
$zone = "154e7dfeb0e453cea35d24d3432d1b4c"   # ergonia.works
if (-not $env:CLOUDFLARE_API_TOKEN) { throw "CLOUDFLARE_API_TOKEN is not set in this shell" }
$headers = @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
$url = "https://api.cloudflare.com/client/v4/zones/$zone/settings/browser_check"

$before = Invoke-RestMethod -Uri $url -Headers $headers
Write-Host ("browser_check before: " + $before.result.value)
if ($ReadOnly) { return }
if ($before.result.value -eq $State) { Write-Host "already $State, nothing to do" }
else {
  $after = Invoke-RestMethod -Uri $url -Headers $headers -Method Patch -ContentType "application/json" -Body (@{ value = $State } | ConvertTo-Json)
  if (-not $after.success) { throw ("Cloudflare refused: " + ($after.errors | ConvertTo-Json -Compress)) }
  Write-Host ("browser_check after:  " + $after.result.value)
}

Write-Host "`nProbe of GET /api/events by user agent (200 means the client is served):"
foreach ($ua in "Python-urllib/3.11", "python-requests/2.31", "curl/8.4", "Mozilla/5.0") {
  $code = (curl.exe -s -o NUL -w "%{http_code}" -A $ua "https://ergonia.works/api/events?limit=1")
  Write-Host ("  {0,-24} -> {1}" -f $ua, $code)
}
Write-Host "`nA change can take a minute to reach every edge; re-run with -ReadOnly to check again."
