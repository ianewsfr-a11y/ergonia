# Arena pivot handoff (branch `arena-pivot`, 2026-09-07)

Prepared by the assistant for the human. Nothing here has been posted or
sent. Every write below is a file in this branch or a workflow schedule
in the ambassador and journeyman repositories; the production API was
only read.

## 1. Findings from step 1

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

Because (a) fails, the comment-as-artifact paragraph was not added to
T0 or T1, and the last paragraph of the tessera reply (section 4b) says
something the code does not do.

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
is posted.

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

You already have most of what you describe. A comment on a task is stored
in the chained event, hashed with everything else, under this domain. For
any task I author, an artifact may be a comment on that task: post the
blob as a comment, then submit with the artifact URL
https://ergonia.works/api/tasks/<task_id>/comments and your comment id in
the note. I judge on the comment body. For the hash hunt, the nonce is
the whole artifact.

If the submit endpoint rejects that URL for you, say so here and I will
fix that, and only that. Human behind Ergonia.
```

Step 1(a) failed: the sentence "A comment on a task is stored in the
chained event, hashed with everything else" is not what the code does
(the event chains the comment's id and author; the body is a table row
served by the comments endpoint). Adjust that sentence before posting;
1(c) passed, so the "submit with the artifact URL" instruction and the
last paragraph stand as written.

## 5. Checklist for the human

- 2026-09-08, first: post the reply to tessera on task 11, after fixing
  the one sentence flagged in 4b.
- 2026-09-08: post T0 then T1 from `ergonia-founder` with the fields in
  section 3; note the returned ids; `<T1_ID>` goes into the outreach
  message.
- 2026-09-08: remove TSP and code golf from every communication surface
  the human controls (X replies, the give-to-agent prompt page, the
  operator notes); the chain keeps them until expiry.
- After T1 is posted: send the three outreach messages, 48h window as
  written. Verdict within 48h of every T0 or T1 submission, as the
  briefs promise; the assistant prepares each verdict's replay on
  request, the human renders it.
- 2026-09-24, after 21:12 UTC: render verdicts on the four pending
  external submissions (#6 task 10, #7 task 13, #8 task 9, #9 task 11,
  all by `spikip`; #9 already re-verified, sum 5628). Then close every
  expired arena task explicitly with `POST /api/tasks/:id/close`
  (tasks 9 to 14 as applicable): expiry is not an event, and the escrow
  of a task nobody accepted comes back to the founder only on close.
- Success criterion of the pivot: an external party publishes a result
  outside Ergonia, or asks for a T3.
- 2026-09-28 21:00 UTC: deadline. If the criterion is not met, fallback
  is the maintainer test: the human runs T0 and T1 as a maintainer would,
  from the public documents only, records what blocked and how long each
  took, and that record (not a pass on the leaderboard) decides whether
  the tiers stay as written.
