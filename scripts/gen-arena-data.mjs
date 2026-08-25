// Deterministic generator for the arena-data/ challenge assets.
//
// Run once with `node scripts/gen-arena-data.mjs` from repo root. All
// four files are re-emitted from scratch using a fixed seeded PRNG so
// the outputs are byte-identical on every run — the founder can
// re-publish them without changing the challenge for participants.
//
// Files produced:
//   arena-data/arena-1-vectors.json
//   arena-data/arena-1-harness.js
//   arena-data/arena-2-A.json
//   arena-data/arena-2-B.json
//   arena-data/arena-3-matrix.json
//   arena-data/arena-4-dump.sql
//   arena-data/arena-4-expected.txt
//   arena-data/arena-4-question.md
//   arena-data/README.md

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "arena-data");
mkdirSync(OUT, { recursive: true });

function write(name, content) {
  const p = resolve(OUT, name);
  writeFileSync(p, content, { encoding: "utf8" });
  console.log("  wrote", name, `(${content.length} bytes)`);
}

// Mulberry32 seeded PRNG. Deterministic across Node versions.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// -----------------------------------------------------------------
// ARENA #1 — 30 ISO-8601 durations (subset PnDTnHnMnS, integers only)
// -----------------------------------------------------------------
{
  const rng = makeRng(42);
  const vectors = [];
  const seen = new Set();
  while (vectors.length < 30) {
    const d = rng() < 0.7 ? Math.floor(rng() * 400) : 0;
    const h = rng() < 0.7 ? Math.floor(rng() * 24) : 0;
    const m = rng() < 0.7 ? Math.floor(rng() * 60) : 0;
    const s = rng() < 0.7 ? Math.floor(rng() * 60) : 0;
    if (d === 0 && h === 0 && m === 0 && s === 0) continue;
    let input = "P";
    if (d) input += `${d}D`;
    if (h || m || s) {
      input += "T";
      if (h) input += `${h}H`;
      if (m) input += `${m}M`;
      if (s) input += `${s}S`;
    }
    if (seen.has(input)) continue;
    seen.add(input);
    const expected = d * 86400 + h * 3600 + m * 60 + s;
    vectors.push({ input, expected });
  }
  write("arena-1-vectors.json", JSON.stringify(vectors, null, 2) + "\n");

  const harness = `#!/usr/bin/env node
// ARENA #1 harness. Usage:
//   node arena-1-harness.js path/to/submission.js
// submission.js must export a function 'd' (default export or named)
// that maps an ISO-8601 duration string to total seconds (integer).
//
// Exit code 0 iff every one of the 30 vectors passes.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(HERE, "arena-1-vectors.json"), "utf8"));
const sub = process.argv[2];
if (!sub) { console.error("usage: node arena-1-harness.js <submission.js>"); process.exit(2); }
const mod = await import(pathToFileURL(resolve(process.cwd(), sub)).href);
const d = mod.d ?? mod.default;
if (typeof d !== "function") { console.error("submission must export 'd' (or default) as a function"); process.exit(2); }

let pass = 0, fail = 0;
for (const v of vectors) {
  let got;
  try { got = d(v.input); } catch (e) { got = "throw: " + (e && e.message); }
  if (got === v.expected) pass++;
  else { fail++; console.error(\`FAIL  \${v.input}  expected=\${v.expected}  got=\${got}\`); }
}
const bytes = readFileSync(resolve(process.cwd(), sub)).length;
console.log(\`passed=\${pass}/\${vectors.length}  fail=\${fail}  bytes=\${bytes}\`);
process.exit(fail === 0 ? 0 : 1);
`;
  write("arena-1-harness.js", harness);
}

// -----------------------------------------------------------------
// ARENA #2 — Two lists A (60) / B (60). Separable by: ends with 'e'.
// -----------------------------------------------------------------
{
  const rng = makeRng(1337);
  const cons = "bcdfghklmnprstvw";
  const vow = "aeiou";
  function word(len, endsWithE) {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += (i % 2 === 0 ? cons : vow)[Math.floor(rng() * (i % 2 === 0 ? cons.length : vow.length))];
    }
    if (endsWithE) {
      // ensure last char is 'e' (replace)
      out = out.slice(0, -1) + "e";
    } else if (out.endsWith("e")) {
      out = out.slice(0, -1) + pick(rng, "aiou".split(""));
    }
    return out;
  }
  const A = new Set();
  while (A.size < 60) A.add(word(5 + Math.floor(rng() * 6), true));
  const B = new Set();
  while (B.size < 60) {
    const w = word(5 + Math.floor(rng() * 6), false);
    if (!A.has(w)) B.add(w);
  }
  write("arena-2-A.json", JSON.stringify([...A], null, 2) + "\n");
  write("arena-2-B.json", JSON.stringify([...B], null, 2) + "\n");
}

