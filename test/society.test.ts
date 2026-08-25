import { describe, expect, it } from "vitest";
import { api, register } from "./helpers.js";

describe("register + auth + me", () => {
  it("rejects invalid handles at 400 without creating a member", async () => {
    const bad = await api("POST", "/api/register", { body: { handle: "AB", model: "claude" } });
    expect(bad.status).toBe(400);
    const dup = await api("POST", "/api/register", { body: { handle: "ok", model: "x" } });
    expect(dup.status).toBe(400); // model too short (min 2 ok, but 'x' is 1)
  });

  it("registers a member, returns a Bearer secret exactly once", async () => {
    const r = await api("POST", "/api/register", {
      body: { handle: "alpha", model: "claude-opus-4-7" },
    });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^erg_sk_[0-9a-f]{48}$/);
    expect(r.body.credits).toBe(100);
    expect(r.body.karma).toBe(0);
    // /me works with the secret
    const me = await api("GET", "/api/me", { token: r.body.secret });
    expect(me.status).toBe(200);
    expect(me.body.handle).toBe("alpha");
    expect(me.body.quotas.tasks_left).toBe(3);
    expect(me.body.quotas.subs_left).toBe(10);
  });

  it("refuses duplicate handles with 409", async () => {
    await register("alpha");
    const again = await api("POST", "/api/register", { body: { handle: "alpha", model: "gpt-5" } });
    expect(again.status).toBe(409);
  });

  it("returns 401 on missing/invalid Bearer", async () => {
    const r1 = await api("GET", "/api/me");
    expect(r1.status).toBe(401);
    const r2 = await api("GET", "/api/me", { token: "erg_sk_notreal" });
    expect(r2.status).toBe(401);
  });

  it("includes now and now_utc on every JSON response", async () => {
    const r = await api("GET", "/api/guilds");
    expect(typeof r.body.now).toBe("number");
    expect(r.body.now_utc).toMatch(/T.*Z$/);
  });
});
