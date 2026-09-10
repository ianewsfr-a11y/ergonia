# Arena pivot handoff (branch `arena-pivot`, 2026-09-07)

Prepared by the assistant for the human. Nothing here has been posted or
sent. Every write below is a file in this branch or a workflow schedule
in the ambassador and journeyman repositories; the production API was
only read.

## 1. Findings from step 1

**Inline artifact, checked in code (2026-09-07, third pass).** An
artifact of up to 2000 characters is already chained and hashed; no
change needed. `src/submissions.ts` accepts any string of 3 to 2000
characters as `artifact` (line 31) and, after the row is inserted,
appends a `submission` event whose payload carries the artifact string
itself (lines 82 to 89: `submission_id, task_id, member_id, handle,
artifact`, plus GitHub fields on GitHub tasks). `src/chain.ts` hashes
the payload as a whole: `hash = SHA-256(prev_hash || canonical_payload)`
(lines 56 to 61). `test/chain.test.ts` asserts exactly that, on the
first event (`SHA256("GENESIS" + payload)`, lines 7 to 16), on the link
between consecutive events (lines 19 to 22), and by tampering a stored
payload and watching `/api/attest` fail (lines 29 onwards). So a
submitter who puts the artifact text in the `artifact` field, instead of
a URL, gets it written into the chained event and covered by the hash.
That is the route offered to `tessera` (section 4b) and added to T1.

**Comment as artifact, checked in code (2026-09-07, second pass).**

- (a) **No.** The comment body is not inside the chained event. When a
  comment is posted, `src/comments.ts` writes the body to the `comments`
  table (line 53, `INSERT INTO comments (task_id, member_id, body,
  created_at)`) and then chains a `comment` event whose payload is only
  `{comment_id, task_id, member_id, handle}` (lines 60 to 65). The hash
  covers those four fields, not the text. `GET /api/tasks/:id/comments`
  serves the body from the table. So a comment is on the domain and
  timestamped, its existence is chained, but its content is not hashed
  with the rest and the chain would not notice a change to it.
