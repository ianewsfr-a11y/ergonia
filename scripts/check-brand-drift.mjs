// scripts/check-brand-drift.mjs
//
// Asserts the four BRAND phrases that shape Ergonia's public pitch
// (name, tagline, pitch paragraph, campaign line) appear literally in
// README.md. If any of them is missing, the build fails.
//
// This is the "canonical brand source" enforcement mechanism: the
// wording lives in src/brand.ts and every self-describing surface in
// the Worker imports it from there. README.md is a static Markdown
// file that cannot import a TS module at read time, so it carries a
// copy of those phrases with a comment naming src/brand.ts as the
// source. This script catches a change to BRAND that forgot to
// update README, or a change to README that broke the copy.
//
// Extracting the field values does not need a TS compiler: each of
// the four fields is a single string literal at a known key in
// src/brand.ts. A regex per key finds it. If BRAND ever grows to a
// shape where regex extraction is not enough, promote this to a
// build-time generator that writes a JSON file both README (via a
// preprocessor) and this check can read.
//
// Run:   node scripts/check-brand-drift.mjs
// Exit:  0 if every phrase is present in README.md,
//        1 if any is missing or unextractable.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const brandSrc = readFileSync(resolve(ROOT, "src", "brand.ts"), "utf8");
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");

// A single-string field is either `key: "value",` (single-line) or
// `key:\n    "value",` (wrapped for readability). Both shapes appear
// in src/brand.ts. This regex matches both.
function extractString(key) {
  const re = new RegExp(String.raw`\b` + key + String.raw`\s*:\s*(?:\r?\n\s+)?"((?:[^"\\]|\\.)*)"`, "m");
  const m = re.exec(brandSrc);
  if (!m) return null;
  // Un-escape JSON-style backslash sequences.
  return m[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

const fields = ["name", "tagline", "pitch", "campaign"];
const errors = [];
const missing = [];

for (const key of fields) {
  const value = extractString(key);
  if (value === null) {
    errors.push(`could not extract BRAND.${key} from src/brand.ts`);
    continue;
  }
  if (!readme.includes(value)) {
    missing.push({ key, value });
  }
}

if (errors.length === 0 && missing.length === 0) {
  console.log(`brand-drift OK: README.md contains every BRAND phrase (${fields.length}/${fields.length}).`);
  process.exitCode = 0;
} else {
  if (errors.length) {
    console.error("brand-drift FAILED: extraction errors:");
    for (const e of errors) console.error(`  - ${e}`);
  }
  if (missing.length) {
    console.error("brand-drift FAILED: README.md is missing these BRAND phrases:");
    for (const { key, value } of missing) {
      const preview = value.length > 80 ? value.slice(0, 80) + "..." : value;
      console.error(`  - BRAND.${key}: ${JSON.stringify(preview)}`);
    }
    console.error("");
    console.error("Fix: update README.md to include the missing phrase(s),");
    console.error("or update src/brand.ts and re-run this check.");
  }
  process.exitCode = 1;
}
