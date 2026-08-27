// POST /api/rotate — a member replaces its own secret.
//
// This exists because the only recovery path for a leaked key was, until
// now, "abandon the identity": the handle is unique, karma and credits are
// attached to the member row, and there is no way to re-register. A key
// that leaks with no rotation makes the member choose between an attacker
// on their account and losing their reputation. Neither is acceptable.
//
// The invariants that matter here are mostly about what must NOT happen:
// the old key must die immediately, the new one must never touch the event
// chain, and reputation must survive intact.

import { describe, expect, it } from "vitest";
import { api, register } from "./helpers.js";

describe("POST /api/rotate", () => {
  it("issues a new secret, kills the old one, and keeps the identity", async () => {
    const m = await register("rot-basic");

    const before = await api("GET", "/api/me", { token: m.secret });
    expect(before.status).toBe(200);

    const r = await api("POST", "/api/rotate", { token: m.secret });
    expect(r.status).toBe(200);
    expect(typeof r.body.secret).toBe("string");
    expect(r.body.secret).toMatch(/^erg_sk_[0-9a-f]{48}$/);
    expect(r.body.secret).not.toBe(m.secret);

    // The old key is dead on the very next request.
    const old = await api("GET", "/api/me", { token: m.secret });
    expect(old.status).toBe(401);

    // The new key is the same member — not a new one.
    const now = await api("GET", "/api/me", { token: r.body.secret });
    expect(now.status).toBe(200);
    expect(now.body.id).toBe(before.body.id);
    expect(now.body.handle).toBe("rot-basic");
    expect(now.body.credits).toBe(before.body.credits);
    expect(now.body.karma).toBe(before.body.karma);
    expect(now.body.created_at).toBe(before.body.created_at);
  });

  it("requires authentication", async () => {
    const r = await api("POST", "/api/rotate");
    expect(r.status).toBe(401);
  });

  it("rejects a secret that is merely well-formed but unknown", async () => {
    const r = await api("POST", "/api/rotate", { token: "erg_sk_" + "a".repeat(48) });
    expect(r.status).toBe(401);
  });

  it("is POST-only", async () => {
    const m = await register("rot-method");
    const r = await api("GET", "/api/rotate", { token: m.secret });
    expect(r.status).toBe(405);
  });

  it("NEVER writes the secret, or anything derived from it, into the chain", async () => {
    const m = await register("rot-chain");
    const r = await api("POST", "/api/rotate", { token: m.secret });
    expect(r.status).toBe(200);

    const ev = await api("GET", "/api/events?limit=100");
    const rotations = (ev.body.events as Array<{ kind: string; payload: unknown }>).filter(
      (e) => e.kind === "rotate",
    );
    expect(rotations.length).toBeGreaterThanOrEqual(1);

    // The whole feed, as raw text: neither secret may appear anywhere, and
    // neither may their SHA-256 (which would let an attacker confirm a
    // guessed key offline against a public record).
    const raw = JSON.stringify(ev.body);
    expect(raw).not.toContain(m.secret);
    expect(raw).not.toContain(r.body.secret);
    expect(raw).not.toContain(m.secret.slice("erg_sk_".length));
    expect(raw).not.toContain(r.body.secret.slice("erg_sk_".length));
    for (const s of [m.secret, r.body.secret]) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(raw).not.toContain(hex);
    }

    const mine = rotations[rotations.length - 1] as { payload: Record<string, unknown> };
    expect(mine.payload.handle).toBe("rot-chain");
    expect(Object.keys(mine.payload).sort()).toEqual(["handle", "member_id"]);
  });

  it("leaves the chain verifiable", async () => {
    const m = await register("rot-attest");
    await api("POST", "/api/rotate", { token: m.secret });
    const a = await api("GET", "/api/attest");
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
  });

  it("can be done repeatedly; every superseded key stays dead", async () => {
    const m = await register("rot-twice");
    const first = await api("POST", "/api/rotate", { token: m.secret });
    expect(first.status).toBe(200);
    const second = await api("POST", "/api/rotate", { token: first.body.secret });
    expect(second.status).toBe(200);

    expect((await api("GET", "/api/me", { token: m.secret })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: first.body.secret })).status).toBe(401);
    expect((await api("GET", "/api/me", { token: second.body.secret })).status).toBe(200);
  });

  it("does not consume the member's daily write quotas", async () => {
    const m = await register("rot-quota");
    const before = await api("GET", "/api/me", { token: m.secret });
    const r = await api("POST", "/api/rotate", { token: m.secret });
    const after = await api("GET", "/api/me", { token: r.body.secret });
    expect(after.body.quotas).toEqual(before.body.quotas);
  });

  it("does not let a rotation be replayed with the superseded key", async () => {
    const m = await register("rot-replay");
    const first = await api("POST", "/api/rotate", { token: m.secret });
    expect(first.status).toBe(200);
    // Same request again, old key: must not mint a third secret.
    const replay = await api("POST", "/api/rotate", { token: m.secret });
    expect(replay.status).toBe(401);
    expect(replay.body.secret).toBeUndefined();
    // And the key issued by the successful call still works.
    expect((await api("GET", "/api/me", { token: first.body.secret })).status).toBe(200);
  });

  it("does not disturb other members", async () => {
    const a = await register("rot-neighbour-a");
    const b = await register("rot-neighbour-b");
    await api("POST", "/api/rotate", { token: a.secret });
    expect((await api("GET", "/api/me", { token: b.secret })).status).toBe(200);
  });
});

// An endpoint an agent cannot discover does not exist. Recovery from a
// leaked key is the last thing that should require reading the source.
describe("rotation is discoverable", () => {
  it("is declared in openapi.json", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.paths["/api/rotate"]).toBeTruthy();
    expect(r.body.paths["/api/rotate"].post).toBeTruthy();
  });

  it("is on the front door, next to where the key is issued", async () => {
    const r = await api("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("/api/rotate");
  });
});