// -----------------------------------------------------------------
// ARENA #3 — TSP-50 symmetric integer distance matrix (metric).
// Generated from 50 random points on [0,999]x[0,999], distances =
// round(euclidean).
// -----------------------------------------------------------------
{
  const rng = makeRng(2024);
  const N = 50;
  const pts = Array.from({ length: N }, () => [Math.floor(rng() * 1000), Math.floor(rng() * 1000)]);
  const mat = Array.from({ length: N }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = pts[i][0] - pts[j][0];
      const dy = pts[i][1] - pts[j][1];
      const d = Math.round(Math.sqrt(dx * dx + dy * dy));
      mat[i][j] = d;
      mat[j][i] = d;
    }
  }
  write("arena-3-matrix.json", JSON.stringify(mat) + "\n");
}

// -----------------------------------------------------------------
// ARENA #4 — SQLite dump of a synthetic events table + expected result
// for a stated question.
// -----------------------------------------------------------------
{
  const rng = makeRng(9001);
  const kinds = ["register", "task_created", "submission", "verdict", "credit_transfer", "comment"];
  const members = ["ada", "boris", "camille", "diego", "elin", "fatou", "gustav", "hina"];
  const rows = [];
  for (let i = 1; i <= 200; i++) {
    const kind = pick(rng, kinds);
    const member = pick(rng, members);
    let amount = 0;
    if (kind === "credit_transfer") amount = 5 + Math.floor(rng() * 45); // 5..49
    rows.push({ id: i, kind, member, amount, created_at: 1_700_000_000 + i * 100 });
  }
  let sql = "-- ARENA #4 synthetic events dump. Load into SQLite with:\n";
  sql += "--   sqlite3 arena4.db < arena-4-dump.sql\n\n";
  sql += "DROP TABLE IF EXISTS events;\n";
  sql += "CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, member TEXT, amount INTEGER, created_at INTEGER);\n";
  sql += "BEGIN;\n";
  for (const r of rows) {
    sql += `INSERT INTO events VALUES (${r.id},'${r.kind}','${r.member}',${r.amount},${r.created_at});\n`;
  }
  sql += "COMMIT;\n";
  write("arena-4-dump.sql", sql);

  // Question: "For each member, total credits gained from credit_transfer
  // events, top 10 members, ORDER BY total DESC, member ASC as tie-break."
  const totals = new Map();
  for (const r of rows) {
    if (r.kind !== "credit_transfer") continue;
    totals.set(r.member, (totals.get(r.member) ?? 0) + r.amount);
  }
  const sorted = [...totals.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).slice(0, 10);
  let expected = "member|total\n";
  for (const [m, t] of sorted) expected += `${m}|${t}\n`;
  write("arena-4-expected.txt", expected);

  const question = `# ARENA #4 — the question

Load the dump into a SQLite database (\`sqlite3 arena4.db < arena-4-dump.sql\`),
then produce byte-identical output for:

> For each member, list the total credits gained from events of kind
> \`credit_transfer\`. Return the top 10 members ordered by that total
> DESCENDING, breaking ties alphabetically on the member handle
> ASCENDING. Format: pipe-separated \`member|total\`, one row per line,
> with the header row \`member|total\` first. LF line endings, trailing
> newline present.

Your submission is a **single SQLite SELECT statement** at a public
raw URL. Byte-equal output vs \`arena-4-expected.txt\` = valid; shortest
valid query at expiry wins.
`;
  write("arena-4-question.md", question);
}

// -----------------------------------------------------------------
// README
// -----------------------------------------------------------------
{
  const readme = `# arena-data/

Reference data for Ergonia's arena challenges. Every asset in this folder
is generated deterministically by \`scripts/gen-arena-data.mjs\` — do not
edit by hand, re-run the script instead.

Each arena task's first comment (posted by the \`ergonia-founder\`
account) links directly to the raw GitHub URL of the file it needs.

| Task     | Files                                              |
|----------|----------------------------------------------------|
| ARENA #1 | arena-1-vectors.json, arena-1-harness.js           |
| ARENA #2 | arena-2-A.json, arena-2-B.json                     |
| ARENA #3 | arena-3-matrix.json                                |
| ARENA #4 | arena-4-dump.sql, arena-4-expected.txt, arena-4-question.md |
| ARENA #5 | (no data — pure SHA-256 leading-zero-bit hunt)     |
| ARENA #0 | (no data — build the arena leaderboard)            |

## Regenerating

\`\`\`bash
node scripts/gen-arena-data.mjs
\`\`\`

The generator uses fixed PRNG seeds (Mulberry32) so re-runs produce
byte-identical files.
`;
  write("README.md", readme);
}
