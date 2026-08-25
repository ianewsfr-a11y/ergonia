// Security review regression suite for /api/admin/founder-grant and the
// reserved founder handle. Every test here maps to a finding in the
// post-phase-2 audit (see DECISIONS.md, "Security review").

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, register, registerFounder, TEST_ADMIN_SECRET } from "./helpers.js";
import { secretsMatch } from "../src/admin.js";

describe("reserved founder handle (V4)", () => {
  it("refuses to register ergonia-founder without the admin secret", async () => {
    const r = await api("POST", "/api/register", {
      body: { handle: "ergonia-founder", model: "claude-fable-5" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("reserved");
  });

  it("refuses to register it with a WRONG admin secret", async () => {
    const r = await api("POST", "/api/register", {
      body: { handle: "ergonia-founder", model: "claude-fable-5" },
      adminSecret: "not-the-secret",
    });
    expect(r.status).toBe(403);
  });

  it("allows it with the correct admin secret", async () => {
    const f = await registerFounder();
    expect(f.handle).toBe("ergonia-founder");
    expect(f.secret).toMatch(/^erg_sk_/);
  });

  it("leaves every other handle unaffected", async () => {
    const a = await register("alpha");
    expect(a.handle).toBe("alpha");
  });
});

describe("admin route gating (V3)", () => {
  it("401 without Bearer (route is enabled in tests)", async () => {
    const r = await api("POST", "/api/admin/founder-grant", {
      body: { amount: 1000 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(r.status).toBe(401);
  });

  it("404 — not 403 — when the admin secret is missing, so the route cannot be probed", async () => {
    const founder = await registerFounder();
    const r = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 1000 },
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("no route");
  });

  it("404 when the admin secret is wrong", async () => {
    const founder = await registerFounder();
    const r = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 1000 },
      adminSecret: "wrong-secret",
    });
    expect(r.status).toBe(404);
  });

  it("404 on any other /api/admin/* path", async () => {
    const r = await api("POST", "/api/admin/whatever", { adminSecret: TEST_ADMIN_SECRET });
    expect(r.status).toBe(404);
  });

  it("403 when a non-founder passes the admin gate", async () => {
    const other = await register("alpha");
    const r = await api("POST", "/api/admin/founder-grant", {
      token: other.secret,
      body: { amount: 1000 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("ergonia-founder");
  });

  it("secretsMatch is length-safe and value-correct", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "abcd")).toBe(false);
    expect(secretsMatch("", "")).toBe(true);
  });
});

describe("founder grant", () => {
  it("400 on invalid amount", async () => {
    const founder = await registerFounder();
    for (const amount of [0, -5, 999_999, 1.5, "100"]) {
      const r = await api("POST", "/api/admin/founder-grant", {
        token: founder.secret,
        body: { amount },
        adminSecret: TEST_ADMIN_SECRET,
      });
      expect(r.status, `amount=${amount}`).toBe(400);
    }
  });

  it("credits and chains a founder_grant event", async () => {
    const founder = await registerFounder();
    const r = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 1200, reason: "seed run" },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(r.status).toBe(200);
    expect(r.body.granted).toBe(1200);
    expect(r.body.member.credits).toBe(100 + 1200);
    expect(r.body.event.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.event.id).toBeGreaterThan(0);

    const events = await api("GET", "/api/events?kind=founder_grant");
    const list = events.body.events as Array<{ kind: string; payload: { handle: string; amount: number } }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.payload.handle).toBe("ergonia-founder");
    expect(list[0]!.payload.amount).toBe(1200);

    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);
  });

  it("never leaks the admin secret in the response body", async () => {
    const founder = await registerFounder();
    const r = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 10 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(JSON.stringify(r.body)).not.toContain(TEST_ADMIN_SECRET);
    expect(JSON.stringify(r.body)).not.toContain(founder.secret);
  });

  it("409 on a second grant to the same member (V1 fast path)", async () => {
    const founder = await registerFounder();
    await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 1200 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    const second = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 500 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("chain-wide");

    const me = await api("GET", "/api/me", { token: founder.secret });
    expect(me.body.credits).toBe(1300);
  });

  it("V1 — uniqueness is CHAIN-WIDE, not per member", async () => {
    // A grant exists for the founder. Rename that member out of the way
    // and register a *fresh* ergonia-founder: the old code scoped its
    // uniqueness check to member_id, so this second member could grant
    // itself a whole new endowment.
    const first = await registerFounder();
    const g = await api("POST", "/api/admin/founder-grant", {
      token: first.secret,
      body: { amount: 1200 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(g.status).toBe(200);

    await env.DB.prepare("UPDATE members SET handle = 'retired-founder' WHERE handle = 'ergonia-founder'").run();
    const second = await registerFounder();
    expect(second.id).not.toBe(first.id);

    const attempt = await api("POST", "/api/admin/founder-grant", {
      token: second.secret,
      body: { amount: 100_000 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    expect(attempt.status).toBe(409);

    // The new member keeps only its register endowment.
    const me = await api("GET", "/api/me", { token: second.secret });
    expect(me.body.credits).toBe(100);

    const events = await api("GET", "/api/events?kind=founder_grant");
    expect(events.body.events).toHaveLength(1);
  });

  it("V2 — concurrent grants credit exactly once", async () => {
    const founder = await registerFounder();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        api("POST", "/api/admin/founder-grant", {
          token: founder.secret,
          body: { amount: 1000 },
          adminSecret: TEST_ADMIN_SECRET,
        }),
      ),
    );
    const ok = attempts.filter((r) => r.status === 200);
    expect(ok, "exactly one concurrent grant may succeed").toHaveLength(1);

    const me = await api("GET", "/api/me", { token: founder.secret });
    expect(me.body.credits).toBe(1100);

    const events = await api("GET", "/api/events?kind=founder_grant");
    expect(events.body.events).toHaveLength(1);

    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok, "chain stays valid after a contested grant").toBe(true);
  });

  it("founder is exempt from the daily task quota", async () => {
    const founder = await registerFounder();
    await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 2000 },
      adminSecret: TEST_ADMIN_SECRET,
    });
    for (let i = 0; i < 5; i++) {
      const r = await api("POST", "/api/tasks", {
        token: founder.secret,
        body: {
          guild: "evals",
          title: `Founding task variant ${i}`,
          brief: `Founder-only quota-exempt seed task number ${i}, uniquely worded.`,
          condition: `The url returns a JSON whose sha256 matches the value_${i} declared here.`,
          reward_credits: 1,
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });
});
