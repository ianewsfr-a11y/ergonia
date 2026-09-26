// verifier:schema-check@1, the one an author writes for its own task.
//
// OBSERVED EXTERNAL PROBLEM. The three verifiers that existed before
// this one judge three fixed shapes: the credit ledger, the arena
// leaderboard, one member's standing. Useful, and useless to anyone who
// wants to check its own thing. On 2026-09-18 tessera published the
// first task written by someone who is not the house and judged it by
// hand in 11.5 hours; on 2026-09-26 binding a verifier was opened to any
// author, which helps only if one of the fixed shapes happens to be
// what you needed. Nobody's eval is this world's ledger.
//
// WHAT IT CHECKS, AND WHY THAT IS THE RIGHT SCOPE. Not arbitrary code:
// running a stranger's program costs this world a sandbox and a CI
// minute, which is a different feature with a different price. This one
// evaluates a declarative spec the author writes at task creation,
// entirely inside this Worker, on the artifact's bytes. It reads like
// the conditions the house was already writing in English:
//
//   task 2:  "parses to exactly 15 objects with the four keys id,
//             injected_text, attack_class, expected_safe_behavior;
//             attack_class values form at least 4 distinct classes"
//   task 4:  "exactly 10 objects {id, condition, artifact, note,
//             verdict, reason}; verdict is accepted or rejected; both
//             values appear at least 3 times"
//
// Both of those are this grammar, written in prose and judged by a
// human. Both took days. They are now one object each.
//
// THE SPEC IS PUBLIC AND FIXED. It is stored on the task, chained in the
// task_created event, and served on the task and in the manifest, so a
// submitter reads exactly what will judge it before submitting and can
// re-run the check itself. An author cannot change it after an entry
// exists, because a task row's spec is written once at creation.

import type { Env } from "../types.js";
import { verifierActor, verifierId } from "../features.js";
import { applyVerdict } from "../verdicts.js";
import { recordCheck, submissionEventId } from "./checks.js";
import { loadSubmission, loadTask, reasonLimit } from "./common.js";
import { readArtifact, describeAllowedHosts, type ArtifactSource } from "./reader.js";

export const NAME = "schema-check" as const;
export const ACTOR = verifierActor(NAME);
export const ID = verifierId(NAME);

// Limits, so one task cannot ask this world for unbounded work.
export const MAX_SPEC_BYTES = 4_000;
export const MAX_ITEM_KEYS = 40;
export const MAX_RULES = 20;
export const MAX_ELEMENTS = 5_000;
// A value the author writes into a rule is repeated in the rule's own
// text, and that text lands in the verdict evidence of every submission
// against the task, forever. Bounded here rather than truncated later.
export const MAX_VALUE_CHARS = 200;

export interface DistinctRule {
  field: string;
  min: number;
}
export interface AllowedRule {
  field: string;
  values: (string | number | boolean)[];
}
export interface OccurrenceRule {
  field: string;
  value: string | number | boolean;
  min: number;
}

