// G1 surfaces: the verifier manifest, the /api/official disclosure, the
// reserved principal handle, the founder-only funding transfer, and
// the promise that nothing public mentions the integration.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BRAND } from "../../src/brand.js";
import { api, register, registerFounder } from "../helpers.js";
import { mockGithub } from "./fixtures.js";

beforeAll(() => mockGithub());

async function getText(path: string): Promise<string> {
  const { SELF } = await import("cloudflare:test");
  const res = await SELF.fetch("https://ergonia.test" + path);
  return res.text();
}

describe("GET /api/verifiers/github-checks", () => {
  it("serves the manifest with its identity, the decision rule, and what it proves", async () => {
    const r = await api("GET", "/api/verifiers/github-checks");
    expect(r.status).toBe(200);
    expect(r.body.verifier).toBe("github-checks");
    expect(r.body.version).toBe(1);
    expect(r.body.third_party_enabled).toBe(false);
    expect(r.body.decide.accept_if).toContain("required_checks");
    expect(r.body.decide.reject_if).toContain("merged == false");
    expect(r.body.proves).toContain("not a claim that the issue is fixed");
    expect(r.body.actor).toBe("verifier:github-checks@1");
    expect(JSON.stringify(r.body).includes("—")).toBe(false);
  });
});

describe("/api/official discloses the factual internal status", () => {
  it("carries github_integration with house_dogfood and third_party_enabled false", async () => {
    const r = await api("GET", "/api/official");
    const g = r.body.github_integration;
    expect(g.status).toBe("house_dogfood");
    expect(g.third_party_enabled).toBe(false);
    expect(g.principal).toBe("ergonia-bounties");
    expect(g.repositories).toEqual(["ianewsfr-a11y/ergonia", "ianewsfr-a11y/ergonia-blog"]);
    expect(r.body.house_agents).toContain("ergonia-bounties");
    expect(JSON.stringify(r.body).includes("—")).toBe(false);
  });
  it("BRAND.house_agents lists the principal, so it is never external", () => {
    expect(BRAND.house_agents).toContain("ergonia-bounties");
  });
});

describe("the principal handle is reserved", () => {
  it("cannot be registered by anyone", async () => {
    const r = await api("POST", "/api/register", { body: { handle: "ergonia-bounties", model: "x-1" } });
    expect(r.status).toBe(403);
  });
});

describe("POST /api/github/fund", () => {
  it("is founder-only", async () => {
    const m = await register("not-the-founder");
    const r = await api("POST", "/api/github/fund", { token: m.secret, body: { amount: 5 } });
    expect(r.status).toBe(403);
    expect((await api("POST", "/api/github/fund", { body: { amount: 5 } })).status).toBe(401);
  });
  it("moves credits from the founder to the principal, chained as credit_transfer reason house_grant, minting nothing", async () => {
    const f = await registerFounder();
    const before = await api("GET", "/api/stats");
    const r = await api("POST", "/api/github/fund", { token: f.secret, body: { amount: 40, reason: "dogfood escrow" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.granted).toBe(40);
    expect(r.body.reason).toBe("house_grant");
    const principal = await env.DB.prepare("SELECT credits FROM members WHERE handle = 'ergonia-bounties'").first<{ credits: number }>();
    expect(principal?.credits).toBe(140);
    const me = await api("GET", "/api/me", { token: f.secret });
    expect(me.body.credits).toBe(60);
    const ev = await api("GET", "/api/events?kind=credit_transfer");
    expect(ev.body.events[0].payload.reason).toBe("house_grant");
    expect(ev.body.events[0].payload.amount).toBe(40);
    const after = await api("GET", "/api/stats");
    // The principal's own registration endowment is the only new credit.
    expect(after.body.credits_total).toBe(before.body.credits_total + 100);
    expect(after.body.external_members).toBe(before.body.external_members);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });
  it("refuses more than the founder holds", async () => {
    const f = await registerFounder();
    const r = await api("POST", "/api/github/fund", { token: f.secret, body: { amount: 500 } });
    expect(r.status).toBe(402);
  });
});

describe("public exposure stays off", () => {
  const forbidden = ["github-checks", "ergonia-bounty", "/api/github", "GitHub App"];
  for (const p of ["/", "/llms.txt", "/steward", "/ambassador", "/journeyman"]) {
    it(`${p} does not mention the integration`, async () => {
      const body = await getText(p);
      for (const f of forbidden) expect(body.includes(f), `${p} mentions ${f}`).toBe(false);
    });
  }
  it("openapi.json does not list the integration paths", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.body.paths["/api/github/webhook"]).toBeUndefined();
    expect(r.body.paths["/api/verifiers/github-checks"]).toBeUndefined();
    expect(JSON.stringify(r.body).includes("ergonia-bounty")).toBe(false);
  });
  it("robots.txt does not point at it", async () => {
    const body = await getText("/robots.txt");
    expect(body.includes("github")).toBe(false);
  });
});

describe("/api/events accepts the new kinds", () => {
  it("filters by github_comment and github_installation", async () => {
    expect((await api("GET", "/api/events?kind=github_comment")).status).toBe(200);
    expect((await api("GET", "/api/events?kind=github_installation")).status).toBe(200);
    expect((await api("GET", "/api/events?kind=rotate")).status).toBe(200);
  });
});
