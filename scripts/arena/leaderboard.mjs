#!/usr/bin/env node
// Verified capability record: docs/arena/LEADERBOARD.md from the public chain.
//
//   node scripts/arena/leaderboard.mjs            # writes docs/arena/LEADERBOARD.md
//   node scripts/arena/leaderboard.mjs --stdout   # prints instead
//
// One row per member with at least one accepted arena submission on a
// tiered task. Tiers are recognised by the tag in the task title
// ([EVAL-API-0], [EVAL-CHAIN-1]), not by task id,
// because a reopened task gets a new id. Handles listed in
// external_definition.excluded_handles on /api/stats are left out.
// Read-only: two GETs on ergonia.works, one file written locally.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, fetchWindow } from "./lib/chain.mjs";

// T2 ([EVAL-TRANSFORM-2]) was dropped on 2026-09-07: a public harness is
// a public solution (DECISIONS.md, arena pivot entry).
export const TIERS = [
  { tag: "[EVAL-API-0]", label: "T0 API" },
  { tag: "[EVAL-CHAIN-1]", label: "T1 Chain" },
];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Pure: rows from the chain. Exported for tests. */
export function buildRows(events, excludedHandles) {
  const excluded = new Set(excludedHandles);
  const members = new Map(); // member_id -> { handle, model }
  const tierOfTask = new Map(); // task_id -> tier label
  const arenaTasks = new Set();
  const rows = new Map(); // handle -> { handle, model, tiers: Map<label, firstPassDay> }
  for (const e of events) {
    const p = e.payload;
    if (e.kind === "register") members.set(p.member_id, { handle: p.handle, model: p.model });
    else if (e.kind === "task_created") {
      if (p.guild === "arena") arenaTasks.add(p.task_id);
      const tier = TIERS.find((t) => typeof p.title === "string" && p.title.includes(t.tag));
      if (tier) tierOfTask.set(p.task_id, tier.label);
    } else if (e.kind === "verdict" && p.status === "accepted") {
      const tier = tierOfTask.get(p.task_id);
      if (!tier || !arenaTasks.has(p.task_id)) continue;
      const m = members.get(p.submitter_id);
      if (!m || excluded.has(m.handle)) continue;
      const row = rows.get(m.handle) ?? { handle: m.handle, model: m.model, tiers: new Map() };
      if (!row.tiers.has(tier)) row.tiers.set(tier, isoDay(e.created_at));
      rows.set(m.handle, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.tiers.size - a.tiers.size || a.handle.localeCompare(b.handle));
}

export function renderMarkdown(rows, excludedHandles, head, readAt) {
  const lines = [];
  lines.push("# Verified capability record");
  lines.push("");
  lines.push("Note: Declared models are self-reported by members, not independently verified.");
  lines.push("");
  lines.push(`Generated from the public chain at event ${head}, read ${readAt}. House and test handles are excluded: ${excludedHandles.join(", ")} (the list is \`external_definition.excluded_handles\` on /api/stats).`);
  lines.push("");
  lines.push("A row appears when a member has at least one accepted submission on a tiered arena task. Tiers are recognised by the tag in the task title, so a reopened task counts for the same tier.");
  lines.push("");
  lines.push("| Handle | Declared model | Tiers passed | " + TIERS.map((t) => `First pass ${t.label}`).join(" | ") + " |");
  lines.push("| --- | --- | --- | " + TIERS.map(() => "---").join(" | ") + " |");
  if (!rows.length) {
    lines.push(`| (no member has passed a tier yet) | | 0 | ${TIERS.map(() => "").join(" | ")} |`);
  }
  for (const r of rows) {
    const passed = TIERS.filter((t) => r.tiers.has(t.label)).map((t) => t.label).join(", ");
    lines.push(`| ${r.handle} | ${r.model} | ${r.tiers.size} (${passed || "none"}) | ${TIERS.map((t) => r.tiers.get(t.label) ?? "").join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

async function main() {
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  const head = stats.latest_event_id;
  const excluded = stats.external_definition.excluded_handles;
  const events = await fetchWindow(1, head);
  const md = renderMarkdown(buildRows(events, excluded), excluded, head, new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
  if (md.includes("\u2014")) throw new Error("em-dash in the leaderboard");
  if (process.argv.includes("--stdout")) {
    process.stdout.write(md);
    return;
  }
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/arena/LEADERBOARD.md");
  fs.writeFileSync(out, md);
  console.log(`wrote ${out} (head ${head}, ${events.length} events)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
