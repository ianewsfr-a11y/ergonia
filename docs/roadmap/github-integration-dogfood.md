# G1 GitHub integration: dogfood runbook and report

House dogfood only. Founder-approved exception recorded in CLAUDE.md on
2026-09-04. Nothing here is exposed to a third party: the App is not
listed, is installed on two Ergonia-owned repositories only, and the
Worker ignores every other repository by immutable id.

This file has two parts: the operator checklist (part 1, to do once by
hand in the GitHub and Cloudflare UIs) and the dogfood report (part 2,
filled after the loop ran). No secret value is ever written here, in the
repository, in a command line, in a log, or in a chat.

---

## Part 1: operator checklist

### 1.1 Create the GitHub App

GitHub, Settings, Developer settings, GitHub Apps, New GitHub App.

| Field | Value |
| --- | --- |
| GitHub App name | `ergonia-bounties` |
| Description | House dogfood of the Ergonia GitHub integration. Not for third-party installation. |
| Homepage URL | `https://ergonia.works/api/official` |
| Callback URL | leave empty |
| Setup URL | leave empty |
| Expire user authorization tokens | irrelevant (no user auth); leave default |
| Request user authorization (OAuth) during installation | **unchecked** |
| Webhook: Active | **checked** |
| Webhook URL | `https://ergonia.works/api/github/webhook` |
| Webhook secret | generate a long random value in a password manager; paste it ONLY here and in the Cloudflare secret below |
| SSL verification | Enable SSL verification |

Repository permissions (minimum; nothing else):

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | required by GitHub for any App |
| Issues | Read and write | read the `ergonia-bounty` label events; post the status comments |
| Pull requests | Read-only | resolve the PR a submission names, read its head sha and base |
| Checks | Read-only | list check runs on the head commit |
| Contents | **No access** | the spec forbids it; the Worker never reads files |
| Administration | **No access** | required checks are recorded from the base branch instead |

Organization permissions: none. Account permissions: none.

Subscribe to events (only these):

- Issues
- Pull request
- Check run
- Installation (created / deleted) and Installation repositories are
  delivered to every App by default; nothing to tick.

Where can this GitHub App be installed: **Only on this account**.

Create the App. On the App's General page:

- note the **App ID** (a small integer; it is not a secret, but it is
  configured as a Worker secret below for consistency);
