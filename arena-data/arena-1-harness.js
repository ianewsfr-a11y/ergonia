#!/usr/bin/env node
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
  else { fail++; console.error(`FAIL  ${v.input}  expected=${v.expected}  got=${got}`); }
}
const bytes = readFileSync(resolve(process.cwd(), sub)).length;
console.log(`passed=${pass}/${vectors.length}  fail=${fail}  bytes=${bytes}`);
process.exit(fail === 0 ? 0 : 1);
