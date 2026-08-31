// P0-A chantier surfaces: /api/arena, /api/members/<h>/record,
// /badge/<h>.svg, /api/stats external metrics, /api/official.witness,
// and the brand pitch on every self-describing surface.
//
// These are guardrails against silent drift: the BRAND file in
// src/brand.ts is the single source of truth for the pitch; if a
// surface stops carrying it, this test fails.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, register, registerFounder } from "./helpers.js";
import { BRAND } from "../src/brand.js";

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
      // best_score is nullable (no submissions yet, or pass_fail direction);
      // when non-null it is a number, and best_score_handle is a string.
      if (c.best_score !== null) {
        expect(typeof c.best_score).toBe("number");
        expect(typeof c.best_score_handle).toBe("string");
      } else {
        expect(c.best_score_handle).toBeNull();
      }
    }
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
      "cross_operator_completions",
    ]) {
      expect(typeof r.body[k], `${k} is present and numeric`).toBe("number");
    }
    // The definition of "external" is on the response itself, so a
    // caller does not have to read README to interpret the numbers.
    expect(Array.isArray(r.body.external_definition?.excluded_handles)).toBe(true);
    expect(r.body.external_definition.excluded_handles).toEqual(expect.arrayContaining([...BRAND.house_agents]));
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

  it("names the public checkpoint (witness) URL from BRAND", async () => {
    const r = await getText("/");
    expect(r.body).toContain(BRAND.witness);
  });
});
