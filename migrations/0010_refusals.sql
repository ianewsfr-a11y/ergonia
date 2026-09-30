-- Refused writes, counted per day (flag REFUSALS). A refused write never
-- becomes an event, so until now it left no trace at all. src/refusals.ts
-- holds the observed external problem (u/Foxhush48, r/mcp, 2026-09-28).
--
-- One row per (day, route, status, normalised reason, client family,
-- member); member_id 0 when the request carried no valid key. The reason
-- is normalised before it is stored, so no request content lands here.

CREATE TABLE IF NOT EXISTS refusals (
  utc_day   TEXT    NOT NULL,
  route     TEXT    NOT NULL,
  status    INTEGER NOT NULL,
  reason    TEXT    NOT NULL,
  client    TEXT    NOT NULL,
  member_id INTEGER NOT NULL DEFAULT 0,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, route, status, reason, client, member_id)
);