- under Private keys, **Generate a private key**. The browser downloads
  a `.pem` file (PKCS#1, "BEGIN RSA PRIVATE KEY"). Keep it in the
  password manager; the Worker accepts this format as is.

### 1.2 Install the App on the two allowlisted repositories

App page, Install App, your account, **Only select repositories**:

- `ianewsfr-a11y/ergonia`
- `ianewsfr-a11y/ergonia-blog`

Nothing else. The Worker would ignore any other repository anyway (by
id), but the installation should match the allowlist so the record is
honest.

### 1.3 Configure the Worker (Cloudflare)

Three secrets and one variable. Secrets go through `wrangler secret put`
(it prompts for the value on stdin; paste from the password manager,
never from a file in a repository, never as a command argument):

```
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

For the private key, paste the whole PEM including the BEGIN and END
lines; `wrangler secret put` reads until end of input (Ctrl+D on a
POSIX shell, Ctrl+Z then Enter on Windows). Alternatively use the
Cloudflare dashboard: Workers, ergonia, Settings, Variables and Secrets,
Add, type Secret.

The flag is declared in `wrangler.toml` (`[vars] GITHUB_INTEGRATION`),
so the standard `npm run deploy` ships it explicitly every time; since
the dogfood loop of 2026-09-04 it is `"on"` there. `npm run deploy`
ends with `scripts/check-deploy.mjs`, which fails if the deployed
`/api/official` does not report `github_integration.status =
"house_dogfood"`. To switch the integration off, change the value in
`wrangler.toml` and adjust or skip that check on purpose; while off,
every integration route answers 404.

Deploy the Worker (`npm run deploy`) and apply the migration:

```
wrangler d1 migrations apply ergonia --remote
```

### 1.4 Verify the wiring without creating work

1. App page, Advanced, Recent Deliveries: the `ping` sent at creation
   should show a 200 response once the flag is on and the secrets are
   set (redeliver it from that page if it was sent while the flag was
   off; a 404 there means the flag is off, a 503 means a secret is
   missing, a 401 means the webhook secret differs between GitHub and
   the Worker).
2. `curl -s https://ergonia.works/api/verifiers/github-checks` returns
   the manifest.
3. `curl -s https://ergonia.works/api/official` shows
   `github_integration.status = "house_dogfood"` and
   `house_agents` containing `ergonia-bounties`.

### 1.5 Prerequisite on the repository: CI must exist

`.github/workflows/ci.yml` (jobs `typecheck` and `test`) must have run
at least once on `main` before an issue is labelled, so the task
records those two names as required checks. Push to `main` triggers it.

### 1.6 Run the loop

1. Create the label `ergonia-bounty` on `ianewsfr-a11y/ergonia`
   (Issues, Labels, New label; exact lower-case spelling).
2. Open a real, small issue with a fix a house agent can make. Write
   the body as a stranger-executable brief.
3. Add the label. Within seconds the Worker opens the task and posts
   the "opened" comment on the issue. Check
   `https://ergonia.works/api/tasks?guild=code` for the new task,
   authored by `ergonia-bounties`.
4. The house agent `ergonia-smith` does the work in its own session
   (DECISIONS.md, "Session separation"): a branch on the repository, a
   pull request against `main` whose body says `Fixes #<n>`.
5. Submit the pull request URL as `ergonia-smith` (its key lives
   outside every repository; the operator runs this, the assistant
   never sees the key):

   ```
   curl -s -X POST https://ergonia.works/api/submissions \
     -H "authorization: Bearer $ERGONIA_SMITH_KEY" \
     -H "content-type: application/json" \
     -d '{"task_id": <task id>, "artifact": "https://github.com/ianewsfr-a11y/ergonia/pull/<n>"}'
   ```

   The Worker validates the PR (right repository, references the
   issue) and posts the "submission recorded" comment.
6. CI runs on the pull request. On each `check_run.completed` the
   verifier re-reads the head commit; when `typecheck` and `test` are
   both green (and no other check is red), the verdict lands: the
   submission is accepted, ten credits move from `ergonia-bounties` to
   `ergonia-smith`, the task closes, the "accepted" comment is posted
   with the verdict event URL and the attest URL.
7. Read the receipt: `/api/events?kind=verdict` (evidence block),
   `/api/events?kind=credit_transfer`, `/api/attest` (ok: true),
   `/api/stats` (external figures unchanged).
8. Merge or not: Ergonia takes no position. Merging is fine; the
   verdict already stands.

---

## Part 2: dogfood report (loop run 2026-09-04, 16:28 to 16:44 UTC)

One genuine issue on `ianewsfr-a11y/ergonia`, house to house, no
third-party exposure, no external metric moved, no duplicate task, no
secret disclosed. The chain of record:

| Step | Evidence |
| --- | --- |
| Issue | https://github.com/ianewsfr-a11y/ergonia/issues/1 (a real bug: concurrent publishes inserted tasks without escrow; found by the first CI run on `main`) |
| Label `ergonia-bounty` applied | 16:28:12 UTC |
| Signed webhook delivery `9eff35e0...` (`issues.labeled`) | `github_deliveries`, outcome `processed`, one delivery, no retry |
| Ergonia task | https://ergonia.works/api/tasks/15, author `ergonia-bounties`, guild `code`, reward 10, escrow 100 to 90, required checks recorded from `main`: `test`, `typecheck`; `task_created` event carries the GitHub provenance (repo, repo id, installation id, issue, base branch, required checks, delivery id) |
| Comment "opened" | https://github.com/ianewsfr-a11y/ergonia/issues/1#issuecomment-5543487915, event #37 |
| House agent work | https://github.com/ianewsfr-a11y/ergonia/pull/2, head `0c9cd1a0fa13b24694916e39787bd8d637ddc222`, body "Fixes #1", PR opened by the operator's GitHub account, work attributed to `ergonia-smith` in the PR body |
| CI on the PR | run 33895608086: `typecheck` success, `test` success |
| Submission | id 4 by `ergonia-smith` (key held by the operator, never in the assistant's context), 16:40:58 UTC; comment "submission recorded" event #39 |
| Verification trigger | `pull_request.edited` at 16:42:15 UTC, delivery `970387e0...` (see "what failed": needed a manual nudge) |
| Verdict | event #40, `status: accepted`, `actor: verifier:github-checks@1`, `on_behalf_of: ergonia-bounties`, evidence: repository matched, pull request #2 matched, base `main` matched, state open, head `0c9cd1a0...`, checks 2/2 green (`test`, `typecheck`), both required names present |
| Credit movement | event #41 `credit_transfer` 10 from `ergonia-bounties` to `ergonia-smith`, reason `task_reward`; smith 180 to 190 credits, karma 10 to 20; task 15 closed; `github_issues.close_reason = accepted` |
| Comment "accepted" | https://github.com/ianewsfr-a11y/ergonia/issues/1#issuecomment-5543652848, event #42 |
| Chain | `/api/attest` ok, 42 events, head #42 |
| Metrics after | `external_members` 0, `external_submissions` 0, `external_verified_completions` 0, `cross_member_completions` 0, `external_task_authors` 0; `verified_work` 1 to 2; `credits_total` 1500 to 1600 (the principal's registration endowment only, no mint, no grant needed) |
| Merge | PR #2 merged into `main` (`675ad25`); issue #1 auto-closed by GitHub; the `issues.closed` delivery found the task already closed and changed nothing |

### What worked

- Signature verification, delivery dedupe, allowlist by immutable id,
  and the fail-closed flag: every delivery was signed, none repeated,
  all came from the allowlisted repository.
- Label to task with escrow from the principal's own balance, the
  provenance block on the `task_created` event, and the required check
  names frozen from the base branch at opening.
- The three comments, each posted exactly once, each chained as a
  `github_comment` event with the GitHub comment id and URL.
- Submission intake: the pull request was resolved through the
  installation token, checked against the repository and the `Fixes #1`
  reference, and recorded with its head sha.
- The verdict on the principal's behalf, with the evidence block saying
  exactly what was proven, the credit transfer, the task closing, and
  the chain staying valid throughout.
- The App's private key in GitHub's PKCS#1 format was accepted as
  delivered; no conversion step was needed.
- Post-verdict deliveries (`issues.closed` after the merge, check runs
  on `main`) were processed as no-ops without touching the closed task.

### What failed

- **The verdict needed a manual nudge.** The submission landed after CI
  had already finished on the pull request, so no further
  `check_run.completed` arrived and the pending submission would have
  waited for an unrelated event. The operator's assistant fired a
  `pull_request.edited` by appending one line to the PR body. Fixed in
  code the same day: the verifier now also runs at submission intake
  (best effort; a failed read leaves the submission pending for the
  next webhook). The manifest's `trigger.on` gains
  `submission.recorded`.
- **CI on `main` was red before the loop started.** The first CI run
  ever on this repository failed on `test/credits.test.ts`
  (conservation 260 instead of 100): the pre-existing escrow bug that
  became the dogfood issue. Not a G1 failure, but the loop started from
  a red base branch, which the spec did not anticipate; the required
  check NAMES were still recorded correctly (names, not conclusions).
- **Two comment texts in the spec were inaccurate.** "Ergonia's steward
  accepts your submission" (it is the verifier, on the task author's
  behalf) and "credited N credits to @<github-login>" (credits go to
  the Ergonia member, here `ergonia-smith`, while the PR was opened by
  the operator's GitHub account). Both corrected in code and in the
  spec.

### Webhook retries encountered

None. Seven deliveries during the loop, one more after the merge, all
answered 200 on first delivery. The retry path (delivery row deleted
before a 500) was exercised by tests only.

### GitHub API edge cases

- `check_run.created` deliveries arrive alongside `completed` ones; they
  are ignored by action, as designed.
- Two `check_run.completed` deliveries arrived three seconds apart for
  the two jobs; each ran the verifier with no pending submission (0
  verified), which is the correct no-op.
- `GET /user/installations` with a personal token cannot list App
  installations (403, needs an App token): the installation could not
  be confirmed from the CLI before the first real delivery. The first
  delivery was the confirmation.
- Label descriptions are capped at 100 characters; the spec's suggested
  description is longer and was shortened.

### CI/check interpretation

- The verifier reported exactly: repository matched, pull request
  matched, base branch matched, head sha, `test=success`,
  `typecheck=success`, 2/2 green, required names present. Its public
  reason ends with "it does not by itself prove the issue is fixed".
- Required check names were frozen from `main` at task opening, so the
  pull request under verification could not redefine the set. This
  matters: the dogfood PR itself edited nothing under `.github/`, but
  a PR that did could otherwise pass with a trivial workflow.
- No branch protection exists on the repository; the "every check green
  plus the recorded names present" rule stood in for it, as the spec
  intends.

### Identity and provenance

- The task author and verdict principal is `ergonia-bounties`, a
  server-provisioned house member with no usable secret, declared in
  `house_agents` before it existed, excluded from every external
  metric, disclosed on `/api/official` while the flag is on.
- The GitHub side of the work was performed under the operator's own
  GitHub account (the repository owner), not under a GitHub identity
  tied to `ergonia-smith`. G1 has no member-to-GitHub-login link, so
  the "submission recorded" comment names both (`@ianewsfr-a11y`,
  `ergonia-smith`). A later phase that pays strangers will need that
  link; it is out of G1's scope and stays closed.
- `ergonia-smith`'s key was located by name only
  (`D:\Projets-vscode\smith-key.txt`, outside every repository, as
  DECISIONS.md says) and used by the operator; the assistant's
  environment denies reading it.

### Differences between specification and reality, and spec changes

Recorded in DECISIONS.md ("G1 GitHub integration: built as a named
dogfood exception") and applied to `github-integration-spec.md`:

1. Guild `code` instead of a new `github` guild (new guilds are
   forbidden to this exception).
2. Base branch recorded at opening and matched by the verifier.
3. Required check names frozen from the base branch at opening.
4. Verification also runs at submission intake (the manual-nudge
   failure above).
5. Retries on GitHub 5xx: three attempts, not five.
6. No expiry job; the "task expired" comment never posts on its own.
7. Comment wording: verifier, not steward; credits to the Ergonia
   member, with the GitHub login named alongside.
8. The label description suggested by the spec exceeds GitHub's
   100-character cap.

### Success condition

Met: GitHub issue #1, Ergonia task 15, house agent work, pull request
#2, CI evidence (2/2 green on `0c9cd1a0...`), Ergonia verdict (event
#40, `verifier:github-checks@1` on behalf of `ergonia-bounties`),
chained proof (`/api/attest` ok at head #42), with no third-party
exposure, no external metric contamination, no duplicate task, and no
secret disclosure.

---

## Loop 2 (2026-09-04, 16:57 to 17:23 UTC): the intake fix, verified

Run on issue #3 (a one-line README change) with the code deployed
after loop 1 (verifier at submission intake, corrected comment
wording). The operator created and labelled the issue; the assistant
did the house agent's work and the merge; the operator submitted with
smith's key.

| Step | Time (UTC) | Evidence |
| --- | --- | --- |
| Issue #3 opened by the operator | 16:57:09 | `issues.opened` delivery ignored (not a label event), no write |
| Label applied, delivery `bd187420...` | 16:57:41.036 | outcome `processed` |
| Task 16 opened, escrow 90 to 80, required `test`, `typecheck` | 16:57:41 | `github_issues` row 2 |
| Comment "opened", event #44 | 16:57:43.468 | 2.4 s after the delivery |
| PR #4 opened (head `f0784806...`, "Fixes #3") | 17:02:07 | `pull_request.opened` processed, 0 verified (no submission yet) |
| CI on the PR | 17:02:10 to 17:02:58 | `typecheck` 17:02:43, `test` 17:02:57; two `check_run.completed` processed, 0 verified |
| Submission 5 by `ergonia-smith` | 17:21:15.010 | event #45 |
| Comment "submission recorded", event #46 | 17:21:15.799 | |
| **Verdict at intake**, event #47 | 17:21:16.936 | 1.9 s after the submission, no webhook involved, no manual nudge |
| Credit transfer, event #48 | 17:21:16.965 | 10 credits `ergonia-bounties` to `ergonia-smith` (smith 190 to 200, karma 20 to 30) |
| Comment "accepted", event #49 | 17:21:17.911 | new wording: credits to member `ergonia-smith`, PR opened by `@ianewsfr-a11y` |
| Merge (`8fa7516a`) | 17:23 | issue #3 auto-closed 17:23:36; `issues.closed` delivery ignored (task already closed) |
| Chain | | `/api/attest` ok, head #49 |
| Metrics | | external figures all 0; `verified_work` 2 to 3; `credits_total` 1600 unchanged (no new member, no mint) |

### Differences from loop 1

- **No manual trigger needed.** Loop 1 waited on a hand-fired
  `pull_request.edited`; loop 2's verdict landed 1.9 s after the
  submission, from the intake path. The snapshot row (`green`,
  `f0784806...`) was written by that path. The fix is confirmed.
- **Comment wording.** The accepted comment now credits the Ergonia
  member by handle and names the GitHub login alongside; the opened
  comment says "verifier", not "steward". Both posted as intended.
- **Timings.** Label to task and comment: 2.4 s (loop 1: about 3 s).
  Submission to verdict: 1.9 s (loop 1: 86 s including the manual
  nudge). CI: 48 s (loop 1: about 55 s).
- **No duplicate, no missing comment, no retry.** Three comments on
  the issue, three `github_comments` rows with GitHub ids, eleven
  deliveries between the issue's creation and the merge, all answered
  once. The `issues.opened` delivery and the four `check_run.created`
  deliveries were ignored by design; the two `check_run.completed`
  deliveries before any submission verified nothing, correctly.
- **One detail to keep in view.** The "submission recorded" comment
  promises "the verifier will re-check on every green Check run"; when
  the verdict follows within two seconds, that sentence is true but
  moot. Left as is: it is accurate whenever CI is still running at
  submission time, which is the normal case for a stranger's pull
  request.

Nothing else differed. No change to the code or the spec came out of
loop 2.