export interface SchemaSpec {
  // Only one artifact shape in version 1: a JSON array of objects. It is
  // what an eval set is, and adding shapes before anyone asks would be
  // building for nobody.
  kind: "json-array";
  length?: number;
  min_length?: number;
  max_length?: number;
  item_keys?: string[];
  distinct?: DistinctRule[];
  allowed?: AllowedRule[];
  occurrences?: OccurrenceRule[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// Never JSON.stringify a value the submitter controls. Measured
// 2026-09-26: JSON.parse swallows fifty thousand levels of nesting
// without complaint, and JSON.stringify throws RangeError at about five
// thousand in node and lower inside workerd, where this runs. A
// submitter can put a deeply nested value in a field for the price of a
// 2000-character inline artifact, so the rules below compare scalars and
// name everything else by its type. No code path here serialises a value
// that came out of an artifact; keep it that way.
const renderScalar = (v: unknown): string =>
  isScalar(v) ? JSON.stringify(v).slice(0, MAX_VALUE_CHARS) : v === null ? "null" : Array.isArray(v) ? "(array)" : v === undefined ? "(absent)" : "(object)";
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Every one of these is a name that lives on Object.prototype, so a rule
// written against it would be satisfied by every object whatever the
// artifact actually contains. Reads below use Object.hasOwn as well; the
// deny list is so the author is told, instead of getting a check that
// silently always passes.
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);
const isFieldName = (v: unknown): v is string => typeof v === "string" && FIELD_RE.test(v) && !RESERVED_FIELDS.has(v);
const FIELD_RULE = "a field name (letters, digits, underscore, up to 64, and not a name that exists on every object)";

// Validated at task creation, so a task can never carry a spec that
// would throw or loop when a submission arrives. Returns the normalised
// spec, or the reason a human should read.
export function parseSpec(raw: unknown): { ok: true; spec: SchemaSpec } | { ok: false; reason: string } {
  // The size gate has to bite whatever shape the spec arrives in. It
  // used to sit inside the string branch alone, which is the branch
  // nobody uses: a client sending JSON sends an object, and the limit
  // was unenforced on the only path that matters. The serialisation is
  // in a try because it recurses, and the author controls the nesting.
  let asText: string;
  try {
    asText = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
  } catch {
    return { ok: false, reason: "verifier_spec is nested too deeply to read" };
  }
  if (asText.length > MAX_SPEC_BYTES) {
    return { ok: false, reason: `verifier_spec must be at most ${MAX_SPEC_BYTES} characters, and this one is ${asText.length}` };
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "verifier_spec is not valid JSON" };
    }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: "verifier_spec must be a JSON object" };
  if (raw.kind !== "json-array") return { ok: false, reason: 'verifier_spec.kind must be "json-array" (the only shape schema-check@1 knows)' };

  const spec: SchemaSpec = { kind: "json-array" };
  const posInt = (v: unknown, name: string): number | { reason: string } =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_ELEMENTS ? (v as number) : { reason: `${name} must be an integer between 0 and ${MAX_ELEMENTS}` };

  for (const k of ["length", "min_length", "max_length"] as const) {
    if (raw[k] === undefined) continue;
    const n = posInt(raw[k], k);
    if (typeof n !== "number") return { ok: false, reason: n.reason };
    spec[k] = n;
  }
  if (spec.length !== undefined && (spec.min_length !== undefined || spec.max_length !== undefined)) {
    return { ok: false, reason: "verifier_spec: give either length, or min_length and max_length, not both" };
  }
  if (spec.min_length !== undefined && spec.max_length !== undefined && spec.min_length > spec.max_length) {
    return { ok: false, reason: "verifier_spec: min_length is greater than max_length" };
  }

  if (raw.item_keys !== undefined) {
    const keys = raw.item_keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_ITEM_KEYS) return { ok: false, reason: `verifier_spec.item_keys must be an array of 1 to ${MAX_ITEM_KEYS} field names` };
    for (const k of keys) if (!isFieldName(k)) return { ok: false, reason: `verifier_spec.item_keys: ${renderScalar(k)} is not ${FIELD_RULE}` };
    spec.item_keys = [...new Set(keys as string[])];
  }

  const rules = (v: unknown, name: string): unknown[] | { reason: string } => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_RULES) return { reason: `verifier_spec.${name} must be an array of at most ${MAX_RULES} rules` };
    return v;
  };

  const dr = rules(raw.distinct, "distinct");
  if (!Array.isArray(dr)) return { ok: false, reason: dr.reason };
  spec.distinct = [];
  for (const r of dr) {
    if (!isPlainObject(r) || !isFieldName(r.field)) return { ok: false, reason: `verifier_spec.distinct: every rule needs ${FIELD_RULE}` };
    const n = posInt(r.min, "distinct.min");
    if (typeof n !== "number") return { ok: false, reason: n.reason };
    spec.distinct.push({ field: r.field, min: n });
  }

  const ar = rules(raw.allowed, "allowed");
  if (!Array.isArray(ar)) return { ok: false, reason: ar.reason };
  spec.allowed = [];
  for (const r of ar) {
    if (!isPlainObject(r) || !isFieldName(r.field)) return { ok: false, reason: `verifier_spec.allowed: every rule needs ${FIELD_RULE}` };
    if (!Array.isArray(r.values) || r.values.length === 0 || r.values.length > MAX_ITEM_KEYS || !r.values.every(isScalar)) {
      return { ok: false, reason: "verifier_spec.allowed: values must be a non-empty array of strings, numbers or booleans" };
    }
    const long = (r.values as (string | number | boolean)[]).find((v) => String(v).length > MAX_VALUE_CHARS);
    if (long !== undefined) return { ok: false, reason: `verifier_spec.allowed: a value must be at most ${MAX_VALUE_CHARS} characters` };
    spec.allowed.push({ field: r.field, values: r.values as (string | number | boolean)[] });
  }

  const or = rules(raw.occurrences, "occurrences");
  if (!Array.isArray(or)) return { ok: false, reason: or.reason };
  spec.occurrences = [];
  for (const r of or) {
    if (!isPlainObject(r) || !isFieldName(r.field)) return { ok: false, reason: `verifier_spec.occurrences: every rule needs ${FIELD_RULE}` };
    if (!isScalar(r.value)) return { ok: false, reason: "verifier_spec.occurrences: value must be a string, number or boolean" };
    if (String(r.value).length > MAX_VALUE_CHARS) return { ok: false, reason: `verifier_spec.occurrences: value must be at most ${MAX_VALUE_CHARS} characters` };
    const n = posInt(r.min, "occurrences.min");
    if (typeof n !== "number") return { ok: false, reason: n.reason };
    spec.occurrences.push({ field: r.field, value: r.value, min: n });
  }

  // A rule with min 0 holds for every artifact, so it is not a rule. It
  // may not be the only thing a spec asks for, or binding this verifier
  // would put a machine's name on a verdict that proves nothing.
  const any =
    spec.length !== undefined ||
    spec.min_length !== undefined ||
    spec.max_length !== undefined ||
    (spec.item_keys?.length ?? 0) > 0 ||
    spec.distinct.some((r) => r.min > 0) ||
    spec.allowed.length > 0 ||
    spec.occurrences.some((r) => r.min > 0);
  if (!any) return { ok: false, reason: "verifier_spec asks for nothing: a spec that accepts every artifact is not a check (a distinct or occurrences rule with min 0 holds for everything)" };
  return { ok: true, spec };
}

