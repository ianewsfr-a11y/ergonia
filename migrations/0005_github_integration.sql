-- 0005_github_integration.sql: G1 GitHub integration, house dogfood only.
--
-- Named exception to the external-user rule (see CLAUDE.md). The
-- integration is disabled by default (GITHUB_INTEGRATION unset or not
-- "on") and fails closed on a server-side allowlist of two Ergonia-owned
-- repositories, matched by immutable GitHub ids AND full name.
--
-- No secret lives in these tables. The App's private key and its single
-- webhook secret are Worker secrets.

PRAGMA foreign_keys = ON;

-- One row per installation of the App. Recorded on installation.created
-- only when the installing account is the allowlisted owner; every other
-- installation is ignored without a row.
CREATE TABLE IF NOT EXISTS github_installations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL UNIQUE,   -- GitHub's own id
  account_id      INTEGER NOT NULL,          -- GitHub's account id (immutable)
  account_login   TEXT    NOT NULL,          -- login as returned by GitHub
  account_type    TEXT    NOT NULL,          -- 'User' | 'Organization'
  installed_at    INTEGER NOT NULL,
  removed_at      INTEGER                    -- installation.deleted
);

-- One row per opening of a task from a labelled issue. Re-adding the
-- label after a close inserts a NEW row (task ids are never reused).
-- At most one OPEN row per (repo, issue): the partial unique index below
-- is what makes a repeated `labeled` delivery unable to open a second
-- task, whatever its delivery id.
CREATE TABLE IF NOT EXISTS github_issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id  INTEGER NOT NULL,         -- GitHub's installation id
  repo_id          INTEGER NOT NULL,         -- GitHub's repository id (immutable)
  repo_full_name   TEXT    NOT NULL,         -- 'owner/repo' at opening time
  issue_number     INTEGER NOT NULL,
  issue_url        TEXT    NOT NULL,
  base_branch      TEXT    NOT NULL,         -- repository default branch at opening
  required_checks  TEXT    NOT NULL,         -- JSON array of check-run names seen on base_branch at opening
  task_id          INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
  delivery_id      TEXT    NOT NULL,         -- the webhook delivery that opened it
  opened_at        INTEGER NOT NULL,
  closed_at        INTEGER,
  close_reason     TEXT                      -- accepted | label_removed | issue_closed | issue_deleted | repo_removed | installation_removed
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issues_one_open
  ON github_issues(repo_id, issue_number) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_github_issues_repo ON github_issues(repo_id, closed_at);

-- Every accepted webhook delivery, by GitHub's delivery GUID. A repeated
-- delivery is answered 200 without touching anything else. A delivery
-- whose processing throws has its row deleted before the 500 goes out,
-- so GitHub's retry (same GUID) is processed again; the natural keys on
-- github_issues and github_comments keep that re-run idempotent.
CREATE TABLE IF NOT EXISTS github_deliveries (
  delivery_id TEXT    PRIMARY KEY,
  event       TEXT    NOT NULL,
  action      TEXT,
  received_at INTEGER NOT NULL,
  outcome     TEXT    NOT NULL                -- 'processing' | 'processed' | 'ignored'
);

-- Last check-run set the verifier read per (submission, head sha).
-- Not the source of truth (GitHub is); a rate-limit cushion and the
-- cool-off clock. Evictable at will.
CREATE TABLE IF NOT EXISTS github_check_snapshots (
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  head_sha      TEXT    NOT NULL,
  fetched_at    INTEGER NOT NULL,
  verdict_hint  TEXT    NOT NULL,             -- 'green' | 'red' | 'pending'
  raw_json      TEXT    NOT NULL,
  PRIMARY KEY (submission_id, head_sha)
);

-- Every comment the App posted on a GitHub issue. One per state
-- transition; the unique key is what makes a re-run after a partial
-- failure unable to post the same transition twice.
CREATE TABLE IF NOT EXISTS github_comments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  github_issue_id   INTEGER NOT NULL REFERENCES github_issues(id),
  kind              TEXT    NOT NULL,         -- opened | submission | accepted | rejected | expired | label_removed
  ref               INTEGER NOT NULL DEFAULT 0, -- submission id for per-submission kinds, else 0
  github_comment_id INTEGER,
  posted_at         INTEGER NOT NULL,
  UNIQUE (github_issue_id, kind, ref)
);
