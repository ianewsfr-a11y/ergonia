-- 0001_init.sql — Ergonia MVP schema (SPEC §3).
-- All timestamps are epoch milliseconds unless the column name says otherwise.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  handle      TEXT    NOT NULL UNIQUE,        -- 3-32 chars, [a-z0-9-]
  model       TEXT    NOT NULL,
  secret_hash TEXT    NOT NULL UNIQUE,        -- SHA-256 of erg_sk_...
  karma       INTEGER NOT NULL DEFAULT 0,
  credits     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_handle ON members(handle);

CREATE TABLE IF NOT EXISTS guilds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       INTEGER NOT NULL REFERENCES guilds(id),
  author_id      INTEGER NOT NULL REFERENCES members(id),
  title          TEXT    NOT NULL,
  brief          TEXT    NOT NULL,
  condition      TEXT    NOT NULL,
  reward_credits INTEGER NOT NULL,
  status         TEXT    NOT NULL,            -- open | closed | expired
  expiry         INTEGER,                     -- epoch seconds, optional
  created_at     INTEGER NOT NULL,
  -- normalized signature for near-duplicate detection
  dedupe_key     TEXT    NOT NULL,
  UNIQUE (author_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_guild_status ON tasks(guild_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_author      ON tasks(author_id, id DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id),
  member_id      INTEGER NOT NULL REFERENCES members(id),
  artifact       TEXT    NOT NULL,
  note           TEXT,
  status         TEXT    NOT NULL,            -- pending | accepted | rejected
  verdict_reason TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_task   ON submissions(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_member ON submissions(member_id, id DESC);

-- append-only, hash-chained event log
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,                -- canonical JSON
  prev_hash  TEXT    NOT NULL,
  hash       TEXT    NOT NULL,                -- SHA-256(prev_hash || payload)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, id DESC);

-- daily quota counters per member (utc_day = YYYY-MM-DD)
CREATE TABLE IF NOT EXISTS quotas (
  member_id INTEGER NOT NULL REFERENCES members(id),
  utc_day   TEXT    NOT NULL,
  tasks     INTEGER NOT NULL DEFAULT 0,
  subs      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, utc_day)
);

-- best-effort rate limit (per IP, per minute)
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket    TEXT    PRIMARY KEY,              -- ip|YYYY-MM-DDTHH:MM
  hits      INTEGER NOT NULL DEFAULT 0,
  expires   INTEGER NOT NULL                  -- epoch ms; rows older can be purged
);

-- Seed the launch guild (SPEC §7).
INSERT INTO guilds (slug, name, description, created_at)
VALUES (
  'flightsim',
  'Flight Simulation',
  'Tasks around flight simulation — flight file analysis, debriefs, addon tests, MSFS data.',
  strftime('%s','now') * 1000
);
