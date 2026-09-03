-- 0004_fix_ffdd_titles.sql
--
-- Fix Unicode replacement character (U+FFFD, "�") that landed in
-- the founding tasks during the 2026-08 seed run. The source file
-- seed/founding-tasks.json used em-dash (U+2014) in eight places; the
-- bytes got mangled during the seed pipeline (bash + node + curl on a
-- Windows shell); the API stored the resulting U+FFFD as-is and has
-- been serving it ever since.
--
-- Diagnosed 2026-09-03 by an external auditor (Josh, Phase 0 audit of
-- Project Palinode) plus one supporting observation from a second
-- external operator. Two independent external observations, per the
-- CLAUDE.md rule that gates any product change on named external-user
-- evidence.
--
-- IMPORTANT: this migration touches only the `tasks` table (title,
-- condition, brief columns). It does NOT insert into `events`, and it
-- does NOT reset any chain state. The append-only event register keeps
-- the historical corrupted values on record; the served surface now
-- reflects the intended text. A reader who wants to see the original
-- corruption trace can still find it in the events (task_created rows
-- carry the title snapshot at creation time).
--
-- Separator choice per CLAUDE.md ("no em-dash on public surfaces"):
--   - Arena titles use ':' (title separator)
--   - Task 10 condition uses ',' between clauses
--   - Task 2 brief uses ';' between clauses
--
-- Idempotent: SQLite `replace()` is a no-op if the needle is absent, so
-- re-running this migration after the first pass leaves the strings
-- unchanged. A later migration can add an assertion once we introduce a
-- migration-level check helper; for now the anti-regression test in
-- test/p0a-surfaces.test.ts asserts no U+FFFD survives on any public
-- surface.

-- Fix the six ARENA titles: 'ARENA #N � X' -> 'ARENA #N: X'
UPDATE tasks
   SET title = replace(title, ' ' || char(65533) || ' ', ': ')
 WHERE title LIKE 'ARENA %' || char(65533) || '%';

-- Fix task 10 condition (ARENA #2, regex on two lists):
-- 'list B � a stranger' -> 'list B, a stranger'
UPDATE tasks
   SET condition = replace(
     condition,
     'list B ' || char(65533) || ' a stranger',
     'list B, a stranger'
   )
 WHERE id = 10;

-- Fix task 2 brief (Prompt-injection test suite):
-- 'real systems � the suite' -> 'real systems; the suite'
UPDATE tasks
   SET brief = replace(
     brief,
     'real systems ' || char(65533) || ' the suite',
     'real systems; the suite'
   )
 WHERE id = 2;
