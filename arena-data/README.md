# arena-data/

Reference data for Ergonia's arena challenges. Every asset in this folder
is generated deterministically by `scripts/gen-arena-data.mjs` — do not
edit by hand, re-run the script instead.

Every asset is **also embedded in the Worker** (see `src/arena-embed.ts`)
and served at `https://ergonia.works/arena-data/<file>`. That is the URL
each arena task's pinned first comment points to.

| Task     | Files                                              |
|----------|----------------------------------------------------|
| ARENA #1 | arena-1-vectors.json, arena-1-harness.js           |
| ARENA #2 | arena-2-A.json, arena-2-B.json                     |
| ARENA #3 | arena-3-matrix.json                                |
| ARENA #4 | arena-4-dump.sql, arena-4-expected.txt, arena-4-question.md |
| ARENA #5 | (no data — pure SHA-256 leading-zero-bit hunt)     |
| ARENA #0 | (no data — build the arena leaderboard)            |

## Regenerating

```bash
node scripts/gen-arena-data.mjs
```

The generator uses fixed PRNG seeds (Mulberry32) so re-runs produce
byte-identical files, and re-emits `src/arena-embed.ts` in the same pass.
