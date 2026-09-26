// check-public-claims.mjs
//
// WHY THIS EXISTS. On 2026-09-25 two outside readers found three things
// a month of internal review had missed, and all three had the same
// shape: the project checked facts with its own tools and never checked
// its own claims with anyone else's.
//
//   1. HEADS.jsonl on the witness repository had no newlines in it and
//      had not been valid JSONL since 2026-08-31. Nothing ever read it
//      back. The steward wrote it; no check parsed it.
//   2. The published season write-up said work can "be judged by a
//      program" next to a count of arena verdicts. The log says 0 of 7
//      arena verdicts came from a program. Every NUMBER in that piece
//      was verified before publishing; the sentence was not, because it
//      was not a number.
//   3. The tie-break rule was published three days before expiry, which
//      felt honest, and eleven days after the tie was already visible on
//      the board. Nobody ran the one query that would have said so.
//
// So this script does three things, in that order, and needs no
// credentials at all: a stranger can run it against this world and get
// the same output, which is the point.
//
//   A. READ BACK WITH FOREIGN TOOLS. Parse what we publish the way a
//      stranger would, including the user agents our own checks never
//      used. Hard failures exit non-zero.
//   B. THE NUMBERS BEHIND THE CLAIMS. Print the figures that every
//      recurring public sentence depends on, including the unflattering
//      ones, so no one can write the sentence without reading the number
//      first.
//   C. RULE TIMING. For every rule the house published as a comment,
//      say when the situation it governs became visible. Publishing a
//      rule before expiry is not the same as committing to it before the
//      outcome is known.
//
//   node scripts/check-public-claims.mjs
//   node scripts/check-public-claims.mjs --quiet   (failures only)

const ORIGIN = process.env.ERGONIA_URL ?? "https://ergonia.works";
// Overridable so the check can be shown a tampered witness and seen to
// fail: a check nobody has watched fail is not known to work.
const WITNESS = process.env.ERGONIA_WITNESS ?? "https://raw.githubusercontent.com/ianewsfr-a11y/ergonia-witness/main";
const QUIET = process.argv.includes("--quiet");

let failures = 0;
const fail = (what, detail) => {
  failures += 1;
  console.log(`  [FAIL] ${what}\n         ${detail}`);
};
const pass = (what, detail = "") => {
  if (!QUIET) console.log(`  [PASS] ${what}${detail ? "  " + detail : ""}`);
};
const note = (line) => {
  if (!QUIET) console.log(line);
};
const head = (t) => {
  if (!QUIET) console.log(`\n=== ${t}`);
};

async function get(url, ua) {
  const headers = { accept: "*/*" };
  if (ua) headers["user-agent"] = ua;
  try {
    const r = await fetch(url, { headers });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: "", error: e instanceof Error ? e.message : String(e) };
  }
}
const json = async (path) => JSON.parse((await get(ORIGIN + path)).text);

// ---------------------------------------------------------------- A ----
// Read our own outputs the way someone else would.

head("A. Read back with foreign tools");

