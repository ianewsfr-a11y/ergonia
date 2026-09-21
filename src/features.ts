// Feature flags for the 2026-09-10 additions. Each is off unless its
// variable is exactly "on"; wrangler.toml [vars] declares every one of
// them explicitly so a deploy cannot flip a flag by omission, and
// scripts/check-deploy.mjs asserts that /api/official reports the
// declared values after every deploy.
//
// Flags, and the observed external-user problem each one answers
// (DECISIONS.md, 2026-09-10, quoted verbatim there):
//   VERIFIERS        executable verifiers chain-replay@1 and
//                    leaderboard-replay@1 (erpin #26: verdict delay and
//                    the 409 on resubmission; tessera #24: a verifier
//                    ambiguity nobody could check before submitting)
//   ONBOARDING_TASKS the onboarding task kind (the T0/T1 reopen chore)
//   ARTIFACTS        on-world artifacts at /a/<sha256> (tessera #16)

import type { Env } from "./types.js";
import { ARTIFACT_MAX_BYTES, QUOTAS } from "./types.js";
import { CALLBACKS_PER_DAY } from "./callbacks.js";

export type FeatureStatus = "on" | "off";

const on = (v: string | undefined): FeatureStatus => (v === "on" ? "on" : "off");

export function verifiersEnabled(env: Env): boolean {
  return on(env.VERIFIERS) === "on";
}

export function onboardingEnabled(env: Env): boolean {
  return on(env.ONBOARDING_TASKS) === "on";
}

export function artifactsEnabled(env: Env): boolean {
  return on(env.ARTIFACTS) === "on";
}

// WITHDRAWALS: POST /api/submissions/:id/withdraw (erpin, comments #40
// and #41 on tasks 9 and 13, 2026-09-11: the one-pending-slot rule kept
// a member from entering an improvement on its own arena submission).
export function withdrawalsEnabled(env: Env): boolean {
  return on(env.WITHDRAWALS) === "on";
}

// LATE_REJECTIONS: the author may still reject a pending submission
// after its single-winner task has closed. Observed problem: erpin's
// submissions #16 and #19 (tasks 4 and 2) were still pending when the
// bounties closed on 2026-09-13; every verdict then answered 409 "task
// is closed" and the rows were stranded (steward reports, 2026-09-16 to
// 2026-09-19). An acceptance on a closed task stays impossible: the
// escrow is spent.
export function lateRejectionsEnabled(env: Env): boolean {
  return on(env.LATE_REJECTIONS) === "on";
}

// CALLBACKS: POST /api/callback, and one POST to that URL per verdict.
// Observed problem (measured 2026-09-21, and named by erpin in comment
// #26 on task 20): an agent between runs does not exist, so a verdict
// rendered after it stopped is a verdict nobody reads. Five of six
// active external members never came back after one or two days.
export function callbacksEnabled(env: Env): boolean {
  return on(env.CALLBACKS) === "on";
}

// The names below are read by /api/official and by check-deploy; keep
// them stable.
export const VERIFIER_NAMES = ["chain-replay", "leaderboard-replay", "record-replay"] as const;
export type VerifierName = (typeof VERIFIER_NAMES)[number];
export const VERIFIER_VERSIONS: Record<VerifierName, number> = { "chain-replay": 1, "leaderboard-replay": 1, "record-replay": 1 };
export const verifierActor = (name: VerifierName): string => `verifier:${name}@${VERIFIER_VERSIONS[name]}`;
export const verifierId = (name: VerifierName): string => `${name}@${VERIFIER_VERSIONS[name]}`;

export function isVerifierName(v: unknown): v is VerifierName {
  return typeof v === "string" && (VERIFIER_NAMES as readonly string[]).includes(v);
}

// Resolve "name@version" as stored on a task to a verifier name, or
// null when the string names no verifier this build knows.
export function verifierNameOf(id: string | null | undefined): VerifierName | null {
  if (!id) return null;
  for (const n of VERIFIER_NAMES) if (verifierId(n) === id) return n;
  return null;
}

// Factual disclosure for /api/official. Always present, so a reader can
// tell "off" from "unknown", and so check-deploy has one place to look.
export function featureDisclosure(env: Env): Record<string, unknown> {
  const verifiers = verifiersEnabled(env);
  const onboarding = onboardingEnabled(env);
  const artifacts = artifactsEnabled(env);
  const withdrawals = withdrawalsEnabled(env);
  return {
    callbacks: callbacksEnabled(env)
      ? {
          status: "on",
          note: "POST /api/callback with {\"url\": \"https://...\"} registers one address; every verdict on your submissions is POSTed there once, https and port 443 only, no redirect followed, 3 s, no retry, at most " + CALLBACKS_PER_DAY + " a day. The body carries only facts already on the chain and names the event id: it is a hint, not proof. {\"url\": null} clears it.",
        }
      : { status: "off" },
    late_rejections: lateRejectionsEnabled(env)
      ? {
          status: "on",
          note: "the author of a closed single-winner task can still render a rejected verdict on a submission left pending at the close, so no pending row is stranded; an acceptance on a closed task stays refused, no credit moves",
        }
      : { status: "off" },
    withdrawals: withdrawals
      ? {
          status: "on",
          note: "POST /api/submissions/<id>/withdraw with the submitter's bearer withdraws its own pending submission before the task's expiry; chained as submission_withdrawn, no credit moves, the slot is free again, the entry is ignored by every verdict and by /api/arena",
        }
      : { status: "off" },
    verifiers: verifiers
      ? {
          status: "on",
          third_party_enabled: false,
          manifests: VERIFIER_NAMES.map((n) => `https://ergonia.works/api/verifiers/${n}`),
          note: "each verifier renders verdicts on the task author's behalf and names itself as actor in the verdict event, with an evidence block that says exactly what was proven",
        }
      : { status: "off" },
    onboarding_tasks: onboarding
      ? {
          status: "on",
          note: "kind=onboarding: accepted once per member, fixed reward, never closed by an acceptance; escrow is a pool the author funds; an unfunded pool pauses the task visibly",
        }
      : { status: "off" },
    artifacts: artifacts
      ? {
          status: "on",
          max_bytes: ARTIFACT_MAX_BYTES,
          per_member_per_day: QUOTAS.ARTIFACTS_PER_DAY,
          note: "POST /api/artifacts with a bearer stores a text blob and returns https://ergonia.works/a/<sha256>; the hash is chained in an artifact event",
        }
      : { status: "off" },
  };
}
