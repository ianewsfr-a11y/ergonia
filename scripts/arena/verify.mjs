#!/usr/bin/env node
// T2 harness: the expected SHA-256 of a window of the public chain, and an
// optional PASS/FAIL check of a submitted artifact.
//
//   node scripts/arena/verify.mjs FIRST_ID HEAD
//   node scripts/arena/verify.mjs FIRST_ID HEAD ARTIFACT_URL
//   node scripts/arena/verify.mjs FIRST_ID HEAD ARTIFACT_URL SUBMISSION_ID
//
// Rules applied, in order (docs/arena/T2.md once on file; ASSUMED until
// then, see docs/arena/HANDOFF.md):
//   1. take every event with FIRST_ID <= id <= HEAD, ascending by id;
//   2. for each event build the record {id, kind, created_at, payload,
//      prev_hash, hash} with created_at as ISO 8601 UTC truncated to the
//      second (sub-seconds dropped, never rounded);
//   3. serialize each record as canonical JSON: keys sorted at every
//      depth, no whitespace;
//   4. join the lines with a single LF, no trailing newline;
//   5. SHA-256 of the UTF-8 bytes, lower-case hex.
//
// Artifact format expected: a public text file with the lines
//   FIRST_ID=<n>   HEAD=<n>   SHA256=<hex>
// With SUBMISSION_ID, HEAD must be one of the 3 event ids immediately
// preceding the submission event (HEAD in {S-1, S-2, S-3} where S is the
// id of the `submission` event carrying that submission_id).
//
// Read-only. Exit code 0 on PASS or on a plain expected-hash run, 1 on FAIL, 2 on usage error.

import { fetchWindow, findSubmissionEventId, parseArtifact, sha256Hex, windowText } from "./lib/chain.mjs";

const [firstArg, headArg, artifactUrl, submissionArg] = process.argv.slice(2);
const FIRST_ID = Number(firstArg);
const HEAD = Number(headArg);
if (!Number.isInteger(FIRST_ID) || !Number.isInteger(HEAD) || FIRST_ID < 1 || HEAD < FIRST_ID) {
  console.error("usage: verify.mjs FIRST_ID HEAD [ARTIFACT_URL] [SUBMISSION_ID]");
  process.exit(2);
}

const events = await fetchWindow(FIRST_ID, HEAD);
const text = windowText(events);
const expected = await sha256Hex(text);
console.log(`window ${FIRST_ID}..${HEAD}: ${events.length} events, ${text.length} chars`);
console.log(`expected SHA-256: ${expected}`);

if (!artifactUrl) process.exit(0);

const res = await fetch(artifactUrl);
if (!res.ok) {
  console.log(`FAIL: artifact ${artifactUrl} -> HTTP ${res.status}`);
  process.exit(1);
}
const art = parseArtifact(await res.text());
const problems = [];
if (art.first_id !== FIRST_ID) problems.push(`FIRST_ID line is ${art.first_id}, expected ${FIRST_ID}`);
if (art.head !== HEAD) problems.push(`HEAD line is ${art.head}, expected ${HEAD}`);
if (art.sha256 !== expected) problems.push(`SHA256 line is ${art.sha256 ?? "missing"}, expected ${expected}`);

if (submissionArg) {
  const submissionId = Number(submissionArg);
  const s = await findSubmissionEventId(submissionId);
  if (s === null) problems.push(`no submission event carries submission_id ${submissionId}`);
  else if (!(s - HEAD >= 1 && s - HEAD <= 3)) problems.push(`HEAD ${HEAD} is not within the 3 events before submission event ${s}`);
  else console.log(`HEAD ${HEAD} is ${s - HEAD} event(s) before submission event ${s}: ok`);
}

if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  console.log("FAIL");
  process.exit(1);
}
console.log("PASS");
