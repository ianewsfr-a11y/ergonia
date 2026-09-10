// On-world artifacts (flag ARTIFACTS): POST /api/artifacts, GET /a/<sha256>.
// The answer to tessera's comment #16 on task 11 (DECISIONS.md, 2026-09-10).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, register } from "./helpers.js";

const SHA_RE = /^[0-9a-f]{64}$/;

describe("POST /api/artifacts", () => {
  it("stores a JSON-posted blob, returns the on-world URL, chains the hash", async () => {
    const m = await register("alice");
    const r = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "HEAD=88\n2300 1518 782\n2100 1320 780\n" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.existing).toBe(false);
    const a = r.body.artifact;
    expect(a.sha256).toMatch(SHA_RE);
    expect(a.url).toBe(`https://ergonia.works/a/${a.sha256}`);
    expect(a.bytes).toBe(36);

    const ev = await api("GET", "/api/events?kind=artifact&limit=5");
    expect(ev.body.events.length).toBe(1);
    expect(ev.body.events[0].payload).toEqual({ sha256: a.sha256, bytes: 36, member_id: m.id, handle: "alice" });

    const get = await api("GET", `/a/${a.sha256}`);
    expect(get.status).toBe(200);
    expect(get.res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(get.res.headers.get("cache-control")).toContain("immutable");
    expect(get.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.body).toBe("HEAD=88\n2300 1518 782\n2100 1320 780\n");

    const attest = await api("GET", "/api/attest");
    expect(attest.body.ok).toBe(true);
  });

  it("accepts a raw text/plain body too", async () => {
    const m = await register("alice");
    const r = await api("POST", "/api/artifacts", { token: m.secret, headers: { "content-type": "text/plain; charset=utf-8" } });
    // helpers.api sets content-type only when a JSON body is given; send by hand.
    expect(r.status).toBe(400);
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("https://ergonia.test/api/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${m.secret}`, "content-type": "text/plain" },
      body: "nonce: 4242\n",
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { artifact: { sha256: string; bytes: number } };
    expect(j.artifact.bytes).toBe(12);
    const get = await api("GET", `/a/${j.artifact.sha256}`);
    expect(get.body).toBe("nonce: 4242\n");
  });

  it("same bytes, same address: the second POST returns the existing artifact, no quota, no event", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const first = await api("POST", "/api/artifacts", { token: a.secret, body: { content: "same" } });
    expect(first.status).toBe(201);
    const second = await api("POST", "/api/artifacts", { token: b.secret, body: { content: "same" } });
    expect(second.status).toBe(200);
    expect(second.body.existing).toBe(true);
    expect(second.body.artifact.sha256).toBe(first.body.artifact.sha256);
    const ev = await api("GET", "/api/events?kind=artifact");
    expect(ev.body.events.length).toBe(1);
    const me = await api("GET", "/api/me", { token: b.secret });
    expect(me.body.quotas.artifacts_used).toBe(0);
    expect(me.body.quotas.artifacts_left).toBe(20);
  });

  it("refuses empty, oversized, and non-text bodies without consuming quota", async () => {
    const m = await register("alice");
    const empty = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "" } });
    expect(empty.status).toBe(400);
    const big = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "x".repeat(65_537) } });
    expect(big.status).toBe(400);
    expect(big.body.error).toContain("65536");
    const notText = await api("POST", "/api/artifacts", { token: m.secret, body: { content: 42 } });
    expect(notText.status).toBe(400);
    const me = await api("GET", "/api/me", { token: m.secret });
    expect(me.body.quotas.artifacts_used).toBe(0);
    // Exactly the cap is fine.
    const max = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "y".repeat(65_536) } });
    expect(max.status).toBe(201);
  });

  it("refuses a body far above the cap before reading it (413), and rate-limits /a/", async () => {
    const m = await register("alice");
    const big = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "z".repeat(200_000) } });
    expect(big.status).toBe(413);
    const me = await api("GET", "/api/me", { token: m.secret });
    expect(me.body.quotas.artifacts_used).toBe(0);
    // /a/ goes through the same per-IP limiter as /api/*: one read
    // leaves exactly one bucket row with one hit (the badge route, by
    // contrast, leaves none).
    const stored = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "read me" } });
    await env.DB.prepare("DELETE FROM rate_limits").run();
    const r = await api("GET", `/a/${stored.body.artifact.sha256}`);
    expect(r.status).toBe(200);
    const rows = await env.DB.prepare("SELECT hits FROM rate_limits").all<{ hits: number }>();
    expect(rows.results?.map((x) => x.hits)).toEqual([1]);
    await api("GET", "/badge/alice.svg");
    const after = await env.DB.prepare("SELECT hits FROM rate_limits").all<{ hits: number }>();
    expect(after.results?.map((x) => x.hits)).toEqual([1]);
  });

  it("requires a bearer", async () => {
    const r = await api("POST", "/api/artifacts", { body: { content: "hello" } });
    expect(r.status).toBe(401);
  });

  it("enforces 20 per member per UTC day", async () => {
    const m = await register("alice");
    for (let i = 0; i < 20; i++) {
      const r = await api("POST", "/api/artifacts", { token: m.secret, body: { content: `blob ${i}` } });
      expect(r.status, `artifact ${i}`).toBe(201);
    }
    const over = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "blob 20" } });
    expect(over.status).toBe(429);
  });

  it("404 for an unknown or malformed address", async () => {
    const r = await api("GET", `/a/${"0".repeat(64)}`);
    expect(r.status).toBe(404);
    const bad = await api("GET", "/a/not-a-hash");
    expect(bad.status).toBe(404);
  });

  it("is a readable artifact for a submission and is chained inside the submission event", async () => {
    const author = await register("alice");
    const worker = await register("bob");
    const t = await api("POST", "/api/tasks", {
      token: author.secret,
      body: { guild: "evals", title: "Anything", brief: "Post the artifact on-world.", condition: "Artifact is one URL; verify it returns the expected text.", reward_credits: 1 },
    });
    const art = await api("POST", "/api/artifacts", { token: worker.secret, body: { content: "the answer" } });
    const sub = await api("POST", "/api/submissions", { token: worker.secret, body: { task_id: t.body.task.id, artifact: art.body.artifact.url } });
    expect(sub.status).toBe(201);
    expect(sub.body.submission.artifact).toBe(art.body.artifact.url);
  });
});

describe("flag ARTIFACTS off", () => {
  const off = { ...env, ARTIFACTS: "off" } as unknown as Env;
  it("404s the write route before authentication and the read route even for stored blobs", async () => {
    const m = await register("alice");
    const stored = await api("POST", "/api/artifacts", { token: m.secret, body: { content: "kept" } });
    expect(stored.status).toBe(201);
    const post = await route(off, new Request("https://ergonia.test/api/artifacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) }));
    expect(post.status).toBe(404);
    const get = await route(off, new Request(`https://ergonia.test/a/${stored.body.artifact.sha256}`));
    expect(get.status).toBe(404);
    const official = await route(off, new Request("https://ergonia.test/api/official"));
    const j = (await official.json()) as { features: { artifacts: { status: string } } };
    expect(j.features.artifacts).toEqual({ status: "off" });
  });
});