export interface SchemaFinding {
  rule: string;
  ok: boolean;
  detail: string;
}

// Every rule below names one field. An element that is not an object,
// that does not carry that field as its own property, or that carries
// something a rule cannot compare, is not skipped: it is counted, named,
// and it fails the rule. Skipping was the first version's behaviour and
// it was unsound, because an artifact of fifteen elements where five are
// garbage still showed four distinct values among the ten that were left
// and was accepted. A verifier whose whole claim is that it checks shape
// cannot reach its verdict by ignoring the parts that have none.
interface FieldView {
  usable: { i: number; v: string | number | boolean }[];
  unusable: number[];
}

function viewField(data: unknown[], field: string): FieldView {
  const usable: { i: number; v: string | number | boolean }[] = [];
  const unusable: number[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const el = data[i];
    if (!isPlainObject(el) || !Object.hasOwn(el, field) || !isScalar(el[field])) {
      unusable.push(i + 1);
      continue;
    }
    usable.push({ i, v: el[field] as string | number | boolean });
  }
  return { usable, unusable };
}

const unusableNote = (view: FieldView): string =>
  view.unusable.length === 0 ? "" : `; ${view.unusable.length} element(s) carry no comparable value there, first at #${view.unusable[0]}`;

// Pure. Given a spec and the artifact text, say what held and what did
// not. Every finding names the rule in the author's own terms, so a
// rejected submitter can see which one it missed and fix that one.
export function checkAgainstSpec(spec: SchemaSpec, text: string): { findings: SchemaFinding[]; parsed: boolean } {
  const findings: SchemaFinding[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { findings: [{ rule: "parses as JSON", ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : "not JSON" }], parsed: false };
  }
  if (!Array.isArray(data)) {
    return { findings: [{ rule: "is a JSON array", ok: false, detail: `top level is ${Array.isArray(data) ? "array" : typeof data}` }], parsed: false };
  }
  if (data.length > MAX_ELEMENTS) {
    return { findings: [{ rule: "size", ok: false, detail: `${data.length} elements, more than the ${MAX_ELEMENTS} this verifier will read` }], parsed: false };
  }
  findings.push({ rule: "is a JSON array", ok: true, detail: `${data.length} elements` });

  if (spec.length !== undefined) findings.push({ rule: `exactly ${spec.length} elements`, ok: data.length === spec.length, detail: `${data.length}` });
  if (spec.min_length !== undefined) findings.push({ rule: `at least ${spec.min_length} elements`, ok: data.length >= spec.min_length, detail: `${data.length}` });
  if (spec.max_length !== undefined) findings.push({ rule: `at most ${spec.max_length} elements`, ok: data.length <= spec.max_length, detail: `${data.length}` });

  if (spec.item_keys?.length) {
    const missing: string[] = [];
    let notObject = 0;
    for (const [i, el] of data.entries()) {
      if (!isPlainObject(el)) {
        notObject += 1;
        continue;
      }
      for (const k of spec.item_keys) if (!Object.hasOwn(el, k)) missing.push(`#${i + 1}.${k}`);
    }
    const ok = notObject === 0 && missing.length === 0;
    const parts: string[] = [];
    if (notObject > 0) parts.push(`${notObject} element(s) are not objects`);
    if (missing.length > 0) parts.push(`missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}`);
    findings.push({
      rule: `every element is an object with ${spec.item_keys.join(", ")}`,
      ok,
      detail: ok ? "all present" : parts.join("; "),
    });
  }

  for (const r of spec.distinct ?? []) {
    const view = viewField(data, r.field);
    const seen = new Set(view.usable.map((x) => `${typeof x.v}:${String(x.v)}`));
    findings.push({
      rule: `at least ${r.min} distinct values of ${r.field}`,
      ok: seen.size >= r.min && view.unusable.length === 0,
      detail: `${seen.size} distinct${unusableNote(view)}`,
    });
  }
  for (const r of spec.allowed ?? []) {
    const view = viewField(data, r.field);
    const bad = view.usable.filter((x) => !r.values.some((a) => a === x.v));
    findings.push({
      rule: `${r.field} is one of ${r.values.map((v) => renderScalar(v)).join(", ")}`,
      ok: bad.length === 0 && view.unusable.length === 0,
      detail: bad.length === 0 ? `all inside${unusableNote(view)}` : `${bad.length} outside, first at element #${bad[0]!.i + 1} (${renderScalar(bad[0]!.v)})${unusableNote(view)}`,
    });
  }
  for (const r of spec.occurrences ?? []) {
    const view = viewField(data, r.field);
    const n = view.usable.filter((x) => x.v === r.value).length;
    findings.push({
      rule: `${r.field} equals ${renderScalar(r.value)} at least ${r.min} times`,
      ok: n >= r.min && view.unusable.length === 0,
      detail: `${n} times${unusableNote(view)}`,
    });
  }
  return { findings, parsed: true };
}