- (b) 1 to 2000 characters after trimming (`src/comments.ts` lines 39
  to 40: `isNonEmptyString(text, 1, 2000)`, else 400 "body must be
  1-2000 chars"). Daily quota 20 comments per member.
- (c) **Yes.** The submit endpoint accepts it. `src/submissions.ts` line
  31 is the only check on `artifact`: `isNonEmptyString(artifact, 3,
  2000)`, any string of 3 to 2000 characters, no URL parsing, no host
  rule. The one exception is a GitHub-mirrored task, where the artifact
  must be a pull request URL; T0 and T1 are not GitHub tasks.

Because (a) fails, the comment route was rejected: no comment-as-artifact
paragraph in T0 or T1, and the reply to `tessera` (section 4b) offers
the inline artifact instead.

**The event feed.** `GET /api/events` pages backwards with `before=<id>`
(exclusive), page size 1 to 200 (default 50), newest first, filter by
`kind`. Fields: `id`, `kind`, `payload` (object), `prev_hash`, `hash`,
`created_at` in epoch milliseconds. Twelve kinds are accepted; eight
exist on the chain today. Full description in `EVENTS_SCHEMA.md`.

**Credits per kind.** `register` mints 100 to the new member;
`founder_grant` mints its amount to the founder (once per chain, 1200 so
far); `task_created` moves the reward from the author's balance into
escrow; `task_closed` returns `refunded_credits` to the author;
`verdict` with `status: accepted` pays the reward to the submitter and
closes the task; `verdict` with `status: rejected` moves nothing;
`credit_transfer` is the accepted payout recorded a second time and
must be counted once; comments, rotations and GitHub events move
nothing.

**1c, in plain words.** Refusing a submission is a chained event that
moves no credit. Expiring a task is not an event at all: no code sets
`status = expired`, no refund happens, the task stays open and its
reward stays escrowed until the author calls close, which is chained
with the refund. So there is no credit movement outside the chain, and
the ledger at any past head (total, circulating, escrow, every balance)
replays from `/api/events` alone. The word "expired" must not appear in
a replay rule. Side effect worth knowing: `tasks_expired` on
`/api/stats` is always 0, and expired-by-date tasks keep their escrow
until someone closes them. Not fixed, per the constraints.

**1d.** Replay of all 63 events at the time of reading equals
`/api/stats` exactly: total 2100, circulating 1320, escrow 780, 13 open
tasks. No mismatch. At head 38 (63 minus 25) the replay gives 1600, 810,
790.

**Something the chain said while this was being prepared.** At
21:04 UTC, two hours after the founder's comment on task 11, the
external member `tessera` (declared model claude-fable-5-1) answered
with comment #16, event #64. In its own words: it read all six arena
conditions intending to submit and declined every one because each
needs the artifact at a public raw URL, and an agent whose only door to
the network is a short list of registered hosts has nowhere to put one.
What it would want built: an on-world artifact endpoint, a small blob
posted with the bearer, returned as an immutable public raw URL under
the world's own domain, with the blob's hash in the same chain. It
would submit to the hash hunt the day such an endpoint exists. This is
the first external answer on the chain and the first named
external-user problem in the sense of CLAUDE.md. Recorded in
DECISIONS.md; nothing was built (hard constraint: no new endpoint).

## 2. Not done, or done differently, under the constraints

- **Comment-as-artifact paragraph not added** to T0 and T1: step 1(a)
  failed (body not hashed). The briefs are the appendix texts verbatim.
- **T2 dropped** (step 2): `scripts/arena/verify.mjs` and its tests
  removed, the T2 tier removed from the leaderboard generator and the
  generated file, one line in DECISIONS.md. Kept: `scripts/arena/lib/
  chain.mjs` (fetchWindow, replayLedger) with `test/arena-ledger.test.ts`,
  because the leaderboard needs the replay and T1 allows citing public
  code. If the human considers the replay itself a public solution to
  T1, delete `replayLedger` and inline a private copy in the leaderboard
  workflow; say so and it is done.
- **DECISIONS entry language.** The approved entry was in French without
  accents; DECISIONS.md is written in English, so it was carried over
  sentence for sentence in English and merged with the branch entry, no
  line duplicated. The French original is in the operator's appendix.
- `DECISIONS.md` already contained 93 em-dashes in older entries. Every
  file under `docs/arena/` and `scripts/arena/` was checked by hand:
  zero em-dashes. The existing test covers served surfaces only.
- The leaderboard has no test of its own; it reuses the tested ledger
  helpers. Today it renders one placeholder row: no tiered task exists
  yet. Its columns (tiers passed, first pass per tier) differ from the
  T0 required output (accepted count, earliest accepted id) on purpose:
  T0 asks the submitter to rebuild a leaderboard from the log, not to
  copy this file.
- **Disabled schedules, confirmed on the remote mains** (files read on
  2026-09-07 through the GitHub API and diffed against the pre-change
  copies): `ergonia-ambassador/.github/workflows/ambassador.yml`
  (commit `1de2fa9`), `ergonia-journeyman/.github/workflows/journeyman.yml`
  (`5172489`) and `mag-watch.yml` (`c1e1c00`) differ from their previous
  version only on the `schedule:` block, now commented out with a dated
  note. `workflow_dispatch` and every input, job and gate are unchanged.
  The local checkouts of those two repositories are behind their remote.

## 3. Task texts and fields

Texts: `docs/arena/T0.md` and `docs/arena/T1.md`, verbatim from the
appendix. Paste each file's whole content into the `brief` field.

Fields for `POST /api/tasks` as `ergonia-founder` (the API refuses a
condition that lacks an artifact word and a control verb; both below
carry "URL" and "verify"):

| Field | T0 | T1 |
| --- | --- | --- |
| `guild` | `arena` | `arena` |
| `title` | `[EVAL-API-0] Rebuild the arena leaderboard from the public event log` | `[EVAL-CHAIN-1] Reconstruct the credit ledger at HEAD and HEAD - 25` |
| `brief` | content of `docs/arena/T0.md` | content of `docs/arena/T1.md` |
| `condition` | `Artifact is one public raw URL with HEAD=<id>, the program, its exact output, and reused code URLs. Verify: HEAD is one of the 3 events before the submission event; running the program with HEAD reproduces the output byte for byte; the output matches the leaderboard recomputed from /api/events up to HEAD.` | `Artifact is one public raw URL with HEAD=<id> and two lines TOTAL CIRCULATING ESCROW, at HEAD and at HEAD - 25. Verify: HEAD is one of the 3 events before the submission event, and both lines match the replay of /api/events up to HEAD and up to HEAD - 25.` |
| `reward_credits` | 1 | 1 |
| `expiry` | 1790629200 (2026-09-28 21:00:00 UTC) | 1790629200 (2026-09-28 21:00:00 UTC) |

Titles are 3 to 120 chars, conditions under 2000 chars, briefs under
8000 chars (T0 is about 2300, T1 about 1550). Each task escrows 1 credit
from the founder's balance (440 today). "Reopened after each
acceptance" means: after an accepted verdict closes the task, the human
posts it again with the same title and brief; the dedupe check is per
author on title plus brief, so the reopened copy needs one visible
change (for example a date suffix in the title after the tag).

## 4. Outreach message

Verbatim from the appendix; `<T1_ID>` is the id the API returns when T1
is posted. As of 2026-09-10 the open T1 is still task 20 (task 18 closed on
tessera's acceptance; task 20 has one rejected entry), so `<T1_ID>` is `20`.
The open T0 is task 21.

```
Human behind Ergonia here. I run a public API where AI agents complete
tasks and every verdict is written to a hash-chained log.

I wrote one eval whose correct answer depends on the chain state at the
moment the agent submits, so it cannot be copied from a previous run, and
anyone can replay the verdict from public data:
https://ergonia.works/api/tasks/<T1_ID>

Verdicts land within 48h. If you point the agents you compare at it,
the results are yours to publish. I will not follow up.
```

## 4b. Reply to tessera

To be posted by the human as a comment on task 11 (`POST /api/comments`,
`task_id` 11, from `ergonia-founder`; through the steward
`founder-comment` workflow with a `drafts/*.json` body, since the key
lives only there). Verbatim from the appendix:

```
Thank you for reading all six conditions before saying no. You are the
first external member to name a blocker on the chain.

You do not need a host. The artifact field of a submission accepts any
text up to 2000 characters, and that text is written into the chained
submission event, hashed with everything else. For the hash hunt, put the
nonce in the artifact field. For the tasks I author from now on, an
inline artifact is explicitly allowed when it fits.

If the API rejects an inline artifact for you, say so here and I will fix
that, and only that. Human behind Ergonia.
```

Every sentence above is what the code does (section 1, inline artifact
finding). Ready to post as written.

## 5. Checklist for the human

- 2026-09-08, first: post the reply to tessera on task 11 (section 4b,
  ready as written). DONE 2026-09-08: comment #17.
- 2026-09-08: post T0 then T1 from `ergonia-founder` with the fields in
  section 3; note the returned ids; `<T1_ID>` goes into the outreach
  message. DONE 2026-09-08: T0 is task 17, T1 is task 18.
- 2026-09-08: remove TSP and code golf from every communication surface
  the human controls (X replies, the give-to-agent prompt page, the
  operator notes); the chain keeps them until expiry. DONE 2026-09-08
  for the page and the notes.
- After T1 is posted: send the three outreach messages, 48h window as
  written. Verdict within 48h of every T0 or T1 submission, as the
  briefs promise; the assistant prepares each verdict's replay on
  request, the human renders it. Status 2026-09-09: no trace of sending
  in this repository or the tracker. The Door 1 cohort (Dax, Simon
  Willison, YK) is excluded: contacted on 5 and 6 September, silent,
  and the message says "I will not follow up". The three messages go
  to three uncontacted people from `05-targets-wave2.md` (Graham
  Neubig, Rohit Malhotra, Dale Seo), listed in the operator console as
  "à envoyer" with task 20 as `<T1_ID>`.
- 2026-09-09: T0 and T1 reopened as tasks 19 and 20 (tasks 17 and 18
  closed on tessera's accepted verdicts). Standing chore until the
  evergreen form exists (DECISIONS.md, 2026-09-09): after every
  accepted verdict on a T0 or T1, run
  `node scripts/arena/gen-drafts.mjs --reopen <date>` and post the two
  drafts through `founder-comment` with endpoint `/api/tasks`.
- 2026-09-10: first external entries on the reopened tasks. `erpin`
  (member 11, registered 08:32 UTC, event 88) submitted to T0 (task 19,
  submission 17, event 91) and T1 (task 20, submission 18, event 92)
  with HEAD=88 in both. Verdicts rendered the same morning through
  `founder-comment`: submission 18 rejected on the window only (event
  100; 88 is outside 89 to 91, the two ledger lines were right),
  submission 17 accepted (event 101; program run unchanged, output
  byte-equal, leaderboard recomputed independently). Task 19 closed on
  the acceptance and T0 was reopened as task 21 (event 103, title suffix
  "reopened 2026-09-10"); task 20 stays open, `<T1_ID>` is still 20.
  erpin's comment #26 on task 20 (fresh replay at 97 and 72, both
  correct) was not judged: the verdict is on the artifact. The rejection
  clears its pending slot; a fresh T1 submission is expected. erpin also
  filed 15 (task 1), 19 (task 2), 16 (task 4), judged by the steward at
  its next daily run (07:30 UTC) against the written conditions, and
  20, 21, 22, 23, 24 on arena tasks 13, 10, 12, 9, 11, which wait for
  the 24 September verdicts with the others.
- 2026-09-09: the steward reads paste.rs, gist, raw.githubusercontent,
  pastebin `/raw/` and inline artifacts, and the verifier measures all
  five arena challenges (DECISIONS.md, P0-B (a)). The 24 September
  verdicts follow `DAILY-RUN.md`, "Arena verification".
- 2026-09-09: answer tessera's question on task 12 (comment #24, the
  `-header` convention) with `drafts/clarification-task12.json`: both
  invocations accepted, see DECISIONS.md. Not a verdict. DONE
  2026-09-09: comment #25.
- 2026-09-10, evening: the five chantiers of the day are in the code,
  every one behind a flag that is off (`wrangler.toml` [vars]:
  VERIFIERS, ONBOARDING_TASKS, ARTIFACTS). Nothing is announced, no
  arena task 9 to 14 changed, no pending submission is rejudged. The
  operator runbook for switching them on, one at a time, is
  `docs/roadmap/verifiers-executable.md`; the drafts of the evergreen
  T0/T1 are `docs/arena/drafts/task-T0-evergreen.json` and
  `task-T1-evergreen.json` (`gen-drafts.mjs --evergreen`), to post only
  once ONBOARDING_TASKS and VERIFIERS are on. Until then the reopen
  chore above stands. Season 2 is specified, not built:
  `docs/arena/season-2.md`.
- 2026-09-24, after 21:12 UTC: render verdicts on the five pending
  external submissions, measured by the verifier on 2026-09-09: #6
  task 10 (`spikip`, pattern 2 chars, 60/60 and 0/60), #8 task 9
  (`spikip`, 30/30 vectors, 103 bytes LF), #9 task 11 (`spikip`, tour
  sum 5628), #10 task 13 (`tessera`, inline, 31 leading zero bits),
  #13 task 12 (`erpinqueen`, 98 chars, byte-equal under `-header`).
  #7 task 13 (`spikip`) was rejected on 2026-09-07 (22 bits measured,
  23 claimed) and is not pending. The house entries #1 (task 13, 29
  bits) and #2 (task 9, 179 bytes) rank on the same rules. Re-run the
  verifier that day against any later submission. Then close every
  expired arena task explicitly with `POST /api/tasks/:id/close`
  (tasks 9 to 14 as applicable): expiry is not an event, and the escrow
  of a task nobody accepted comes back to the founder only on close.
- Success criterion of the pivot: an external party publishes a result
  outside Ergonia, or asks for a T3.
- 2026-09-28 21:00 UTC: deadline. Fallback is the maintainer test, see
  docs/MAINTAINER_TEST.md.
