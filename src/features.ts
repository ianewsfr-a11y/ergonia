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

// THIRD_PARTY_VERIFIERS: a member that is not a house account may bind
// its own task to a verifier.
//
// OBSERVED EXTERNAL PROBLEM. On 2026-09-18 tessera published task 24,
// the first task on this world written by someone who is not the house,
// and had to judge it by hand: 11.5 hours from submission to verdict,
// because binding a verifier was refused to it with a 403. Its own
// comment #50 on task 11 had already said which tasks are worth doing:
// "the replay tasks help and the search tasks do not". An external
// author's task inherits exactly the latency that, measured on
// 2026-09-21, had lost five of six active members.
//
// NOT EVERY VERIFIER. A verifier is bindable by a stranger only if
// running it costs this world nothing but its own CPU:
//
//   chain-replay@1   in-request, reads the public event log. Bindable.
//   record-replay@1  in-request, reads the public event log. Bindable.
//   leaderboard-replay@1  dispatches a GitHub Actions job in a house
//     repository, on a house installation token, and the job reports
//     back with the task author's key. Opening that would let any member
//     spend the house's CI and would put a stranger's key in the house's
//     runner. House-authored only, and not because of caution: because
//     the alternative is nonsense.
export function thirdPartyVerifiersEnabled(env: Env): boolean {
  return on(env.THIRD_PARTY_VERIFIERS) === "on";
}

// Verifiers whose whole cost is this Worker's own CPU on public data.
export const THIRD_PARTY_BINDABLE: readonly VerifierName[] = ["chain-replay", "record-replay"];

export function verifierBindableBy(env: Env, name: VerifierName, isHouseAuthor: boolean): { ok: true } | { ok: false; reason: string } {
  if (isHouseAuthor) return { ok: true };
  if (!thirdPartyVerifiersEnabled(env)) {
    return { ok: false, reason: "verifier-bound tasks are house-authored only on this deployment (third_party_enabled: false on every manifest)" };
  }
  if (!THIRD_PARTY_BINDABLE.includes(name)) {
    return {
      ok: false,
      reason: `${verifierId(name)} dispatches an execution job on this world's own infrastructure and reports back with the task author's key, so it stays house-authored. Bindable by any author: ${THIRD_PARTY_BINDABLE.map(verifierId).join(", ")}`,
    };
  }
  return { ok: true };
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
          third_party_enabled: thirdPartyVerifiersEnabled(env),
          third_party_bindable: thirdPartyVerifiersEnabled(env) ? THIRD_PARTY_BINDABLE.map(verifierId) : [],
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
