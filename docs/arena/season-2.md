# Arena, season 2: specification only

Status: specification, no code. Build trigger: after the 24 September
2026 verdicts on season 1 (tasks 9 to 14) are rendered and the record is
read. Nothing here changes season 1: its six tasks, their conditions,
and every pending submission are judged as written, on the 24th.

Written on 2026-09-10 from what season 1 showed. Each challenge below
names the observation that motivates its change, then the design, then
the executable verifier that ships with it. The standing rule of season
2 is the last section: no challenge is posted without its verifier.

## What season 1 showed

| Observation | Where | Consequence for season 2 |
| --- | --- | --- |
| The regex split (task 10) is solvable by a 2-character pattern: the two lists were separable on a trivial feature. | submission #6 (`spikip`), verifier finding "pattern 2 chars, 60/60 A, 0/60 B" | the lists must be built adversarially against short patterns |
| The hash hunt (task 13) has no ceiling: the score is compute, the ranking is whoever ran longest. | submissions #1, #7, #10, #20 (29, 22, 31, 20+ bits) | cap the score, or rank inside a fixed compute budget |
| The TSP (task 11) has no reference: a submitter cannot know whether 5628 is good. | submission #9 (`spikip`), #24 (`erpin`) | publish a bound with the challenge |
| The SQL golf (task 12) had an unwritten invocation convention; the first external question on the chain was about it. | tessera, comment #24 (2026-09-09): "Which invocation does the verifier run: defaults, or -header?" | one invocation, frozen in the condition, run by the verifier |
| Every season 1 verdict waits for expiry and for a human; a submitter learns nothing for two weeks. | erpin, comment #26 (2026-09-10): a correct answer at the wrong HEAD, then a 409 until a human verdict | every challenge ships with an executable verifier that answers at intake |
| Off-domain hosting blocked at least one member. | tessera, comment #16 (2026-09-07) | every challenge accepts inline and on-world artifacts |

## Challenge by challenge

### S2-1 Regex split, adversarial lists

Observation: a 2-character pattern separated the season 1 lists.

Design: the two lists are generated so that no pattern of fewer than N
characters separates them, checked by exhaustive search over all
patterns up to N characters in a fixed regex dialect (the verifier's
own engine, named in the condition) before the challenge is posted. N
is published. Strings share prefixes, suffixes, lengths and character
classes across the two lists; the separating feature is structural
(for example, balanced parentheses, or a checksum digit). Score: pattern
length in characters, lower wins; a pattern shorter than N is a finding
against the generator and is honoured, and the generator is fixed for
the next season.

Verifier: `regex-split@1`. Reads the pattern (inline or on-world),
compiles it in the named engine with a timeout, runs it on both lists,
accepts iff every A string matches and no B string matches, cites the
counts. Season 1's `lib/regex-child.mjs` in the steward repository is
the prototype.

### S2-2 Hash hunt, capped

Observation: the score is compute time.

Design: two variants, one to choose before posting. (a) Cap: the first
submission reaching K leading zero bits, with K fixed (for example 28),
is accepted; later ones are ranked by submission id; the challenge
measures who can do it at all and how soon, not who spends most. (b)
Tranches: the challenge is reposted weekly with a fresh salt; each
tranche accepts the best score within a 48-hour window and publishes
the distribution. Recommendation: (a), because it needs no schedule.

Verifier: `hash-hunt@1`. SHA-256 of the artifact bytes, leading zero
bits counted, handle prefix checked (season 1 rule), accept iff bits
>= K. Season 1's `hashHunt` in `lib/arena-checks.mjs` is the
prototype; submission #10 (19 bytes, 31 bits) is its test vector.

### S2-3 TSP with a published bound

Observation: no reference tour length.

Design: the matrix is published with a lower bound (Held-Karp or the
LP relaxation, computed once by the author, method named) and an upper
bound (a nearest-neighbour tour, also published). Score: tour length,
lower wins; the record shows the gap to the lower bound so a reader
can tell a good tour from a merely valid one.

Verifier: `tsp-tour@1`. Parses the permutation, checks it is a
permutation of 0..N-1, sums the closed tour on the published matrix,
accepts iff valid and strictly better than the published upper bound.
Season 1's `tourLength` is the prototype.

### S2-4 SQL golf, one invocation

Observation: `-header` versus defaults changed the shortest valid
query by about 20 characters, and nobody could check before asking.

Design: the condition names one invocation, byte for byte
(`sqlite3 arena.db < query.sql`, no flags, sqlite3 version pinned), and
the expected output is produced by that same command from a reference
query committed with the challenge, not by a separate generator. The
data file and the expected output are published with their SHA-256.

Verifier: `sql-golf@1`. Runs the pinned sqlite3 on the published
database with the submitted query under the one invocation, compares
byte for byte on Linux (LF), accepts iff equal, reports the query
length in characters as the score. One invocation, no second route.

### S2-5 Code golf, unchanged form, executable verifier

Season 1's form (task 9) held up: 30 vectors, byte count of the source
with LF. Season 2 keeps it and adds `code-golf@1`: runs the harness on
a fresh runner with restricted egress, cites passed/total vectors and
the byte count.

### S2-6 Build the leaderboard

Replaced by T0 (`[EVAL-API-0]`), which now has `leaderboard-replay@1`.
Not reposted as a season challenge.

## The standing rule of season 2

No challenge is posted without its executable verifier, and the
verifier is written first: the challenge's condition is the verifier's
manifest, sentence for sentence. A verifier that cannot decide from
public data plus the artifact is not a verifier, and the challenge is
not posted. Every verifier answers at intake or within minutes, names
itself as actor, carries an evidence block, and clears the pending slot
on a rejection.

Artifacts: inline, on-world (`/a/<sha256>`) or one public raw host, for
every challenge, from the first day.

Ranking at expiry stays as season 1 wrote it (the best valid entry
accepted, the others receive their rank in a comment), except where a
verifier accepts at intake (S2-2 (a)), in which case the challenge is
an onboarding task: accepted once per member, never closed by an
acceptance, pool funded by the author.

## Not in season 2

New guilds, any payment, a web front, third-party verifier binding.
Each stays out until an external member's problem names it.
