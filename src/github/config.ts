// G1 GitHub integration: configuration, flag, and the dogfood allowlist.
//
// DOGFOOD ONLY. This is the one named exception to the external-user
// rule (CLAUDE.md). Everything here fails closed:
//   - the integration is off unless GITHUB_INTEGRATION === "on";
//   - only the two repositories below can ever create Ergonia state,
//     matched on GitHub's immutable numeric id AND the full name;
//   - installations are recorded only for the allowlisted owner account.
// A webhook from anywhere else is ignored without a database write.

import type { Env } from "../types.js";

// The house principal that authors every GitHub-originated task and on
// whose behalf the verifier issues verdicts. Declared in
// BRAND.house_agents before it exists (DECISIONS.md, "declaration
// before existence"), excluded from every external metric, disclosed on
// /api/official. It has no usable secret: the row is provisioned by the
// server itself and the plaintext secret is discarded at creation.
export const GITHUB_PRINCIPAL_HANDLE = "ergonia-bounties";
export const GITHUB_PRINCIPAL_MODEL = "github-app:ergonia-bounties";

// The trigger label, exact spelling (lower-case, hyphen). Similar
// spellings are no-ops by design.
export const BOUNTY_LABEL = "ergonia-bounty";

export const VERIFIER_NAME = "github-checks";
export const VERIFIER_VERSION = 1;
export const VERIFIER_ACTOR = `verifier:${VERIFIER_NAME}@${VERIFIER_VERSION}`;

// Reward per task during dogfood, escrowed from the principal's own
// balance at opening. Zero is legal per the spec; the platform's task
// validation requires >= 1, and a real escrow is what the dogfood is
// meant to exercise.
export const DEFAULT_REWARD_CREDITS = 10;
export const DEFAULT_EXPIRY_DAYS = 90;
// The verifier processes one (submission, head sha) pair at most once
// per cool-off window (flaky CI convergence, spec "Cas tordus").
export const COOL_OFF_MS = 30_000;

export const GITHUB_API_DEFAULT = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const USER_AGENT = "ergonia-bounties (https://ergonia.works/api/official)";

export interface AllowedRepo {
  id: number;
  full_name: string;
}

// Immutable ids read from the GitHub API on 2026-09-04. A rename keeps
// the id but changes the name; a transfer keeps the id too. Requiring
// BOTH to match means a renamed or transferred repository stops
// creating work until this list is updated on purpose.
export const ALLOWED_OWNER = Object.freeze({ id: 278779481, login: "ianewsfr-a11y", type: "User" });
export const ALLOWED_REPOS: readonly AllowedRepo[] = Object.freeze([
  { id: 1348332583, full_name: "ianewsfr-a11y/ergonia" },
  { id: 1351724622, full_name: "ianewsfr-a11y/ergonia-blog" },
]);

export function integrationEnabled(env: Env): boolean {
  return env.GITHUB_INTEGRATION === "on";
}

// Both the id and the name must match one entry. Returns the entry so
// callers use the canonical name, never the one from the payload.
export function allowedRepo(id: unknown, fullName: unknown): AllowedRepo | null {
  if (typeof id !== "number" || typeof fullName !== "string") return null;
  for (const r of ALLOWED_REPOS) {
    if (r.id === id && r.full_name === fullName) return r;
  }
  return null;
}

export function allowedOwner(accountId: unknown, login: unknown): boolean {
  return accountId === ALLOWED_OWNER.id && login === ALLOWED_OWNER.login;
}

export function githubApiBase(env: Env): string {
  const b = env.GITHUB_API_BASE;
  return typeof b === "string" && b.length > 0 ? b.replace(/\/+$/, "") : GITHUB_API_DEFAULT;
}

// The secrets the webhook needs. Their VALUES are never read here
// beyond a presence check, never logged, never echoed.
export function missingSecrets(env: Env): string[] {
  const out: string[] = [];
  if (!env.GITHUB_WEBHOOK_SECRET) out.push("GITHUB_WEBHOOK_SECRET");
  if (!env.GITHUB_APP_ID) out.push("GITHUB_APP_ID");
  if (!env.GITHUB_APP_PRIVATE_KEY) out.push("GITHUB_APP_PRIVATE_KEY");
  return out;
}
