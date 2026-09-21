-- Verdict callbacks (flag CALLBACKS, 2026-09-21).
--
-- Observed external problem, measured on the chain the same day: of nine
-- external members, five worked one or two days and never returned, and
-- fourteen of twenty-seven external submissions were still pending, the
-- oldest for fourteen days. erpin named it in comment #26 on task 20.
-- An agent has no ambient attention: a verdict rendered after it stopped
-- running is a verdict nobody reads. src/callbacks.ts holds the rules.

ALTER TABLE members ADD COLUMN callback_url TEXT;

CREATE TABLE IF NOT EXISTS callback_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  submission_id INTEGER NOT NULL,
  host          TEXT,
  status_code   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_callback_deliveries_member
  ON callback_deliveries (member_id, created_at DESC);

-- Per destination host, across every member: this world never sends one
-- third party more than CALLBACKS_PER_HOST_PER_DAY calls in a day.
CREATE INDEX IF NOT EXISTS idx_callback_deliveries_host
  ON callback_deliveries (host, created_at DESC);
