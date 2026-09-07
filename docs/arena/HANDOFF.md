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
external-user problem in the sense of CLAUDE.md. Recorded here only;
nothing was built (hard constraint: no new endpoint). It should shape
the T0 to T2 conditions: an artifact rule that admits a comment on the
task itself, or a chain event, as the artifact would let this member
in without any new surface.

## 2. Not done under the constraints

- **The appendix was not in the mission text** (the message ends on the
  placeholder "[paste here, unchanged: ...]"). Without it: `T0.md`,
  `T1.md`, `T2.md` were not created (the rule was to paste the approved
  briefs unmodified, so writing them would have meant inventing them);
  the DECISIONS.md entry from the appendix was not appended (an entry in
  the repository's own words was written instead, with the requested
  correction and the schedule line); the outreach message was not
  copied; the `verify.mjs` skeleton was not available, so the harness
  was written from the mission's own description of the rules.
- **T2 rule order is therefore ASSUMED** in `scripts/arena/verify.mjs`:
  window FIRST_ID..HEAD ascending; record `{id, kind, created_at,
  payload, prev_hash, hash}` with `created_at` as ISO 8601 UTC truncated
  to the second; canonical JSON (sorted keys at every depth, no
  whitespace); LF-joined, no trailing newline; SHA-256 hex. Artifact
  format assumed: lines `FIRST_ID=`, `HEAD=`, `SHA256=`. If the brief
  says otherwise, the harness and the recorded hash must be redone
  before T2 is posted.
- Sample window recorded with those rules: FIRST_ID 1, SAMPLE_HEAD 40
  (a sealed verdict event), SHA-256
  `a37645be7ae677fc6497af809961a9ba67435dced727bf2f712e7ec777829ec5`,
  identical offline and through the live API. Permalink of the harness:
  `https://github.com/ianewsfr-a11y/ergonia/blob/702a2fb/scripts/arena/verify.mjs`
  (commit of step 2 on this branch; the `main` permalink exists only
  after merge).
- `DECISIONS.md` already contains 93 em-dashes in older entries. The
  new entry has none. The existing test covers served surfaces only
  (door, llms.txt, /api/official, /api/arena, /journeyman); it does not
  read docs. The new files under `docs/arena/` and `scripts/arena/`
  were checked by hand: zero em-dashes.
- The leaderboard has no test of its own; its replay reuses the tested
  ledger helpers. Today it renders one placeholder row: no tiered task
  exists yet.
- Disabling the ambassador and journeyman schedules required commits on
  those repositories' `main` (a workflow only takes effect there):
  ambassador `1de2fa9`, journeyman nightly `5172489`, MAG watch
  `c1e1c00` (written through the Contents API; the local checkouts of
  those two repositories are behind their remote). Manual dispatch kept
  on all three.

## 3. Task texts and fields

The exact brief texts arrive with the appendix and are pasted as-is
with these corrections only:

- Every Context block, the Goal of T1, the Source data of T2: replace
  "immediately before your own submission event" or "ends at the event
  immediately preceding" with "at HEAD, one of the 3 events immediately
  preceding your submission event".
- T1: second output line `TOTAL CIRCULATING ESCROW` at event `HEAD - 25`;
  Acceptance says both lines must match the replay. Escrow stays in
  both lines (it is reconstructible, see 1c).
- T2: FIRST_ID = 1, SAMPLE_HEAD = 40, SHA-256 as above, permalink as
  above.

Fields to set when posting (`POST /api/tasks`, as `ergonia-founder`):

| Field | Constraint from code | Proposal |
| --- | --- | --- |
| `guild` | slug | `arena` |
| `title` | 3 to 120 chars, must contain the tier tag | `[EVAL-API-0] ...`, `[EVAL-CHAIN-1] ...`, `[EVAL-TRANSFORM-2] ...` |
| `brief` | 10 to 8000 chars | the appendix text with the corrections above |
| `condition` | 10 to 2000 chars; must mention an artifact word (url, hash, sha256, file, json, endpoint...) and a control verb (verify, matches, equals, returns...) or the API refuses it with 400 | for T2: "Artifact is a public text URL with lines FIRST_ID=, HEAD=, SHA256=. Verify with node scripts/arena/verify.mjs FIRST_ID HEAD ARTIFACT_URL SUBMISSION_ID: PASS iff the SHA256 line equals the harness output and HEAD is one of the 3 events before the submission event." |
| `reward_credits` | 1 to 10000, escrowed from the founder's balance (440 today) | as in the appendix; if absent, 20 / 40 / 60 |
| `expiry` | epoch seconds, future | 1790629200 (2026-09-28 21:00:00 UTC) |

A comment-only artifact rule (see the `tessera` finding) would read, for
T0: "Artifact may be `comment:<id>` for a comment on this task whose
body contains the required line; verify by GET /api/tasks/<id>/comments."

## 4. Outreach message

Not supplied (appendix missing). To be pasted here verbatim, with
`<T1_ID>` left as a placeholder and "48h" as written.

## 5. Checklist for the human

- 2026-09-08: paste the appendix; the assistant creates `T0.md`,
  `T1.md`, `T2.md` with the corrections, redoes the T2 hash if the rule
  order differs, and updates this handoff. Then post T0, T1, T2 from
  `ergonia-founder` (through the steward `founder-comment` pattern or
  the key, whichever exists that day), with the fields above.
- 2026-09-08: remove TSP and code golf from every communication surface
  the human controls (X replies, the give-to-agent prompt page, the
  operator notes); the chain keeps them until expiry.
- 2026-09-08: answer `tessera` on task 11 if the human wants to (a
  comment, from the founder); the assistant drafts it on request.
- 2026-09-24, after 21:12 UTC: render verdicts on the four pending
  external submissions (#6 task 10, #7 task 13, #8 task 9, #9 task 11,
  all by `spikip`; #9 already re-verified, sum 5628). Accepting one pays
  its reward from escrow and closes that task.
- Once `<T1_ID>` is known: send the three outreach messages, 48h window
  as written.
- 2026-09-28: deadline. If no external member has passed T1 by then,
  fallback: the maintainer test (the human runs T0 to T2 with a
  non-house account and records the result on the leaderboard as a
  house pass, marked as such).
