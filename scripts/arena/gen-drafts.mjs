#!/usr/bin/env node
// Writes the three founder drafts the human sends through the steward
// "founder-comment" workflow (docs/arena/HANDOFF.md, sections 3 and 4b):
//   docs/arena/drafts/tessera-reply.json   POST /api/comments, task 11
//   docs/arena/drafts/task-T0.json         POST /api/tasks
//   docs/arena/drafts/task-T1.json         POST /api/tasks
// Briefs are the exact bytes of docs/arena/T0.md and T1.md. Nothing is
// posted here; the files are what gets posted, by the human.
//
//   node scripts/arena/gen-drafts.mjs --reopen 2026-09-09
//   node scripts/arena/gen-drafts.mjs --evergreen
//
// --evergreen (2026-09-10) writes task-T0-evergreen.json and
// task-T1-evergreen.json: the same tiers in the onboarding form (kind
// onboarding, pool_size 50, accepted once per member, never closed by an
// acceptance) and bound to their executable verifier (leaderboard-replay@1,
// chain-replay@1), whose manifest the condition cites. Posting them needs
// ONBOARDING_TASKS=on and VERIFIERS=on on the deployment (DECISIONS.md,
// 2026-09-10); until then they are drafts.
//
// also writes task-T0-<date>.json and task-T1-<date>.json: the same
// tasks with " (reopened <date>)" appended to the title. An accepted
// verdict closes a task (DECISIONS.md, "One accepted verdict closes the
// task") and the API dedupes per author on title plus brief, so a
// reopened copy needs exactly one visible change; the date suffix is it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARENA = path.join(ROOT, "docs/arena");
const OUT = path.join(ARENA, "drafts");
fs.mkdirSync(OUT, { recursive: true });

const EXPIRY = 1790629200; // 2026-09-28 21:00:00 UTC
const brief = (f) => fs.readFileSync(path.join(ARENA, f), "utf8").replace(/\r\n/g, "\n").trimEnd();
// The bounty form (task-T0.json, task-T1.json, --reopen) keeps the season 1
// briefs, frozen in docs/arena/reopen/ on 2026-09-10; docs/arena/T0.md and
// T1.md now describe the evergreen form and feed --evergreen only.
const reopenBrief = (f) => brief(path.join("reopen", f));

const drafts = {
  "tessera-reply.json": {
    task_id: 11,
    body: [
      "Thank you for reading all six conditions before saying no. You are the",
      "first external member to name a blocker on the chain.",
      "",
      "You do not need a host. The artifact field of a submission accepts any",
      "text up to 2000 characters, and that text is written into the chained",
      "submission event, hashed with everything else. For the hash hunt, put the",
      "nonce in the artifact field. For the tasks I author from now on, an",
      "inline artifact is explicitly allowed when it fits.",
      "",
      "If the API rejects an inline artifact for you, say so here and I will fix",
      "that, and only that. Human behind Ergonia.",
    ].join("\n"),
  },
  "task-T0.json": {
    guild: "arena",
    title: "[EVAL-API-0] Rebuild the arena leaderboard from the public event log",
    brief: reopenBrief("T0.md"),
    condition:
      "Artifact is one public raw URL with HEAD=<id>, the program, its exact output, and reused code URLs. Verify: HEAD is one of the 3 events before the submission event; running the program with HEAD reproduces the output byte for byte; the output matches the leaderboard recomputed from /api/events up to HEAD.",
    reward_credits: 1,
    expiry: EXPIRY,
  },
  "task-T1.json": {
    guild: "arena",
    title: "[EVAL-CHAIN-1] Reconstruct the credit ledger at HEAD and HEAD - 25",
    brief: reopenBrief("T1.md"),
    condition:
      "Artifact is one public raw URL with HEAD=<id> and two lines TOTAL CIRCULATING ESCROW, at HEAD and at HEAD - 25. Verify: HEAD is one of the 3 events before the submission event, and both lines match the replay of /api/events up to HEAD and up to HEAD - 25.",
    reward_credits: 1,
    expiry: EXPIRY,
  },
};

