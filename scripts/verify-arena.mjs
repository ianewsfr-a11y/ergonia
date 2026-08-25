// Verifies that every arena challenge's served data actually satisfies
// what its task condition promises. Run against any base URL:
//
//   node scripts/verify-arena.mjs                      # https://ergonia.works
//   node scripts/verify-arena.mjs http://127.0.0.1:8787
//
// Exit code 0 iff every check passes. This is the script behind the
// phase-2 security review's §3b, kept in the repo so the assertion can
// be re-run after any regeneration of arena-data/.

const BASE = (process.argv[2] || "https://ergonia.works").replace(/\/+$/, "");
const DATA = `${BASE}/arena-data`;

let failures = 0;
function check(label, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${label}${detail ? " — " + detail : ""}`);
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

async function get(path) {
  const res = await fetch(`${DATA}/${path}`);
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
}

// ── ARENA #1 — 30 ISO-8601 vectors + harness ────────────────────────
section("ARENA #1 — ISO-8601 duration vectors + harness");
{
  const v = await get("arena-1-vectors.json");
  check("arena-1-vectors.json responds 200", v.status === 200, `status=${v.status}`);
  check("served as JSON", v.contentType.includes("application/json"), v.contentType);
  const vectors = JSON.parse(v.text);
  check("exactly 30 vectors (condition says 30)", vectors.length === 30, `got ${vectors.length}`);

  // Reference implementation of the challenge, used to prove the
  // published expectations are self-consistent.
  const ref = (s) => {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
    if (!m) return NaN;
    return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
  };
  const bad = vectors.filter((x) => ref(x.input) !== x.expected);
  check("every expected value matches a reference parse", bad.length === 0,
    bad.length ? `${bad.length} mismatched, e.g. ${JSON.stringify(bad[0])}` : "30/30");
  const uniq = new Set(vectors.map((x) => x.input));
  check("no duplicate input vectors", uniq.size === vectors.length, `${uniq.size} unique`);
  check("all inputs parse as the documented subset PnDTnHnMnS",
    vectors.every((x) => Number.isFinite(ref(x.input))));

  const h = await get("arena-1-harness.js");
  check("arena-1-harness.js responds 200", h.status === 200, `status=${h.status}`);
  check("harness is served as JavaScript", h.contentType.includes("javascript"), h.contentType);
  check("harness reads arena-1-vectors.json", h.text.includes("arena-1-vectors.json"));
  check("harness exits non-zero on failure", /process\.exit\(fail === 0 \? 0 : 1\)/.test(h.text));
  check("harness reports a byte count (the score)", h.text.includes("bytes="));
}

// ── ARENA #2 — lists A/B ────────────────────────────────────────────
section("ARENA #2 — separable string lists");
{
  const a = await get("arena-2-A.json");
  const b = await get("arena-2-B.json");
  check("arena-2-A.json responds 200", a.status === 200, `status=${a.status}`);
  check("arena-2-B.json responds 200", b.status === 200, `status=${b.status}`);
  const A = JSON.parse(a.text);
  const B = JSON.parse(b.text);
  check("list A has exactly 60 strings (brief says 60)", A.length === 60, `got ${A.length}`);
  check("list B has exactly 60 strings (brief says 60)", B.length === 60, `got ${B.length}`);
  check("A entries are unique", new Set(A).size === A.length);
  check("B entries are unique", new Set(B).size === B.length);
  const overlap = A.filter((s) => B.includes(s));
  check("A and B are disjoint (challenge is solvable at all)", overlap.length === 0,
    overlap.length ? `overlap: ${overlap.slice(0, 3).join(",")}` : "no overlap");

  // A separating regex must exist, otherwise the task is impossible.
  const witness = /e$/;
  const matchesAllA = A.every((s) => witness.test(s));
  const matchesNoB = B.every((s) => !witness.test(s));
  check("a separating ECMAScript regex exists (witness /e$/)", matchesAllA && matchesNoB,
    `A all-match=${matchesAllA} B none-match=${matchesNoB}`);
}

// ── ARENA #3 — TSP-50 matrix ────────────────────────────────────────
section("ARENA #3 — TSP-50 distance matrix");
{
  const m = await get("arena-3-matrix.json");
  check("arena-3-matrix.json responds 200", m.status === 200, `status=${m.status}`);
  const M = JSON.parse(m.text);
  check("matrix has 50 rows (condition says 50 nodes)", M.length === 50, `got ${M.length}`);
  check("every row has 50 columns", M.every((r) => r.length === 50));
  check("all distances are integers", M.every((r) => r.every((x) => Number.isInteger(x))));
  check("diagonal is zero", M.every((r, i) => r[i] === 0));
  let symmetric = true;
  for (let i = 0; i < M.length && symmetric; i++)
    for (let j = 0; j < M.length; j++) if (M[i][j] !== M[j][i]) { symmetric = false; break; }
  check("matrix is symmetric (condition says symmetric)", symmetric);
  check("off-diagonal distances are positive", M.every((r, i) => r.every((x, j) => i === j || x > 0)));

  // A trivial identity tour must be scorable — proves the scoring rule
  // in the condition is computable from the published matrix alone.
  const tour = Array.from({ length: 50 }, (_, i) => i);
  let len = 0;
  for (let i = 0; i < tour.length; i++) len += M[tour[i]][tour[(i + 1) % tour.length]];
  check("a closed tour is scorable from the matrix", Number.isInteger(len) && len > 0,
    `identity tour length = ${len}`);
}

// ── ARENA #4 — SQLite dump + expected output ────────────────────────
section("ARENA #4 — SQL golf dump vs expected result");
{
  const d = await get("arena-4-dump.sql");
  const e = await get("arena-4-expected.txt");
  const q = await get("arena-4-question.md");
  check("arena-4-dump.sql responds 200", d.status === 200, `status=${d.status}`);
  check("arena-4-expected.txt responds 200", e.status === 200, `status=${e.status}`);
  check("arena-4-question.md responds 200", q.status === 200, `status=${q.status}`);
  check("dump creates the events table", /CREATE TABLE events/.test(d.text));

  // Re-derive the expected result from the dump, in plain JS, exactly as
  // the question states it: sum credit_transfer amounts per member,
  // top 10, total DESC then member ASC, pipe-separated with a header.
  const rows = [...d.text.matchAll(/INSERT INTO events VALUES \((\d+),'([^']*)','([^']*)',(\d+),(\d+)\);/g)]
    .map((m) => ({ id: +m[1], kind: m[2], member: m[3], amount: +m[4], created_at: +m[5] }));
  check("dump parses into rows", rows.length > 0, `${rows.length} rows`);
  const totals = new Map();
  for (const r of rows) {
    if (r.kind !== "credit_transfer") continue;
    totals.set(r.member, (totals.get(r.member) ?? 0) + r.amount);
  }
  const sorted = [...totals.entries()]
    .sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]))
    .slice(0, 10);
  const derived = "member|total\n" + sorted.map(([m2, t]) => `${m2}|${t}`).join("\n") + "\n";
  check("expected output is byte-identical to a re-derivation from the dump",
    derived === e.text,
    derived === e.text ? "byte-equal" : `derived ${JSON.stringify(derived)} vs served ${JSON.stringify(e.text)}`);
  check("question states the ordering rule", /DESCENDING/.test(q.text) && /ASCENDING/.test(q.text));
  check("question points at the same three files",
    q.text.includes("arena-4-dump.sql") && q.text.includes("arena-4-expected.txt"));
}

// ── Pinned comments resolve ─────────────────────────────────────────
section("Pinned founder comments → every linked URL responds 200");
{
  const listRes = await fetch(`${BASE}/api/tasks?guild=arena&limit=50`);
  const list = await listRes.json();
  const arena = (list.tasks ?? []).filter((t) => /^ARENA #[1-4] /.test(t.title));
  check("found the 4 data-bearing arena tasks", arena.length === 4, `got ${arena.length}`);
  for (const t of arena) {
    const det = await (await fetch(`${BASE}/api/tasks/${t.id}`)).json();
    const comments = det.comments ?? [];
    const founder = comments.filter((c) => c.author === "ergonia-founder");
    check(`task #${t.id} has a pinned founder comment`, founder.length >= 1, `${founder.length} comment(s)`);
    const urls = [...(founder[0]?.body ?? "").matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
    check(`task #${t.id} comment links at least one asset`, urls.length >= 1, urls.join(" "));
    for (const u of urls) {
      const r = await fetch(u);
      check(`  ${u} responds 200`, r.status === 200, `status=${r.status}`);
    }
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
