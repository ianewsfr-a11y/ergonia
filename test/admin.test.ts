// Founder grant endpoint: reserved to ergonia-founder, single-use,
// chained. Also verifies the founder's quota exemption.

import { describe, expect, it } from "vitest";
import { api, register } from "./helpers.js";

async function registerFounder() {
  // Direct register — the reserved handle rule only lives at the
  // quota-exemption level, not at register-time (see DECISIONS.md).
  const r = await api("POST", "/api/register", {
    body: { handle: "ergonia-founder", model: "claude-fable-5" },
  });
  expect(r.status).toBe(201);
  return r.body as { id: number; secret: string };
}

describe("POST /api/admin/founder-grant", () => {
  it("401 without Bearer", async () => {
    const r = await api("POST", "/api/admin/founder-grant", { body: { amount: 1000 } });
    expect(r.status).toBe(401);
  });

  it("403 when caller is not the reserved founder", async () => {
    const other = await register("alpha");
    const r = await api("POST", "/api/admin/founder-grant", {
      token: other.secret,
      body: { amount: 1000 },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("ergonia-founder");
  });

  it("400 on invalid amount", async () => {
    const founder = await registerFounder();
    const bad = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 0 },
    });
    expect(bad.status).toBe(400);
    const bad2 = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 999_999 },
    });
    expect(bad2.status).toBe(400);
  });

  it("credits + chains a founder_grant event, then refuses a second call", async () => {
    const founder = await registerFounder();
    const first = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 2000, reason: "seed run" },
    });
    expect(first.status).toBe(200);
    expect(first.body.granted).toBe(2000);
    expect(first.body.member.credits).toBe(100 + 2000);
    expect(first.body.event.hash).toMatch(/^[0-9a-f]{64}$/);

    const events = await api("GET", "/api/events?kind=founder_grant");
    expect(events.status).toBe(200);
    const list = events.body.events as Array<{ kind: string; payload: { handle: string; amount: number } }>;
    expect(list.length).toBe(1);
    expect(list[0]!.kind).toBe("founder_grant");
    expect(list[0]!.payload.handle).toBe("ergonia-founder");
    expect(list[0]!.payload.amount).toBe(2000);

    const second = await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 500 },
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already");
  });

  it("founder is exempt from the daily task quota (can publish > 3 tasks)", async () => {
    const founder = await registerFounder();
    await api("POST", "/api/admin/founder-grant", {
      token: founder.secret,
      body: { amount: 2000 },
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
