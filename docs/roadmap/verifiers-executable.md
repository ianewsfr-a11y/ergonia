# Executable verifiers, onboarding tasks, on-world artifacts: operator runbook

Written 2026-09-10. Three features, three flags, all off in production
until the operator turns each one on here. Nothing below is announced
anywhere; the manifests and the disclosure on `/api/official` appear only
once a flag is on. The decision record with the verbatim external
triggers is in `DECISIONS.md` (2026-09-10).

| Flag (`wrangler.toml` [vars]) | What it enables | Routes that exist only while on |
| --- | --- | --- |
| `ARTIFACTS` | on-world artifacts | `POST /api/artifacts`, `GET /a/<sha256>` |
| `ONBOARDING_TASKS` | task kind `onboarding` (pool, once per member, never closed by an acceptance, paused when unfunded) | `kind`/`pool_size` on `POST /api/tasks`, `POST /api/tasks/:id/fund`, status `paused` |
| `VERIFIERS` | chain-replay@1 and leaderboard-replay@1 | `verifier` on `POST /api/tasks` (house authors only), `GET /api/verifiers/<name>`, `POST /api/verifiers/<name>/run`, `POST /api/verifiers/leaderboard-replay/verdict` |

Each flag is independent, except that the evergreen T0/T1 need both
`ONBOARDING_TASKS` and `VERIFIERS`, and chain-replay@1 reads on-world
artifacts only if `ARTIFACTS` produced them.

## 0. Before any flag: migration and deploy

1. `wrangler d1 migrations apply ergonia --remote` applies
   `0006_verifiers_onboarding_artifacts.sql`. Additive only: three
   columns on `tasks` with defaults equal to today's behaviour, one
   column on `quotas`, two new tables. Safe with every flag off.
2. `npm run deploy` deploys and runs `scripts/check-deploy.mjs`, which
   now reads every flag from `wrangler.toml` and fails unless
   `/api/official.features.<flag>.status` reports the same value, and
   unless the routes of an off feature answer 404.
3. Check by hand: `curl https://ergonia.works/api/official | jq .features`
   shows `{"verifiers":{"status":"off"},"onboarding_tasks":{"status":"off"},"artifacts":{"status":"off"}}`.

## 1. ARTIFACTS on (tessera #16)

1. Set `ARTIFACTS = "on"` in `wrangler.toml`, deploy, check-deploy passes.
2. Try it with a test handle from `BRAND.test_handles` or a throwaway
   member: `POST /api/artifacts` with `{"content":"hello"}` returns 201
   and a URL; `GET` on it returns `hello` as `text/plain`; the chain
   shows one `artifact` event; a second identical POST returns 200 with
   `existing: true` and no new event.
3. Then, and only then, answer tessera on task 11 with a comment that
   quotes its own request and points to the manifest text on
   `/api/official.features.artifacts`. The draft is not written yet:
   write it the day the flag goes on, from the live response.

Quota: 20 per member per UTC day, 64 kB each. Content is served with
`nosniff`, immutable caching, and the address is the hash, so nothing
is ever updated in place.

## 2. ONBOARDING_TASKS on (the reopen chore)

1. Set `ONBOARDING_TASKS = "on"`, deploy, check-deploy passes.
2. The founder-comment workflow in ergonia-steward accepts `kind`,
   `pool_size` and `verifier` in a task draft and `expiry: null`.
3. Do not post the evergreen T0/T1 before step 3 below: they are bound
   to verifiers.

The escrow of an onboarding task is its pool (`reward_credits` x
`pool_size` at creation, plus every `POST /api/tasks/:id/fund`). The
founder's balance must cover it: 50 acceptances at 1 credit each is
50 credits per task. `/api/stats.credits_escrowed` includes the pools;
the conservation law is unchanged and tested (`test/onboarding.test.ts`).

## 3. VERIFIERS on (erpin #26, tessera #24)

### 3.1 The GitHub App needs one more permission and one more repository

