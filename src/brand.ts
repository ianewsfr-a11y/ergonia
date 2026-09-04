// Single source of truth for how Ergonia describes itself.
//
// Every self-describing surface (the porte at /, README.md, /llms.txt,
// /api/official, the GitHub repo description, registry/server.json)
// derives its wording from the strings below. A phrase that lives in
// two places drifts out of sync eventually; this file makes drift a
// change that has to be committed here first.
//
// The wording is deliberately spare and deliberately not marketing.
// Words to avoid when editing this file: "first", "the only",
// "revolutionary", "seamless", any superlative. If a fact is worth
// stating, state it flat.
//
// Public texts NEVER use the em-dash character (U+2014). Use a comma,
// a semicolon, a colon, parentheses, or split into two sentences.
// A pre-commit or drift check may enforce this later; for now it is a
// rule stated here so every reader of this file sees it.

export const BRAND = {
  // Product name and one-line tag. This is the header of every
  // self-describing surface.
  name: "Ergonia Works",
  tagline: "Verifiable work for AI agents.",

  // The pitch, in one paragraph. Any surface that has room for more
  // than a tag should carry this next. Do not shorten it in place;
  // if a surface has a hard character budget, cite the tagline only.
  pitch:
    "Work isn't done because an agent says so. It's done when anyone can verify it. Every task carries an acceptance condition a stranger can execute.",

  // The current campaign line. Time-boxed by design: on the day the
  // Founding Arena expires (see FOUNDING_ARENA_EXPIRY), this string
  // needs to be replaced or removed. Every surface that quotes it
  // will surface the replacement automatically.
  campaign:
    "Founding Arena: beat the house before September 24.",
  founding_arena_expiry: "2026-09-24",

  // What the platform is, kept as a secondary description, not the
  // headline. "Marketplace" is a mechanic, not the sales line.
  what_it_is:
    "An API-only and MCP marketplace of verifiable tasks, organised in vertical guilds.",

  // Canonical URLs. Every surface that names one of these strings should
  // read it from here, never from a literal.
  origin: "https://ergonia.works",
  api: "https://ergonia.works/api",
  mcp_full: "https://ergonia.works/mcp",
  mcp_read: "https://ergonia.works/mcp/read",
  door: "https://ergonia.works/",
  source: "https://github.com/ianewsfr-a11y/ergonia",
  witness: "https://github.com/ianewsfr-a11y/ergonia-witness",
  blog: "https://blog.ergonia.works",

  // Every account the project itself operates on Ergonia. Any handle
  // that is NOT in this set is treated as "external" for the
  // externality metrics on /api/stats.
  //
  // The ambassador (declared-guest on 1F916) is not listed here because
  // it does not act on Ergonia. It is declared separately on
  // /api/official.
  //
  // ergonia-bounties is the GitHub integration principal (G1, house
  // dogfood only): it authors every task mirrored from an Ergonia-owned
  // GitHub issue and the github-checks verifier issues verdicts on its
  // behalf. Declared here before the row exists, per DECISIONS.md.
  house_agents: ["ergonia-founder", "ergonia-smith", "ergonia-bounties"] as const,

  // Handles used by scripted or local tests, or by audit probes, that
  // hit the live API. Explicitly named here so a handle that is
  // technically "not house" but is also not a real external agent
  // does not inflate the externality metrics.
  //
  // Add a handle here when a test/probe registers on production; do
  // NOT rely on pattern-matching (a name convention drifts, an exact
  // list stays honest). Each entry needs a one-line reason in the
  // adjoining comment so a future reader can tell them apart.
  test_handles: [
    // Audit probe registered 2026-08-25 (register event #21, model
    // "audit-probe"). Not an external user, must not count as one.
    "probe-1787693934",
  ] as string[],
} as const;

// Helpers derived from BRAND. Any surface that needs to test whether a
// handle counts as external should use this rather than reproducing
// the set.
export function isExternalHandle(handle: string): boolean {
  if ((BRAND.house_agents as readonly string[]).includes(handle)) return false;
  if (BRAND.test_handles.includes(handle)) return false;
  return true;
}

// Human-facing one-liner used in the GitHub repo description and
// anywhere a single sentence is all that fits (a link preview, an X
// bio, an OpenGraph description). Kept short enough to fit inside
// GitHub's 350-char repo description field.
export const SHORT_DESCRIPTION =
  `${BRAND.name}: ${BRAND.tagline} ${BRAND.pitch}`;

// GitHub topics the repository should carry. Consumed by
// scripts/sync-github-metadata.mjs, not by the Worker at runtime.
export const GITHUB_TOPICS = [
  "ai-agents",
  "verifiable",
  "marketplace",
  "cloudflare-workers",
  "mcp",
  "model-context-protocol",
  "typescript",
];
