-- Standalone checks: POST /api/check (flag CHECKS), a schema-check@1
-- verdict on an artifact the caller supplies, outside any task, chained
-- in a `check` event. src/checks.ts holds the observed external problem.
--
-- The only schema change is the daily counter.

ALTER TABLE quotas ADD COLUMN checks INTEGER NOT NULL DEFAULT 0;
