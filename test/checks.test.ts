// POST /api/check (flag CHECKS): a schema-check@1 verdict outside any
// task, for an escrow arbiter that needs one verdict per payment.
// Observed problem in src/checks.ts; DECISIONS.md, 2026-09-27.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { QUOTAS } from "../src/types.js";
import { utcDay } from "../src/util.js";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { api, register } from "./helpers.js";

const encoder = new TextEncoder();
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The shape the x402r example arbiter judges: a three-day forecast.
const FORECAST_SPEC = {
  kind: "json-array",
  length: 3,
  item_keys: ["day", "high", "low", "unit"],
  allowed: [{ field: "unit", values: ["C", "F"] }],
};
const GOOD = JSON.stringify([
  { day: "mon", high: 21, low: 12, unit: "C" },
  { day: "tue", high: 23, low: 13, unit: "C" },
  { day: "wed", high: 19, low: 11, unit: "C" },
]);
const BAD = JSON.stringify([{ day: "mon", high: 21, low: 12, unit: "K" }, { day: "tue" }]);

async function check(token: string, body: unknown) {
  return api("POST", "/api/check", { token, body });
}

describe("POST /api/check", () => {
  it("passes an artifact that meets the spec, and chains the verdict without the artifact", async () => {
    const m = await register("checker-a");
    const r = await check(m.secret, { spec: FORECAST_SPEC, artifact: GOOD });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.check.verdict).toBe("pass");
    expect(r.body.check.verifier).toBe("schema-check@1");
    expect(r.body.check.artifact_sha256).toBe(await sha256(GOOD));

    const ev = (await api("GET", `/api/events?before=${r.body.check.event_id + 1}&limit=1`)).body.events[0];
    expect(ev.kind).toBe("check");
    expect(ev.hash).toBe(r.body.check.event_hash);
    expect(ev.payload).toMatchObject({ verdict: "pass", handle: "checker-a", artifact_sha256: await sha256(GOOD) });
    expect(ev.payload.spec).toMatchObject({ kind: "json-array", length: 3 });
    // The paid content itself never lands on the public log.
    expect(JSON.stringify(ev.payload)).not.toContain('"tue"');
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("never writes the artifact's content on the public log, even when it fails", async () => {
    // Found by the security review of 2026-09-27: the first version
    // published a JSON.parse error message (V8 quotes the input in it) and
    // the value that broke an "allowed" rule, up to 200 characters each.
    const m = await register("checker-leak");
    const SECRET = "PAID_CONTENT_do_not_publish_4200";
    const notJson = await check(m.secret, { spec: FORECAST_SPEC, artifact: `${SECRET} is the whole report` });
    const breaksAllowed = await check(m.secret, {
      spec: FORECAST_SPEC,
      artifact: JSON.stringify([{ day: SECRET, high: 1, low: 0, unit: SECRET }]),
    });
    for (const r of [notJson, breaksAllowed]) {
      expect(r.status).toBe(201);
      expect(r.body.check.verdict).toBe("fail");
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
      const ev = (await api("GET", `/api/events?before=${r.body.check.event_id + 1}&limit=1`)).body.events[0];
      expect(JSON.stringify(ev)).not.toContain(SECRET);
    }
  });

  it("returns a failing verdict as a verdict, naming the rules that failed", async () => {
    const m = await register("checker-b");
    const r = await check(m.secret, { spec: FORECAST_SPEC, artifact: BAD });
    expect(r.status).toBe(201);
    expect(r.body.check.verdict).toBe("fail");
    const failed = r.body.check.findings.filter((f: { ok: boolean }) => !f.ok).map((f: { rule: string }) => f.rule);
    expect(failed).toContain("exactly 3 elements");
    expect(failed.some((rule: string) => rule.startsWith("unit is one of"))).toBe(true);
  });

  it("gives the same findings twice for the same spec and artifact, which is what makes it replayable", async () => {
    const m = await register("checker-c");
    const one = await check(m.secret, { spec: FORECAST_SPEC, artifact: BAD });
    const two = await check(m.secret, { spec: FORECAST_SPEC, artifact: BAD });
    expect(two.body.check.findings).toEqual(one.body.check.findings);
    expect(two.body.check.spec_sha256).toBe(one.body.check.spec_sha256);
    expect(two.body.check.event_id).toBeGreaterThan(one.body.check.event_id);
  });

  it("refuses bad input with 400 and charges no quota for it", async () => {
    const m = await register("checker-d");
    expect((await check(m.secret, { spec: { kind: "json-array" }, artifact: GOOD })).status).toBe(400);
    expect((await check(m.secret, { spec: FORECAST_SPEC, artifact: 42 })).status).toBe(400);
    expect((await check(m.secret, { spec: FORECAST_SPEC, artifact: "" })).status).toBe(400);
    expect((await check(m.secret, { spec: FORECAST_SPEC })).status).toBe(400);
    expect((await api("GET", "/api/me", { token: m.secret })).body.quotas.checks_used).toBe(0);
    // And the counter does move on a verdict, so the zero above means something.
    expect((await check(m.secret, { spec: FORECAST_SPEC, artifact: GOOD })).status).toBe(201);
    expect((await api("GET", "/api/me", { token: m.secret })).body.quotas.checks_used).toBe(1);
  });

  it("requires a bearer and POST", async () => {
    expect((await api("POST", "/api/check", { body: { spec: FORECAST_SPEC, artifact: GOOD } })).status).toBe(401);
    const m = await register("checker-e");
    expect((await api("GET", "/api/check", { token: m.secret })).status).toBe(405);
  });

  it("stops at the daily quota", async () => {
    const m = await register("checker-f");
    await env.DB.prepare(
      "INSERT INTO quotas (member_id, utc_day, tasks, subs, comments, artifacts, checks) VALUES (?, ?, 0, 0, 0, 0, ?) " +
        "ON CONFLICT(member_id, utc_day) DO UPDATE SET checks = excluded.checks",
    )
      .bind(m.id, utcDay(), QUOTAS.CHECKS_PER_DAY)
      .run();
    const r = await check(m.secret, { spec: FORECAST_SPEC, artifact: GOOD });
    expect(r.status).toBe(429);
  });

  it("refuses an oversized body even when it declares no length", async () => {
    // Security review, 2026-09-27: the content-length gate read 0 on a
    // streamed body and let request.json() buffer whatever arrived.
    const m = await register("checker-stream");
    // A fresh buffer per chunk: an enqueued buffer is transferred, and
    // re-sending the same one sends nothing after the first.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(encoder.encode("x".repeat(64 * 1024)));
        else c.close();
      },
    });
    const res = await route(
      env as unknown as Env,
      new Request("https://ergonia.test/api/check", {
        method: "POST",
        headers: { authorization: `Bearer ${m.secret}`, "content-type": "application/json" },
        body: stream,
        // @ts-expect-error: workerd accepts a streamed request body
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
  });

  it("does not let simultaneous requests overshoot the daily quota", async () => {
    const m = await register("checker-race");
    await env.DB.prepare(
      "INSERT INTO quotas (member_id, utc_day, tasks, subs, comments, artifacts, checks) VALUES (?, ?, 0, 0, 0, 0, ?) " +
        "ON CONFLICT(member_id, utc_day) DO UPDATE SET checks = excluded.checks",
    )
      .bind(m.id, utcDay(), QUOTAS.CHECKS_PER_DAY - 2)
      .run();
    // Straight into the router, so the five requests really interleave at
    // every await instead of being queued one after another.
    const one = () =>
      route(
        env as unknown as Env,
        new Request("https://ergonia.test/api/check", {
          method: "POST",
          headers: { authorization: `Bearer ${m.secret}`, "content-type": "application/json" },
          body: JSON.stringify({ spec: FORECAST_SPEC, artifact: GOOD }),
        }),
      );
    const statuses = (await Promise.all(Array.from({ length: 5 }, one))).map((r) => r.status);
    expect(statuses.filter((s) => s === 201), statuses.join(",")).toHaveLength(2);
    expect(statuses.filter((s) => s === 429), statuses.join(",")).toHaveLength(3);
  });

  it("is disclosed on /api/official and named on the schema-check manifest", async () => {
    const official = await api("GET", "/api/official");
    expect(official.body.features.checks.status).toBe("on");
    const manifest = await api("GET", "/api/verifiers/schema-check");
    expect(manifest.body.trigger.standalone).toContain("POST /api/check");
  });
});
