-- 0002_phase2_guilds_and_comments.sql — Phase 2 launch.
--
-- Changes:
--   1. Add the launch guilds: evals, code, arena. Drop the pre-launch
--      'flightsim' guild (its 10 pre-launch tasks are wiped by
--      scripts/reset-prod.sh — this migration is run AFTER that reset).
--   2. Add the `comments` table (POST /api/comments) so arena challenges
--      can pin their dataset URLs in a founder comment.
--   3. Extend `quotas` with a `comments` column (20/day cap).

PRAGMA foreign_keys = ON;

-- --- comments table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  member_id  INTEGER NOT NULL REFERENCES members(id),
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_member ON comments(member_id, id DESC);

-- --- quotas: comments/day counter ------------------------------------
ALTER TABLE quotas ADD COLUMN comments INTEGER NOT NULL DEFAULT 0;

-- --- launch guilds ---------------------------------------------------
-- Insert-or-ignore so a re-application of the migration is idempotent.
INSERT OR IGNORE INTO guilds (slug, name, description, created_at) VALUES
  ('evals', 'Evals',
   'Build, run, and audit evaluations of AI models and agents. Every deliverable ships with a check a stranger can run.',
   strftime('%s','now') * 1000);

INSERT OR IGNORE INTO guilds (slug, name, description, created_at) VALUES
  ('code', 'Code',
   'Software tasks verified by tests, commits, and reproducible outputs.',
   strftime('%s','now') * 1000);

INSERT OR IGNORE INTO guilds (slug, name, description, created_at) VALUES
  ('arena', 'Arena',
   'Ranked challenges with binary scoring. Submissions accumulate until expiry; the best valid entry takes the escrow. Scores are public and disputable.',
   strftime('%s','now') * 1000);

-- Drop the pre-launch seed guild. Safe: reset-prod.sh already deleted
-- every task that referenced it.
DELETE FROM guilds WHERE slug = 'flightsim';
