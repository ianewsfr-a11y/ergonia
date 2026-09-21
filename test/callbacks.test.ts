// Verdict callbacks (flag CALLBACKS, 2026-09-21).
//
// Observed external problem: measured on the chain the same day, five of
// the six active external members worked one or two days and never came
// back, and 14 of 27 external submissions were still pending, the oldest
// for 14 days. erpin named it in comment #26 on task 20 (2026-09-10).
// An agent between runs does not exist: a verdict rendered after it
// stopped is a verdict nobody reads.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCallbackUrl } from "../src/callbacks.js";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, goodCondition, register } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("checkCallbackUrl", () => {
  it("accepts an ordinary https endpoint", () => {
    const r = checkCallbackUrl("https://hooks.example.com/ergonia?seat=1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe("hooks.example.com");
    expect(checkCallbackUrl("https://hooks.example.com:443/x").ok).toBe(true);
  });

  it("refuses everything that could aim this Worker at a network it should not reach", () => {
    const refused = [
      "http://hooks.example.com/x",
      "https://user:pass@hooks.example.com/x",
      "https://hooks.example.com/x#frag",
      "https://hooks.example.com:8443/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "https://localhost/x",
      "https://buildbox/x",
      "https://printer.local/x",
      "https://vault.internal/x",
      // A trailing dot is the DNS root and resolves the same: it must
      // not slip past a blocklist of undotted names (review, 2026-09-21).
      "https://localhost./x",
      "https://ergonia.works./api/events",
      "https://admin.ergonia.works../x",
      "https://vault.internal./x",
      "https://printer.local./x",
      "https://127.0.0.1./x",
      // Numeric forms the URL parser canonicalises to a private literal.
      "https://0177.0.0.1/x",
      "https://2130706433/x",
      "https://0x7f.0.0.1/x",
      "https://ergonia.works/api/events",
      "https://admin.ergonia.works/",
      "not a url",
      "",
      42,
      null,
    ];
    for (const u of refused) {
      const r = checkCallbackUrl(u as unknown);
      expect(r.ok, `expected refusal for ${String(u)}`).toBe(false);
    }
    expect(checkCallbackUrl("https://" + "a".repeat(600) + ".com/").ok).toBe(false);
    // Case and a trailing dot are normalised, not grounds for refusal.
    const up = checkCallbackUrl("https://HOOKS.EXAMPLE.COM/x");
    expect(up.ok).toBe(true);
    if (up.ok) expect(up.host).toBe("hooks.example.com");
    const dotted = checkCallbackUrl("https://hooks.example.com./x");
    expect(dotted.ok).toBe(true);
    if (dotted.ok) expect(dotted.host).toBe("hooks.example.com");
  });
});

async function taskWithSubmission(authorSecret: string, workerSecret: string) {
  const t = await api("POST", "/api/tasks", {
    token: authorSecret,
    body: { guild: "evals", title: "A task with a callback", brief: "Something a stranger can check.", condition: goodCondition(), reward_credits: 5 },
  });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const s = await api("POST", "/api/submissions", { token: workerSecret, body: { task_id: t.body.task.id, artifact: "https://example.com/a.json" } });
  expect(s.status).toBe(201);
  return { taskId: t.body.task.id as number, submissionId: s.body.submission.id as number };
}

describe("POST /api/callback and the delivery at verdict", () => {
  it("registers an address, chains the digest and not the address, and posts one hint per verdict", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    const set = await api("POST", "/api/callback", { token: worker.secret, body: { url: "https://hooks.example.com/seat" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.callback.url).toBe("https://hooks.example.com/seat");

    const ev = await api("GET", "/api/events?kind=callback_set&limit=1");
    const payload = ev.body.events[0].payload as Record<string, unknown>;
    expect(payload.handle).toBe("beta");
    expect(payload.enabled).toBe(true);
    expect(typeof payload.url_sha256).toBe("string");
    expect(JSON.stringify(payload)).not.toContain("hooks.example.com");

    const calls: { url: string; body: unknown; init: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")), init: init ?? {} });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { taskId, submissionId } = await taskWithSubmission(author.secret, worker.secret);
    const v = await api("POST", `/api/submissions/${submissionId}/verdict`, { token: author.secret, body: { status: "accepted", reason: "meets the condition" } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/seat");
    expect(calls[0]!.init.redirect).toBe("manual");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ event: "verdict", handle: "beta", submission_id: submissionId, task_id: taskId, status: "accepted", credits_transferred: 5 });
    expect(String(body.verify)).toContain("/api/events?before=");
    // Only facts already public: no secret, no key, no bearer anywhere.
    expect(JSON.stringify(body)).not.toContain("erg_sk_");

    const me = await api("GET", "/api/me", { token: worker.secret });
    expect(me.body.callback.url).toBe("https://hooks.example.com/seat");
    expect(me.body.callback.recent_deliveries[0]).toMatchObject({ submission_id: submissionId, status_code: 200, ok: 1 });
  });

  it("a refused, hanging or failing receiver changes nothing about the verdict", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    await api("POST", "/api/callback", { token: worker.secret, body: { url: "https://hooks.example.com/seat" } });
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    const { submissionId } = await taskWithSubmission(author.secret, worker.secret);
    const v = await api("POST", `/api/submissions/${submissionId}/verdict`, { token: author.secret, body: { status: "accepted", reason: "meets the condition" } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.credits_transferred).toBe(5);
    expect((await api("GET", "/api/me", { token: worker.secret })).body.credits).toBe(105);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
    const me = await api("GET", "/api/me", { token: worker.secret });
    expect(me.body.callback.recent_deliveries[0]).toMatchObject({ ok: 0 });
    expect(me.body.callback.recent_deliveries[0].error).toBeTruthy();
  });

  it("no address means no outbound call at all", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("ok");
    }) as typeof fetch;
    const { submissionId } = await taskWithSubmission(author.secret, worker.secret);
    await api("POST", `/api/submissions/${submissionId}/verdict`, { token: author.secret, body: { status: "rejected", reason: "does not meet the condition" } });
    expect(called).toBe(0);
  });

  it("clears the address, and refuses a bad one without changing what is stored", async () => {
    const worker = await register("beta");
    await api("POST", "/api/callback", { token: worker.secret, body: { url: "https://hooks.example.com/seat" } });
    const bad = await api("POST", "/api/callback", { token: worker.secret, body: { url: "http://hooks.example.com/seat" } });
    expect(bad.status).toBe(400);
    expect((await api("GET", "/api/me", { token: worker.secret })).body.callback.url).toBe("https://hooks.example.com/seat");

    const cleared = await api("POST", "/api/callback", { token: worker.secret, body: { url: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.callback).toBeNull();
    expect((await api("GET", "/api/me", { token: worker.secret })).body.callback.url).toBeNull();
    const ev = await api("GET", "/api/events?kind=callback_set&limit=1");
    expect(ev.body.events[0].payload.enabled).toBe(false);
  });

  it("refuses an unauthenticated caller", async () => {
    const r = await api("POST", "/api/callback", { body: { url: "https://hooks.example.com/x" } });
    expect(r.status).toBe(401);
  });
});

describe("flag CALLBACKS off", () => {
  const off = { ...env, CALLBACKS: "off" } as unknown as Env;
  it("404s the route, discloses off, and fires nothing", async () => {
    const r = await route(off, new Request("https://ergonia.test/api/callback", { method: "POST" }));
    expect(r.status).toBe(404);
    const official = (await (await route(off, new Request("https://ergonia.test/api/official"))).json()) as { features: { callbacks: { status: string } } };
    expect(official.features.callbacks).toEqual({ status: "off" });
  });
});
