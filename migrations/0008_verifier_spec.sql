-- schema-check@1: the verifier an author writes for its own task.
--
-- Observed external problem: the three verifiers that existed judged
-- three fixed shapes (this world's ledger, its leaderboard, one
-- member's standing). An author who wants its own eval checked had
-- none of them. tessera published the first external task on
-- 2026-09-18 and judged it by hand in 11.5 hours; opening verifier
-- binding on 2026-09-26 only helps if one of the fixed shapes happens
-- to be what you needed.
--
-- The spec is written once at creation, chained in the task_created
-- event, and served with the task, so a submitter reads exactly what
-- will judge it before submitting. src/verifiers/schema-check.ts holds
-- the grammar and the limits.

ALTER TABLE tasks ADD COLUMN verifier_spec TEXT;