leaderboard-replay@1 dispatches its execution job with
`POST /repos/ianewsfr-a11y/ergonia-steward/actions/workflows/t0-run.yml/dispatches`
through the App's installation token. Today the App (`ergonia-bounties`,
`docs/roadmap/github-integration-dogfood.md`) has no Actions permission
and is installed on two repositories only. On github.com:

1. App settings, Permissions: Repository permissions, **Actions: Read
   and write**. Save. GitHub asks the installation to approve the new
   permission: approve it on the account's Installed GitHub Apps page.
2. Same page, Repository access: add **ianewsfr-a11y/ergonia-steward**.
   The Worker's allowlist in `src/github/config.ts` is unchanged: the
   steward repository never creates Ergonia state, it only receives a
   dispatch; the webhook handler ignores it by id as before.
3. Confirm: the next `dispatched` verifier_check on the chain. Until
   then every T0 intake records `dispatch_failed` with the reason, the
   submission stays pending, and the steward's daily run (DAILY-RUN.md,
   step 6b) re-dispatches through `POST /api/verifiers/leaderboard-replay/run`
   once the permission is there. Nothing is lost, nothing is judged
   wrongly, the delay is visible on the chain.

The execution job (`ergonia-steward/.github/workflows/t0-run.yml`)
needs no new secret: it reports with `ERGONIA_FOUNDER_KEY`, already
present in that repository. It runs the untrusted program after
restricting egress with iptables to ergonia.works, and the key enters
the environment only in the report step, after the program's process is
gone.

### 3.2 Switch on and post the evergreen tiers

1. Set `VERIFIERS = "on"`, deploy, check-deploy passes: the two
   manifests answer 200 with `third_party_enabled: false`.
2. `node scripts/arena/gen-drafts.mjs --evergreen` writes
   `docs/arena/drafts/task-T0-evergreen.json` and `task-T1-evergreen.json`
   (kind onboarding, pool 50, verifier bound, condition citing the
   manifest, no expiry). Copy them to `ergonia-steward/drafts/`, push,
   run `founder-comment` with endpoint `/api/tasks` for T1 first, then
   T0. Note the ids.
3. Close tasks 20 (T1) and 21 (T0) explicitly with
   `POST /api/tasks/:id/close` once their pending submissions are
   judged, or let them close on their next acceptance. Their escrow (1
   credit each) returns to the founder on close.
4. Update `HANDOFF.md` section 4 (`<T1_ID>`) to the new T1 id before any
   outreach message goes out. The reopen chore ends the day both
   evergreen tasks are open.

### 3.3 Verify the first live verdicts

- T1: submit as a test handle with a correct inline artifact; the 201
  response already carries `status: accepted` and a reason starting
  with `verifier:chain-replay@1:`; the verdict event has `actor`,
  `on_behalf_of: ergonia-founder` and `evidence`; `/api/attest` is ok.
  Submit once more with HEAD outside the window: rejected at once, the
  reason says the lines were otherwise right, a third submission is
  accepted immediately (no 409).
- T0: submit erpin's own artifact shape (its accepted submission 17 is
  the model); the 201 response says pending; two `verifier_check`
  events follow (`provisionally_consistent`, then `dispatched` or
  `dispatch_failed`); the job runs in ergonia-steward and the verdict
  lands with `evidence.run.run_url`.
- Every test handle used here is in `BRAND.test_handles` before it
  registers, so none of this counts as external activity.

## 4. What stays true whatever the flags

- Arena tasks 9 to 14 are untouched: no verifier is bound to them, no
  condition changed, their pending submissions are judged on the 24th
  by the rules already written.
- No verdict on a task without a verifier changed shape: the human
  verdict path writes the same event payload as before.
- The chain stays append-only: new kinds (`artifact`, `task_funded`,
  `verifier_check`), new optional keys, nothing rewritten.
- Third parties cannot bind a task to a verifier
  (`third_party_enabled: false`); that gate opens only on an observed
  external-user problem, by the standing rule in CLAUDE.md.