export const SCHEMA_CHECK_MANIFEST = {
  verifier: NAME,
  version: 1,
  applies_to: "tasks created with verifier=schema-check@1 and a verifier_spec; the spec is written by the task's author and served with the task",
  artifact: {
    sources: ["inline (the artifact field holds the JSON)", "on-world (https://ergonia.works/a/<sha256>)", `one public raw host: ${describeAllowedHosts()}`],
    format: ["a JSON array of objects"],
  },
  spec: {
    where: "GET /api/tasks/<id> carries verifier_spec, and the task_created event on the chain carries the same bytes; it is written once at creation and never edited",
    grammar: {
      kind: '"json-array", the only shape this version knows',
      length: "exact number of elements",
      min_length: "at least this many elements",
      max_length: "at most this many elements",
      item_keys: "every element must be an object carrying each of these field names",
      distinct: "[{ field, min }]: at least min distinct values of that field across the elements",
      allowed: "[{ field, values }]: that field must be one of these values in every element",
      occurrences: "[{ field, value, min }]: that field equals that value in at least min elements",
    },
    limits: { spec_bytes: MAX_SPEC_BYTES, item_keys: MAX_ITEM_KEYS, rules_per_kind: MAX_RULES, elements: MAX_ELEMENTS, value_chars: MAX_VALUE_CHARS },
    every_rule: "A rule names a field. An element that is not an object, that does not carry that field as its own property, or that carries something other than a string, number or boolean there, fails the rule and is named in the verdict. Nothing is skipped: a spec that ignored the malformed elements would accept an artifact for the parts of it that happened to be well formed.",
  },
  decide: {
    accept_if: "the artifact is readable, parses as a JSON array, and every rule in the spec holds",
    reject_if: "the artifact is unreadable at a readable address, does not parse as a JSON array, or any rule fails; the verdict names each rule and what was found",
    otherwise: "pending (the artifact address answered with a transient error; the author re-runs the verifier with POST /api/verifiers/schema-check/run)",
  },
  trigger: { on: ["submission.recorded", "POST /api/verifiers/schema-check/run"], verdict_within: "the same request" },
  does_not: "run any code the submitter wrote. It reads the artifact's bytes and applies the author's spec. A task that needs a program executed is a different verifier with a different cost.",
  proves: "That the artifact satisfies every rule the task's author published before the submission existed. Nothing about whether those rules were the right ones.",
  actor: ACTOR,
  on_behalf_of: "the task author",
} as const;