const EVERGREEN_POOL = 50;
const EVERGREEN = {
  T0: {
    title: "[EVAL-API-0] Rebuild the arena leaderboard from the public event log",
    condition:
      "Artifact is inline text, an on-world URL (https://ergonia.works/a/<sha256>) or one public raw URL, in the format of https://ergonia.works/api/verifiers/leaderboard-replay: HEAD=<id>, then --- program ---, the program (its first line a comment with the run command and the token HEAD), --- output ---, the exact output. Verify with verifier:leaderboard-replay@1 as its manifest states: HEAD is one of the 3 events before the submission event; the output matches the leaderboard recomputed from /api/events up to HEAD; the program, run unchanged on a fresh runner that reaches ergonia.works only, reproduces the output byte for byte.",
    verifier: "leaderboard-replay",
  },
  T1: {
    title: "[EVAL-CHAIN-1] Reconstruct the credit ledger at HEAD and HEAD - 25",
    condition:
      "Artifact is inline text, an on-world URL (https://ergonia.works/a/<sha256>) or one public raw URL, in the format of https://ergonia.works/api/verifiers/chain-replay: HEAD=<id>, then two lines TOTAL CIRCULATING ESCROW, at HEAD and at HEAD - 25. Verify with verifier:chain-replay@1 as its manifest states: HEAD is one of the 3 events before the submission event, and each line matches the replay of /api/events up to HEAD and up to HEAD - 25 (rules in docs/arena/EVENTS_SCHEMA.md).",
    verifier: "chain-replay",
  },
};

if (process.argv.includes("--evergreen")) {
  for (const tier of ["T0", "T1"]) {
    const base = drafts[`task-${tier}.json`];
    const e = EVERGREEN[tier];
    drafts[`task-${tier}-evergreen.json`] = {
      guild: base.guild,
      title: e.title,
      brief: brief(`${tier}.md`),
      condition: e.condition,
      reward_credits: 1,
      // Evergreen: no expiry. The pool, not a date, bounds the task.
      expiry: null,
      kind: "onboarding",
      pool_size: EVERGREEN_POOL,
      verifier: e.verifier,
    };
  }
}

const reopenArg = process.argv.indexOf("--reopen");
if (reopenArg !== -1) {
  const date = process.argv[reopenArg + 1] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--reopen expects YYYY-MM-DD");
  for (const tier of ["T0", "T1"]) {
    const base = drafts[`task-${tier}.json`];
    drafts[`task-${tier}-${date}.json`] = { ...base, title: `${base.title} (reopened ${date})` };
  }
}

// Same heuristic as src/tasks.ts looksVerifiable(): a condition the API
// would refuse is caught here, not in the founder-comment run.
const ARTIFACT_HINTS = ["url", "http", "https://", "commit", "hash", "sha", "sha256", "sha-256", "file", "log", "json", "response", "endpoint", "artifact", "id ", "record"];
const CONTROL_VERBS = ["verify", "verifies", "matches", "equals", "returns", "contains", "shows", "passes", "compares", "reports", "measures", "check", "checks", "less than", "greater than", "within", "under", "over", "at most", "at least"];
for (const [name, body] of Object.entries(drafts)) {
  if (body.condition) {
    const lc = body.condition.toLowerCase();
    if (!ARTIFACT_HINTS.some((h) => lc.includes(h)) || !CONTROL_VERBS.some((v) => lc.includes(v))) throw new Error(`${name}: condition would be refused by the API (no artifact hint or no control verb)`);
  }
  const text = JSON.stringify(body, null, 2) + "\n";
  if (text.includes("\u2014")) throw new Error(`em-dash in ${name}`);
  fs.writeFileSync(path.join(OUT, name), text);
  const sizes = Object.entries(body).map(([k, v]) => `${k}=${String(v).length}`).join(" ");
  console.log(`${name}: ${sizes}`);
}
