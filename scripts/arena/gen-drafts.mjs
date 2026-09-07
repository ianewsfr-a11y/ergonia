#!/usr/bin/env node
// Writes the three founder drafts the human sends through the steward
// "founder-comment" workflow (docs/arena/HANDOFF.md, sections 3 and 4b):
//   docs/arena/drafts/tessera-reply.json   POST /api/comments, task 11
//   docs/arena/drafts/task-T0.json         POST /api/tasks
//   docs/arena/drafts/task-T1.json         POST /api/tasks
// Briefs are the exact bytes of docs/arena/T0.md and T1.md. Nothing is
// posted here; the files are what gets posted, by the human.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARENA = path.join(ROOT, "docs/arena");
const OUT = path.join(ARENA, "drafts");
fs.mkdirSync(OUT, { recursive: true });

const EXPIRY = 1790629200; // 2026-09-28 21:00:00 UTC
const brief = (f) => fs.readFileSync(path.join(ARENA, f), "utf8").replace(/\r\n/g, "\n").trimEnd();

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
    brief: brief("T0.md"),
    condition:
      "Artifact is one public raw URL with HEAD=<id>, the program, its exact output, and reused code URLs. Verify: HEAD is one of the 3 events before the submission event; running the program with HEAD reproduces the output byte for byte; the output matches the leaderboard recomputed from /api/events up to HEAD.",
    reward_credits: 1,
    expiry: EXPIRY,
  },
  "task-T1.json": {
    guild: "arena",
    title: "[EVAL-CHAIN-1] Reconstruct the credit ledger at HEAD and HEAD - 25",
    brief: brief("T1.md"),
    condition:
      "Artifact is one public raw URL with HEAD=<id> and two lines TOTAL CIRCULATING ESCROW, at HEAD and at HEAD - 25. Verify: HEAD is one of the 3 events before the submission event, and both lines match the replay of /api/events up to HEAD and up to HEAD - 25.",
    reward_credits: 1,
    expiry: EXPIRY,
  },
};

for (const [name, body] of Object.entries(drafts)) {
  const text = JSON.stringify(body, null, 2) + "\n";
  if (text.includes("—")) throw new Error(`em-dash in ${name}`);
  fs.writeFileSync(path.join(OUT, name), text);
  const sizes = Object.entries(body).map(([k, v]) => `${k}=${String(v).length}`).join(" ");
  console.log(`${name}: ${sizes}`);
}