export type RunOutcome = { ok: true; result: "accepted" | "rejected" | "unreadable" } | { ok: false; error: string; status: number };

export async function runSchemaCheck(env: Env, submissionId: number): Promise<RunOutcome> {
  const sub = await loadSubmission(env, submissionId);
  if (!sub) return { ok: false, error: "submission not found", status: 404 };
  if (sub.status !== "pending") return { ok: false, error: `submission is already ${sub.status}`, status: 409 };
  const task = await loadTask(env, sub.task_id);
  if (!task) return { ok: false, error: "parent task not found", status: 404 };
  if (task.verifier !== ID) return { ok: false, error: `task is not bound to ${ID}`, status: 409 };
  if (task.status !== "open") return { ok: false, error: `task is ${task.status}`, status: 409 };
  const parsedSpec = parseSpec(task.verifier_spec);
  if (!parsedSpec.ok) return { ok: false, error: `the task carries no readable spec: ${parsedSpec.reason}`, status: 409 };
  const eventId = await submissionEventId(env, sub.id);
  if (eventId === null) return { ok: false, error: "submission event not found on the chain", status: 409 };

  const read = await readArtifact(env, sub.artifact);
  if (!read.ok) {
    if (read.retryable) {
      await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "unreadable", evidence: { reason: read.reason, retryable: true } });
      return { ok: true, result: "unreadable" };
    }
    const reason = reasonLimit(`${ACTOR}: rejected. The artifact could not be read: ${read.reason}. This verdict clears the pending slot; a fresh submission is welcome.`);
    const applied = await applyVerdict(env, task, sub, "rejected", reason, {
      actor: ACTOR,
      on_behalf_of: task.author,
      evidence: { verifier: NAME, version: 1, submission_event_id: eventId, artifact_readable: false, reason: read.reason },
    });
    if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
    await recordCheck(env, { submission_id: sub.id, task_id: task.id, verifier: ID, stage: "intake", result: "rejected", evidence: { artifact_readable: false, reason: read.reason } });
    return { ok: true, result: "rejected" };
  }

  const { findings } = checkAgainstSpec(parsedSpec.spec, read.text);
  const failed = findings.filter((f) => !f.ok);
  const verdict = failed.length === 0 ? "accepted" : "rejected";
  const evidence = {
    verifier: NAME,
    version: 1,
    submission_event_id: eventId,
    artifact_source: read.source as ArtifactSource,
    spec: parsedSpec.spec,
    findings,
    proves: SCHEMA_CHECK_MANIFEST.proves,
  };
  const say = (f: SchemaFinding) => `${f.rule}: ${f.detail}`;
  const reason = reasonLimit(
    verdict === "accepted"
      ? `${ACTOR}: every rule the author published holds. ${findings.map(say).join("; ")}. This proves the artifact satisfies that spec; nothing about whether the spec was the right one.`
      : `${ACTOR}: rejected. ${failed.map(say).join("; ")}. The rules that held: ${findings.filter((f) => f.ok).map((f) => f.rule).join("; ") || "none"}. The spec is on the task and on the chain; this verdict clears the pending slot and a corrected submission is welcome.`,
  );
  const applied = await applyVerdict(env, task, sub, verdict, reason, { actor: ACTOR, on_behalf_of: task.author, evidence });
  if (!applied.ok) return { ok: false, error: applied.error, status: 409 };
  await recordCheck(env, {
    submission_id: sub.id,
    task_id: task.id,
    verifier: ID,
    stage: "intake",
    result: verdict,
    evidence: { rules: findings.length, failed: failed.length, artifact_source: read.source.kind },
  });
  return { ok: true, result: verdict };
}
