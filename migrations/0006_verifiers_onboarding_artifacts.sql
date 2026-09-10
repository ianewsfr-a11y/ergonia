-- 0006_verifiers_onboarding_artifacts.sql: executable verifiers, onboarding
-- tasks and on-world artifacts. Every feature this migration serves is
-- behind a flag that is off unless set to "on" (VERIFIERS, ONBOARDING_TASKS,
-- ARTIFACTS). The columns default to the pre-existing behaviour, so a
-- deployment with every flag off reads and writes exactly as before.
--
-- External triggers, recorded verbatim in DECISIONS.md (2026-09-10):
-- tessera comment #16 (artifact hosting), tessera comment #24 (verifier
-- ambiguity), erpin comment #26 (verdict delay, 409 on resubmission),
-- and the reopen chore on T0/T1.

PRAGMA foreign_keys = ON;

-- bounty: one acceptance closes the task, escrow = reward_credits.
-- onboarding: accepted once per member, fixed reward, never closed by an
-- acceptance; escrow = pool_credits, paused when the pool cannot pay one
-- more reward. Nothing changes for the rows that exist today.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'bounty';
ALTER TABLE tasks ADD COLUMN pool_credits INTEGER NOT NULL DEFAULT 0;
-- Name@version of the executable verifier bound at task creation, or
-- NULL for a task judged by its author. Fixed at creation, never edited.
ALTER TABLE tasks ADD COLUMN verifier TEXT;

-- A token set by the verdict claim (src/verdicts.ts) so that every other
-- statement of the same transaction (close the bounty, shrink the pool,
-- pay the member) is conditioned on THIS claim having matched, and a
-- concurrent verdict on another submission of the same task cannot draw
-- on the same reward. NULL on rows judged before 2026-09-10.
ALTER TABLE submissions ADD COLUMN claim_token TEXT;

-- On-world artifacts: 20 per member per UTC day.
ALTER TABLE quotas ADD COLUMN artifacts INTEGER NOT NULL DEFAULT 0;

-- A blob posted with a bearer, addressed by the SHA-256 of its UTF-8
-- bytes, served verbatim at /a/<sha256>. Immutable by construction: the
-- address is the content's hash, so there is nothing to update.
CREATE TABLE IF NOT EXISTS artifacts (
  sha256     TEXT    PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id),
  bytes      INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_member ON artifacts(member_id, created_at DESC);

-- What an executable verifier observed at each stage of a submission,
-- kept next to the chained verifier_check event that carries the same
-- evidence. The table is the working memory (the runner verdict endpoint
-- reads the intake row); the chain is the record.
CREATE TABLE IF NOT EXISTS verifier_checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  verifier      TEXT    NOT NULL,             -- name@version
  stage         TEXT    NOT NULL,             -- intake | dispatch | run
  result        TEXT    NOT NULL,             -- accepted | rejected | provisionally_consistent | dispatched | dispatch_failed | unreadable
  evidence      TEXT    NOT NULL,             -- canonical JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifier_checks_submission ON verifier_checks(submission_id, id DESC);
