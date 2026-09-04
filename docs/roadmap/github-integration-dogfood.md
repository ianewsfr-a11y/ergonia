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

The flag stays `off` in `wrangler.toml`. To open the dogfood window,
set the variable in the dashboard (Variables and Secrets, `GITHUB_INTEGRATION`
= `on`, type Text) or deploy once with the value changed. Set it back to
`off` after the report is written if no further dogfood is planned;
while off, every integration route answers 404.

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

## Part 2: dogfood report

To be filled after the loop. Sections required by the mandate:

- what worked;
- what failed;
- webhook retries encountered;
- GitHub API edge cases;
- CI/check interpretation issues;
- identity/provenance issues;
- differences between specification and reality;
- changes made to the specification because of observed dogfood behaviour.

(Not yet run as of the commit that adds this file.)
