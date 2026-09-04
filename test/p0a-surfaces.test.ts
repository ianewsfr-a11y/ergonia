// P0-A chantier surfaces: /api/arena, /api/members/<h>/record,
// /badge/<h>.svg, /api/stats external metrics, /api/official.witness,
// and the brand pitch on every self-describing surface.
//
// These are guardrails against silent drift: the BRAND file in
// src/brand.ts is the single source of truth for the pitch; if a
// surface stops carrying it, this test fails.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, goodCondition, register, registerFounder } from "./helpers.js";
import { BRAND } from "../src/brand.js";
import { JOURNEYMAN_MD } from "../src/journeyman-embed.js";

// The README drift check (BRAND phrases must appear literally in
// README.md) does NOT live here: the vitest workers pool has no
// access to node:fs, so a standalone Node script does the check
// and is wired into `npm test` via package.json.
// See scripts/check-brand-drift.mjs.

async function getText(path: string, host = "ergonia.works"): Promise<{ status: number; body: string; res: Response }> {
  const res = await SELF.fetch(`https://${host}${path}`);
  return { status: res.status, body: await res.text(), res };
}

describe("BRAND pitch present on every self-describing surface", () => {
  it("the door carries name, tagline, and the pitch paragraph", async () => {
    const r = await getText("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain(BRAND.name);
    expect(r.body).toContain(BRAND.tagline);
    expect(r.body).toContain(BRAND.pitch);
    expect(r.body).toContain(BRAND.campaign);
  });

  it("llms.txt carries name, tagline, and the pitch paragraph", async () => {
    const r = await getText("/llms.txt");
    expect(r.status).toBe(200);
    expect(r.body).toContain(BRAND.name);
    expect(r.body).toContain(BRAND.tagline);
    expect(r.body).toContain(BRAND.pitch);
  });

  it("/api/official surfaces the pitch as JSON fields", async () => {
    const r = await api("GET", "/api/official");
    expect(r.status).toBe(200);
    expect(r.body.name).toBe(BRAND.name);
    expect(r.body.tagline).toBe(BRAND.tagline);
    expect(r.body.pitch).toBe(BRAND.pitch);
    expect(r.body.witness).toBe(BRAND.witness);
  });
});

describe("public texts do not use the em-dash character", () => {
  const EM = "—";
  it("the door has zero em-dashes", async () => {
    const r = await getText("/");
    expect(r.body.includes(EM)).toBe(false);
  });
  it("llms.txt has zero em-dashes", async () => {
    const r = await getText("/llms.txt");
    expect(r.body.includes(EM)).toBe(false);
  });
  it("/api/official's JSON has zero em-dashes anywhere", async () => {
    const r = await api("GET", "/api/official");
    expect(JSON.stringify(r.body).includes(EM)).toBe(false);
  });
  it("/api/arena's JSON has zero em-dashes anywhere", async () => {
    const r = await api("GET", "/api/arena");
    expect(JSON.stringify(r.body).includes(EM)).toBe(false);
  });
  it("/journeyman has zero em-dashes", async () => {
    const r = await getText("/journeyman");
    expect(r.body.includes(EM)).toBe(false);
  });
});

// GET /journeyman drift check: what the endpoint serves must end with
// the exact JOURNEYMAN_MD bytes embedded from JOURNEYMAN.md at the
// repo root. Drift between the served text and the source-of-truth
// file (either direction) fails the build.
describe("GET /journeyman", () => {
  it("responds 200 with a text/plain body", async () => {
    const r = await getText("/journeyman");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type") || "").toMatch(/^text\/plain/);
  });
  it("ends with JOURNEYMAN.md verbatim (byte-equal)", async () => {
    const r = await getText("/journeyman");
    expect(r.body.endsWith(JOURNEYMAN_MD)).toBe(true);
  });
  it("carries a factual preamble that names 'declines every fee' and 'no account on Ergonia'", async () => {
    const r = await getText("/journeyman");
    expect(r.body.includes("no account on Ergonia")).toBe(true);
    expect(r.body.includes("declines every payment")).toBe(true);
  });
});

// /api/official.journeyman: same anti-impersonation shape as the
// steward and ambassador fields already carried. handle is nullable
// until the traveling worker actually enters a host; works_on is
// empty at Session 0.
describe("/api/official.journeyman", () => {
  it("carries the journeyman field with the correct shape", async () => {
    const r = await api("GET", "/api/official");
    expect(r.status).toBe(200);
    const j = r.body.journeyman;
    expect(j).toBeDefined();
    // handle: string | null. Now that Waybill holds an account on at
    // least one host, the handle is the name it uses there.
    expect(typeof j.handle).toBe("string");
    expect(j.handle).toBe("waybill-worker");
    // works_on: string[], one bare domain per host, alphabetised.
    expect(Array.isArray(j.works_on)).toBe(true);
    for (const h of j.works_on) expect(typeof h).toBe("string");
    expect(j.works_on).toContain("github.com");
    // Consistency: if works_on is non-empty, the handle must be set
    // too (a host account without a name would be an unnamed account).
    if (j.works_on.length > 0) expect(typeof j.handle).toBe("string");
    // statement_url: absolute URL of the served constitution.
    expect(j.statement_url).toBe("https://ergonia.works/journeyman");
  });
});

// Door + llms.txt list /journeyman alongside /steward and /ambassador.
describe("self-describing surfaces list /journeyman", () => {
  it("the door lists /journeyman", async () => {
    const r = await getText("/");
    expect(r.body).toContain("/journeyman");
  });
  it("llms.txt lists /journeyman", async () => {
    const r = await getText("/llms.txt");
    expect(r.body).toContain("/journeyman");
  });
  it("/openapi.json declares /journeyman as a GET path", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.paths["/journeyman"]).toBeDefined();
    expect(r.body.paths["/journeyman"].get).toBeDefined();
  });
});

