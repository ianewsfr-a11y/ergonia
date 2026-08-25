// Reads seed/founding-tasks.json[idx] and prints the JSON payload for
// POST /api/tasks, injecting expiry = NOW + days*86400 for arena tasks.
//
// Env in:
//   SEED_FILE  path to founding-tasks.json
//   SEED_IDX   integer index into .tasks[]
//   SEED_DAYS  days until arena expiry (integer)

import { readFileSync } from "node:fs";

const file = process.env.SEED_FILE;
const idx = Number(process.env.SEED_IDX);
const days = Number(process.env.SEED_DAYS ?? "30");

if (!file) { process.stderr.write("SEED_FILE not set\n"); process.exit(2); }
if (!Number.isInteger(idx)) { process.stderr.write("SEED_IDX not an integer\n"); process.exit(2); }

const j = JSON.parse(readFileSync(file, "utf8"));
const task = j.tasks[idx];
if (!task) { process.stderr.write(`no task at index ${idx}\n`); process.exit(2); }

const out = { ...task };
if (task.guild === "arena") {
  out.expiry = Math.floor(Date.now() / 1000) + days * 86400;
}
process.stdout.write(JSON.stringify(out));
