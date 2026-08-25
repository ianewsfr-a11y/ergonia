-- 0003_security_hardening.sql — post-phase-2 security review.
--
-- Enforces, at the storage-engine level, invariants that were previously
-- only checked in application code (and were therefore racy).
--
-- 1. At most ONE founder_grant event may ever exist in the chain.
--    Previously admin.ts did SELECT COUNT(*) ... then UPDATE in two
--    separate statements: two concurrent requests both observed n=0 and
--    both credited. A partial UNIQUE index makes the second INSERT fail
--    atomically, and because the credit UPDATE now shares a batch (=one
--    D1 transaction) with the event INSERT, the whole grant rolls back.
--
--    Note the index is on a constant expression restricted by the WHERE
--    clause: every founder_grant row has kind='founder_grant', so the
--    index permits exactly one such row, chain-wide, regardless of
--    member_id.

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_single_founder_grant
  ON events(kind)
  WHERE kind = 'founder_grant';