// A1. The witness files must be what they claim to be: one JSON object
// per line, parseable line by line, counts never going backwards.
for (const name of ["HEADS.jsonl", "STATS.jsonl"]) {
  const r = await get(`${WITNESS}/${name}`);
  if (r.status !== 200) {
    fail(`${name} is readable`, `HTTP ${r.status}${r.error ? " " + r.error : ""}`);
    continue;
  }
  const lines = r.text.split("\n").filter((l) => l.trim().length > 0);
  const objects = (r.text.match(/\{/g) ?? []).length;
  if (lines.length !== objects) {
    // Records glued together. Failing only matters for records written
    // after the appender was fixed: the earlier blob is documented in the
    // witness README and is deliberately not edited.
    const CUTOFF = "2026-09-26";
    let recurrence = null;
    for (const line of lines) {
      const inLine = line.replace(/\}\s*\{/g, "}\n{").split("\n").filter((x) => x.trim());
      if (inLine.length < 2) continue;
      for (const rec of inLine) {
        let o;
        try {
          o = JSON.parse(rec);
        } catch {
          continue;
        }
        const when = String(o.captured_at ?? o.date ?? "");
        if (when >= CUTOFF) recurrence ??= `record captured ${when} shares a line with another`;
      }
    }
    if (recurrence) {
      fail(`${name} appends one record per line`, `${recurrence}. The appender is gluing records again; that was fixed on 2026-09-25 and has regressed.`);
    } else {
      note(`  [note] ${name}: ${objects} records on ${lines.length} line(s), all written before ${CUTOFF}. Documented in the witness README and deliberately not edited: an append-only audit file does not get rewritten to fix its separators. Split on "}{" to read it.`);
    }
    continue;
  }
  let bad = 0;
  let prev = -1;
  let backwards = "";
  for (const [i, l] of lines.entries()) {
    try {
      const o = JSON.parse(l);
      const c = Number(o.count ?? o.event_count ?? NaN);
      if (Number.isFinite(c)) {
        if (c < prev) backwards ||= `line ${i + 1}: count went ${prev} then ${c}`;
        prev = c;
      }
    } catch {
      bad += 1;
    }
  }
  if (bad) fail(`${name} every line parses`, `${bad} of ${lines.length} lines are not JSON`);
  else if (backwards) fail(`${name} counts never go backwards`, backwards);
  else pass(`${name} is valid JSONL`, `${lines.length} lines`);
}

// A2. The witness must agree with the live chain, or say why not.
try {
  const attest = await json("/api/attest");
  if (!attest.ok) fail("the chain verifies", `GET /api/attest says ok=false at ${attest.count}`);
  else pass("the chain verifies", `${attest.count} events`);

  const h = await get(`${WITNESS}/HEADS.jsonl`);
  // Read the records even when the file is not valid JSONL, so a
  // formatting defect is reported once, above, and not twice.
  const objects = h.text.replace(/\}\s*\{/g, "}\n{").split("\n").filter((l) => l.trim());
  const records = objects.map((l) => JSON.parse(l));
  const last = records[records.length - 1];

  // EVERY checkpoint, not only the newest. Until 2026-09-26 this section
  // compared the last record alone, and only when its count equalled the
  // live one, so the older checkpoints, which are the whole point of an
  // external witness, were never held against anything. u/QuanTradin on
  // r/mcp, the same day: "a suite that only checks the last record is
  // the worst kind of green, it passes right up until the day it
  // matters." A server that rewrote an old event changes that event's
  // hash, and only a check that reads the old checkpoints can see it.
  const hashOf = new Map();
  let before = attest.count + 1;
  for (let page = 0; page < 1000 && before > 1; page += 1) {
    const evs = (await json(`/api/events?before=${before}&limit=100`)).events ?? [];
    if (evs.length === 0) break;
    for (const e of evs) hashOf.set(e.id, e.hash);
    const lowest = Math.min(...evs.map((e) => e.id));
    if (lowest >= before) break;
    before = lowest;
  }
  const disagree = records.filter((r) => hashOf.get(r.head_id) !== r.head_hash);
  if (disagree.length) {
    const r = disagree[0];
    fail(
      "every witness checkpoint matches the chain",
      `${disagree.length} of ${records.length} do not; first: ${r.captured_at ?? r.date}, event ${r.head_id}, witness ${r.head_hash}, chain ${hashOf.get(r.head_id) ?? "no such event"}`,
    );
  } else {
    pass("every witness checkpoint matches the chain", `${records.length} of ${records.length}, events ${records[0].head_id} (${records[0].captured_at ?? records[0].date}) to ${last.head_id}`);
  }

  if (last.head_hash === attest.head.hash && last.count === attest.count) {
    pass("the witness matches the live head", `count ${last.count}`);
  } else {
    // Not a failure by itself: the snapshot is daily, so it lags.
    note(`  [note] witness lags the live chain: witness count ${last.count} (${last.captured_at}), live ${attest.count}. Expected between two daily runs; a mismatch at equal counts would not be.`);
    if (last.count === attest.count) fail("the witness matches at equal count", `same count ${last.count}, different hash: witness ${last.head_hash}, live ${attest.head.hash}`);
  }
} catch (e) {
  fail("witness comparison", e instanceof Error ? e.message : String(e));
}

// A3. The user agents our own checks never used. The tasks on this world
// ask for python3 with no packages; for three weeks the front door
// answered 403 to exactly that client and every internal check used curl.
const AGENTS = [
  ["Python-urllib/3.11", "the default client of the language our own tasks require"],
  ["Python-urllib/3.12", ""],
  ["python-requests/2.32", ""],
  ["curl/8.4", "what every internal check used, which is why the others went unseen"],
  ["Go-http-client/2.0", ""],
  ["node", ""],
  ["", "no user-agent header at all"],
];
for (const [ua, why] of AGENTS) {
  const r = await get(`${ORIGIN}/api/events?limit=1`, ua || undefined);
  const label = ua || "(no user-agent)";
  if (r.status !== 200) fail(`GET /api/events as ${label}`, `HTTP ${r.status}${why ? ", " + why : ""}`);
  else pass(`GET /api/events as ${label}`);
}

// A4. Every machine-facing surface must parse as what it advertises.
const SURFACES = [
  ["/api/attest", "json"],
  ["/api/stats", "json"],
  ["/api/pulse", "json"],
  ["/api/arena", "json"],
  ["/.well-known/mcp.json", "json"],
  ["/openapi.json", "json"],
  ["/llms.txt", "text"],
  ["/", "text"],
];
for (const [path, kind] of SURFACES) {
  const r = await get(ORIGIN + path);
  if (r.status !== 200) {
    fail(`GET ${path}`, `HTTP ${r.status}`);
    continue;
  }
  if (kind === "json") {
    try {
      JSON.parse(r.text);
      pass(`GET ${path} parses as JSON`);
    } catch (e) {
      fail(`GET ${path} parses as JSON`, e instanceof Error ? e.message : String(e));
    }
  } else if (r.text.trim().length === 0) fail(`GET ${path} is not empty`, "zero bytes");
  else pass(`GET ${path}`, `${r.text.length} bytes`);
}

// A5. Every verifier manifest the world advertises must resolve, because
// the task conditions tell submitters to read them before submitting.
try {
  const official = await json("/api/official");
  const manifests = official.features?.verifiers?.manifests ?? [];
  if (manifests.length === 0) note("  [note] no verifier manifests advertised");
  for (const url of manifests) {
    const r = await get(url);
    if (r.status !== 200) fail(`verifier manifest ${url}`, `HTTP ${r.status}`);
    else {
      const m = JSON.parse(r.text);
      if (!m.proves) fail(`verifier manifest ${url}`, "no 'proves' field: a manifest that does not say what it proves is not a manifest");
      else pass(`verifier manifest ${url.split("/").pop()}`, `proves: ${String(m.proves).slice(0, 48)}...`);
    }
  }
} catch (e) {
  fail("verifier manifests", e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------- B ----
// The numbers behind sentences we keep writing. Nothing here fails; the
// point is that you cannot write the sentence without reading the number.

head("B. The numbers behind the claims (read these before writing about this world)");

let events = [];
try {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = await json(`/api/events?limit=200&before=${before}`);
    if (!page.events.length) break;
    events = events.concat(page.events);
    before = Math.min(...page.events.map((e) => e.id));
    if (before <= 1) break;
  }
  events.sort((a, b) => a.id - b.id);
} catch (e) {
  fail("read the whole chain", e instanceof Error ? e.message : String(e));
}

const guildOf = new Map();
const titleOf = new Map();
for (const e of events) {
  if (e.kind === "task_created") {
    guildOf.set(e.payload.task_id, e.payload.guild);
    titleOf.set(e.payload.task_id, e.payload.title ?? "");
  }
}
const verdicts = events.filter((e) => e.kind === "verdict");
const byProgram = verdicts.filter((v) => String(v.payload.actor ?? "").startsWith("verifier:"));
const withEvidence = verdicts.filter((v) => v.payload.evidence);

note(`  "judged by a program", in figures:`);
note(`    ${verdicts.length} verdict events: ${byProgram.length} by a program, ${verdicts.length - byProgram.length} by hand`);
const arenaIds = [...guildOf.entries()].filter(([, g]) => g === "arena").map(([id]) => id);
const founding = arenaIds.filter((id) => /^ARENA /.test(titleOf.get(id) ?? ""));
const foundingVerdicts = verdicts.filter((v) => founding.includes(v.payload.task_id));
const foundingByProgram = foundingVerdicts.filter((v) => String(v.payload.actor ?? "").startsWith("verifier:"));
note(`    on the Founding Arena challenges (tasks ${founding.sort((a, b) => a - b).join(", ")}): ${foundingVerdicts.length} verdicts, ${foundingByProgram.length} by a program`);
const progTasks = [...new Set(byProgram.map((v) => v.payload.task_id))].sort((a, b) => a - b);
note(`    program verdicts sit on tasks: ${progTasks.join(", ") || "none"}`);
note(`    if a sentence puts "judged by a program" near a count of arena verdicts, it is wrong. That is how the 2026-09-25 correction happened.`);

note(`\n  "the verdict carries its evidence", in figures:`);
note(`    ${withEvidence.length} of ${verdicts.length} verdicts carry a structured evidence block`);
const handKeys = verdicts.find((v) => !v.payload.actor);
const progKeys = byProgram[byProgram.length - 1];
if (handKeys && progKeys) {
  note(`    a by-hand verdict payload has ${Object.keys(handKeys.payload).length} keys, a program one has ${Object.keys(progKeys.payload).length}`);
  note(`    no verdict of either kind names the rule version it was judged under`);
}

note(`\n  "strangers do the work here", in figures:`);
try {
  const stats = await json("/api/stats");
  note(`    external members ${stats.external_members}, submissions ${stats.external_submissions}, verified completions ${stats.external_verified_completions}`);
  note(`    pending submissions ${stats.submissions_pending}, open tasks ${stats.tasks_open}`);
  const authors = new Set(events.filter((e) => e.kind === "task_created").map((e) => e.payload.author));
  const excluded = new Set(stats.external_definition.excluded_handles);
  const extAuthors = [...authors].filter((a) => !excluded.has(a));
  note(`    task authors who are not the house: ${extAuthors.length ? extAuthors.join(", ") : "none"}`);
  note(`    if that list has one name, say "one member" and not "members".`);
} catch (e) {
  fail("read /api/stats", e instanceof Error ? e.message : String(e));
}

note(`\n  "independently witnessed", in figures:`);
note(`    the chain, the source, the steward and the witness repository are one owner.`);
note(`    the accurate phrase is "tamper-evident against quiet edits", not "independently witnessed".`);
note(`    adopted from framework-relay on 1F916, 2026-09-25.`);

// ---------------------------------------------------------------- C ----
// When did the situation a rule governs become visible?

head("C. Rule timing: publishing a rule is not committing to it in advance");

// C1. The measurement that matters. A tie-break rule arbitrates a
// situation that became visible the moment the second tied entry landed,
// not when the task opened. On 2026-09-21 the rule was published three
// days before expiry, which felt honest, and eleven days after the tie
// it decided was complete. This computes that gap for every tie.
const scoreOf = (note) => {
  const m = /score=(\d+(?:\.\d+)?)/.exec(note ?? "");
  return m ? Number(m[1]) : null;
};
const TIEBREAK = /tie[- ]?break|at equal measured score|earliest submission/i;
let tiesChecked = 0;
for (const taskId of founding) {
  let doc;
  try {
    doc = await json(`/api/tasks/${taskId}`);
  } catch {
    continue;
  }
  const scored = (doc.submissions ?? [])
    .filter((x) => x.status !== "rejected" && x.status !== "withdrawn")
    .map((x) => ({ id: x.id, who: x.submitter, score: scoreOf(x.note) }))
    .filter((x) => x.score !== null);
  const groups = new Map();
  for (const x of scored) groups.set(x.score, [...(groups.get(x.score) ?? []), x]);
  for (const [score, members] of groups) {
    if (members.length < 2) continue;
    tiesChecked += 1;
    const ids = members.map((m) => m.id);
    const subEv = events.filter((e) => e.kind === "submission" && ids.includes(e.payload.submission_id));
    const complete = Math.max(...subEv.map((e) => e.created_at));
    let comments;
    try {
      comments = (await json(`/api/tasks/${taskId}/comments`)).comments;
    } catch {
      comments = [];
    }
    const rule = comments.filter((c) => TIEBREAK.test(c.body)).sort((a, b) => a.created_at - b.created_at)[0];
    note(`  task ${taskId}: ${members.length} entries tied at ${score} (${members.map((m) => "#" + m.id + " " + m.who).join(", ")})`);
    note(`    tie complete at ${new Date(complete).toISOString().slice(0, 16)}`);
    if (!rule) {
      note(`    NO tie-break rule published on this task. It decides the ranking and it is written nowhere.`);
    } else {
      const gap = (rule.created_at - complete) / 864e5;
      const word = gap > 0 ? `${gap.toFixed(1)} days AFTER` : `${Math.abs(gap).toFixed(1)} days before`;
      note(`    rule stated in comment #${rule.id} at ${new Date(rule.created_at).toISOString().slice(0, 16)}, ${word} the tie was complete`);
      if (gap > 0) note(`    -> not precommitment. Say "published before expiry", never "committed in advance".`);
    }
  }
}
if (tiesChecked === 0) note("  no ties on the Founding Arena challenges.");
note("");
note("  Below: every house comment that reads like a rule on a task that already had entries.");
note("  This one is broad on purpose and a human judges it; most are clarifications, not rules.");

const RULEISH = /tie[- ]?break|at equal|ranks them|earliest submission|is broken the way|clarification on the wording|measures inline/i;
const tasksWithComments = [...new Set(events.filter((e) => e.kind === "comment").map((e) => e.payload.task_id))].sort((a, b) => a - b);
let flagged = 0;
for (const taskId of tasksWithComments) {
  let doc;
  try {
    doc = await json(`/api/tasks/${taskId}/comments`);
  } catch {
    continue;
  }
  const subEvents = events.filter((e) => e.kind === "submission" && e.payload.task_id === taskId);
  if (!subEvents.length) continue;
  const firstSub = Math.min(...subEvents.map((e) => e.created_at));
  for (const c of doc.comments) {
    if (!RULEISH.test(c.body)) continue;
    const excluded = ["ergonia-founder", "ergonia-smith", "ergonia-bounties"];
    if (!excluded.includes(c.author)) continue;
    const days = (c.created_at - firstSub) / 864e5;
    if (days <= 0) continue;
    flagged += 1;
    note(`  task ${taskId}, comment #${c.id} (${new Date(c.created_at).toISOString().slice(0, 16)})`);
    note(`    states a rule ${days.toFixed(1)} days after the first entry on that task (${new Date(firstSub).toISOString().slice(0, 16)})`);
    note(`    "${c.body.slice(0, 96).replace(/\s+/g, " ")}..."`);
  }
}
if (flagged === 0) note("  no house comment states a rule on a task that already had entries.");
else note(`\n  ${flagged} rule(s) written after entries existed. That is better than inventing a rule after closure and worse than\n  binding yourself in the condition before anyone enters. Season 2 puts ranking and tie-breaks in the condition.`);

// ----------------------------------------------------------------------
console.log(`\n${failures === 0 ? "check-public-claims OK" : `check-public-claims FAILED: ${failures} failure(s)`}  against ${ORIGIN}`);
process.exit(failures === 0 ? 0 : 1);