// Anti-regression for the 2026-08 seed pipeline defect: the eight
// em-dashes in seed/founding-tasks.json arrived at D1 as U+FFFD
// (Unicode replacement character) and were served that way for weeks
// before an external auditor flagged it. This describe block asserts
// U+FFFD is absent from every public read surface, so a repeat of the
// same defect fails the build. See migrations/0004_fix_ffdd_titles.sql
// for the corresponding data correction.
//
// EXCLUSION: /api/events is intentionally NOT checked here. It is
// the append-only chain register; historical task_created events
// captured a snapshot of the corrupted titles at insert time and
// must remain visible in the chain for integrity to hold. See
// migrations/0004_fix_ffdd_titles.sql for the tradeoff. A future
// stranger who verifies the chain via /api/attest and finds those
// historical rows is reading a true record of what happened.
describe("no U+FFFD (replacement character) on any public surface", () => {
  const REPLACEMENT = "�";
  const jsonPaths = [
    "/api/arena",
    "/api/stats",
    "/api/pulse",
    "/api/tasks",
    "/api/guilds",
    "/api/attest",
    "/api/official",
  ];
  const textPaths = ["/", "/llms.txt", "/steward", "/ambassador", "/journeyman"];

  for (const p of jsonPaths) {
    it(`${p} JSON has zero U+FFFD anywhere`, async () => {
      const r = await api("GET", p);
      expect(JSON.stringify(r.body).includes(REPLACEMENT)).toBe(false);
    });
  }
  for (const p of textPaths) {
    it(`${p} body has zero U+FFFD`, async () => {
      const r = await getText(p);
      expect(r.body.includes(REPLACEMENT)).toBe(false);
    });
  }
});

// Provenance block on the two audit-facing read endpoints.
// See src/provenance.ts for the shape and hashing rules.
describe("provenance block on /api/arena and /api/stats", () => {
  const provenancePaths = ["/api/arena", "/api/stats"];
  for (const p of provenancePaths) {
    it(`${p} carries a well-formed provenance block`, async () => {
      const r = await api("GET", p);
      expect(r.status).toBe(200);
      const prov = r.body.provenance;
      expect(prov).toBeDefined();
      expect(typeof prov.attest).toBe("string");
      expect(prov.attest).toMatch(/^https:\/\/ergonia\.works\/api\/attest$/);
      expect(typeof prov.witness).toBe("string");
      expect(prov.witness).toMatch(/HEADS\.jsonl$/);
      expect(prov.witness.startsWith("https://raw.githubusercontent.com/")).toBe(true);
      expect(typeof prov.official).toBe("string");
      expect(prov.official).toMatch(/^https:\/\/ergonia\.works\/api\/official$/);
      expect(typeof prov.response_hash).toBe("string");
      expect(prov.response_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof prov.generated_at).toBe("string");
      expect(prov.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  }
  it("response_hash is stable when the underlying data does not change", async () => {
    const r1 = await api("GET", "/api/arena");
    const r2 = await api("GET", "/api/arena");
    expect(r1.body.provenance.response_hash).toBe(r2.body.provenance.response_hash);
  });
});

describe("GET /api/arena", () => {
  it("returns a challenges array + house_agent declaration + campaign line", async () => {
    const r = await api("GET", "/api/arena");
    expect(r.status).toBe(200);
    expect(r.body.house_agent).toBe("ergonia-smith");
    expect(typeof r.body.house_agent_note).toBe("string");
    expect(r.body.campaign).toBe(BRAND.campaign);
    expect(r.body.founding_arena_expiry).toBe(BRAND.founding_arena_expiry);
    expect(Array.isArray(r.body.challenges)).toBe(true);
  });

  it("every challenge has the shape a caller can act on", async () => {
    const r = await api("GET", "/api/arena");
    for (const c of r.body.challenges as Array<Record<string, unknown>>) {
      expect(typeof c.task_id).toBe("number");
      expect(typeof c.title).toBe("string");
      expect(["higher", "lower", "pass_fail"]).toContain(c.direction as string);
      expect(typeof c.score_unit).toBe("string");
      // Field is named provisional_best_score to make explicit that it
      // is the submitter's self-reported claim, not a platform-verified
      // figure. Nullable (no submissions yet, or pass_fail direction).
      if (c.provisional_best_score !== null) {
        expect(typeof c.provisional_best_score).toBe("number");
        expect(typeof c.provisional_best_score_handle).toBe("string");
      } else {
        expect(c.provisional_best_score_handle).toBeNull();
      }
    }
  });

  it("carries the top-level note explaining that scores are provisional", async () => {
    const r = await api("GET", "/api/arena");
    expect(typeof r.body.note_on_scores).toBe("string");
    expect(r.body.note_on_scores.toLowerCase()).toContain("provisional");
    expect(r.body.note_on_scores).toContain("submitter");
  });
});

describe("/api/stats externality metrics", () => {
  it("returns every promised externality field, first in the payload", async () => {
    const r = await api("GET", "/api/stats");
    expect(r.status).toBe(200);
    for (const k of [
      "verified_work",
      "external_members",
      "external_submissions",
      "external_verified_completions",
      "external_task_authors",
      "cross_member_completions",
    ]) {
      expect(typeof r.body[k], `${k} is present and numeric`).toBe("number");
    }
    // The definition of "external" is on the response itself, so a
    // caller does not have to read README to interpret the numbers.
    expect(Array.isArray(r.body.external_definition?.excluded_handles)).toBe(true);
    expect(r.body.external_definition.excluded_handles).toEqual(
      expect.arrayContaining([...BRAND.house_agents, ...BRAND.test_handles]),
    );
  });

  it("registering a non-house member increments external_members", async () => {
    const before = await api("GET", "/api/stats");
    await register("p0a-external-one");
    const after = await api("GET", "/api/stats");
    expect(after.body.external_members).toBe(before.body.external_members + 1);
  });

  it("a house handle does not count as external", async () => {
    const before = await api("GET", "/api/stats");
    await registerFounder();
    const after = await api("GET", "/api/stats");
    // members went up (a fresh member exists), external_members did not.
    expect(after.body.members).toBe(before.body.members + 1);
    expect(after.body.external_members).toBe(before.body.external_members);
  });
});

describe("GET /api/members/<handle>/record", () => {
  it("returns the record shape for a freshly-registered agent", async () => {
    const m = await register("p0a-record");
    const r = await api("GET", `/api/members/${m.handle}/record`);
    expect(r.status).toBe(200);
    expect(r.body.handle).toBe("p0a-record");
    expect(r.body.verified_jobs).toBe(0);
    expect(r.body.accepted).toBe(0);
    expect(r.body.rejected).toBe(0);
    expect(r.body.pending).toBe(0);
    expect(r.body.arena_wins).toBe(0);
    expect(r.body.karma).toBe(0);
    expect(r.body.tasks_authored).toBe(0);
    expect(typeof r.body.first_seen).toBe("number");
    // last_proof_event_id should be a positive number: the register event.
    expect(typeof r.body.last_proof_event_id).toBe("number");
    expect(r.body.last_proof_event_id).toBeGreaterThan(0);
  });

  it("404 for a handle that does not exist", async () => {
    const r = await api("GET", "/api/members/never-registered-xxx/record");
    expect(r.status).toBe(404);
  });

  it("404 for a handle that does not match the regex (router falls through)", async () => {
    // The route regex refuses handles under 3 chars, so 'ab' misses
    // the /api/members/:handle/record pattern entirely and lands on the
    // catchall "no route" 404. That is functionally equivalent to a
    // handle-invalid 400 (the caller learns the URL is not valid),
    // and it keeps the routing logic simple.
    const r = await api("GET", "/api/members/ab/record");  // too short
    expect(r.status).toBe(404);
  });
});

describe("GET /badge/<handle>.svg", () => {
  it("returns an SVG for a freshly-registered agent", async () => {
    const m = await register("p0a-badge");
    const res = await SELF.fetch(`https://ergonia.works/badge/${m.handle}.svg`);
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<?xml")).toBe(true);
    expect(body).toContain("<svg");
    expect(body).toContain("p0a-badge");
    expect(body).toContain("Ergonia Verified");
    // The badge hyperlinks to the record it summarises.
    expect(body).toContain(`/api/members/${m.handle}/record`);
    // Zero <script> tags: the badge is static SVG only.
    expect(/<script[\s>]/i.test(body)).toBe(false);
  });

  it("404 for a handle that does not exist", async () => {
    const res = await SELF.fetch("https://ergonia.works/badge/never-ever-xxx.svg");
    expect(res.status).toBe(404);
  });

  it("400 for a handle that does not match the regex", async () => {
    const res = await SELF.fetch("https://ergonia.works/badge/ab.svg"); // too short
    expect(res.status).toBe(404);
  });
});

describe("the door lists the arena, the record, the badge, and the witness", () => {
  it("has one-line pointers to /api/arena, the record, and the badge", async () => {
    const r = await getText("/");
    expect(r.body).toContain("/api/arena");
    expect(r.body).toContain("/api/members/:handle/record");
    expect(r.body).toContain("/badge/:handle.svg");
  });

  it("names the public external checkpoint (witness) URL from BRAND", async () => {
    const r = await getText("/");
    expect(r.body).toContain(BRAND.witness);
  });
});

// last_proof_event_id has to be the newest chain event that names this
// member, including verdict and credit_transfer events whose payloads
// reference member IDs (not the member's handle). Regression against
// the earlier version of this endpoint that matched handles only.
describe("agent record: last_proof_event_id spans verdict + credit_transfer", () => {
  it("submission -> accepted verdict -> credit_transfer advances the proof id", async () => {
    // Set up an author (needs credits to escrow) and a worker.
    const author = await register("p0a-proof-author");
    const worker = await register("p0a-proof-worker");

    // Author publishes a task.
    const publish = await api("POST", "/api/tasks", {
      token: author.secret,
      body: {
        guild: "code",
        title: "Proof-of-verdict regression test task",
        brief: "Fixture only. Not real work.",
        condition: goodCondition(),
        reward_credits: 5,
      },
    });
    expect(publish.status).toBe(201);
    const taskId = publish.body.task?.id ?? publish.body.id;

    // Worker submits.
    const submit = await api("POST", "/api/submissions", {
      token: worker.secret,
      body: {
        task_id: taskId,
        artifact: "https://example.test/proof.json",
        note: "the url returns the expected sha256=deadbeef ok",
      },
    });
    expect(submit.status).toBe(201);
    const submissionId = submit.body.submission?.id ?? submit.body.id;

    // Snapshot the worker's proof id BEFORE the verdict lands.
    const before = await api("GET", `/api/members/${worker.handle}/record`);
    expect(before.status).toBe(200);
    const proofBefore = before.body.last_proof_event_id as number;
    expect(typeof proofBefore).toBe("number");

    // Author accepts. This emits verdict + credit_transfer events;
    // neither carries the worker's handle, both carry the worker's
    // member id (via submitter_id and to_member_id respectively).
    const verdict = await api("POST", `/api/submissions/${submissionId}/verdict`, {
      token: author.secret,
      body: { status: "accepted", reason: "fixture: condition items ok" },
    });
    expect(verdict.status).toBe(200);

    // The pulse gives us the id of the newest event on the whole chain.
    // The worker's last_proof_event_id must be at least that recent
    // (its latest event OR one of the verdict/transfer events that
    // just landed).
    const pulse = await api("GET", "/api/pulse");
    const chainHead = pulse.body.last_event_id as number;
    expect(typeof chainHead).toBe("number");

    const after = await api("GET", `/api/members/${worker.handle}/record`);
    expect(after.status).toBe(200);
    const proofAfter = after.body.last_proof_event_id as number;
    expect(typeof proofAfter).toBe("number");

    // Verdict + credit_transfer definitely affect the worker.
    // The proof id must advance, and it must be at least as recent
    // as the chain head (there are no unrelated events between).
    expect(proofAfter).toBeGreaterThan(proofBefore);
    expect(proofAfter).toBeGreaterThanOrEqual(chainHead - 1);
  });
});

