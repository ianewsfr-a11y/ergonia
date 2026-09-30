// Refused writes, counted (flag REFUSALS). Asked on r/mcp why five of six
// agents left, nothing recorded friction on the write path: a refused
// write never becomes an event. src/refusals.ts, DECISIONS.md 2026-09-30.

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { clientFamily, reasonKey, recordRefusal, routeKey } from "../src/refusals.js";
import type { Env } from "../src/types.js";
import { api, register } from "./helpers.js";

interface Row {
  route: string;
  status: number;
  reason: string;
  client: string;
  member_id: number;
  count: number;
}

async function rowsFor(where: string, ...binds: unknown[]): Promise<Row[]> {
  const r = await env.DB.prepare(`SELECT route, status, reason, client, member_id, count FROM refusals WHERE ${where}`)
    .bind(...binds)
    .all<Row>();
  return r.results ?? [];
}

async function post(path: string, body: unknown, token?: string, userAgent = "Python-urllib/3.12") {
  const headers = new Headers({ "content-type": "application/json", "user-agent": userAgent });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch("https://ergonia.test" + path, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("the stored reason carries no request content", () => {
  it("keeps only the leading words of the message", () => {
    expect(reasonKey('verifier_spec.item_keys: "MY_SECRET_1234" is not a field name')).toBe("verifier_spec.item_keys");
    expect(reasonKey('verifier_spec.item_keys: "x\\"SECRET" is not a field name')).toBe("verifier_spec.item_keys");
    expect(reasonKey("content must be at most 65536 UTF-8 bytes (got 70000)")).toBe("content must be at most");
    expect(reasonKey("daily check quota exhausted (resets 00:00 UTC)")).toBe("daily check quota exhausted");
    expect(reasonKey("unauthorized: send Authorization: Bearer erg_sk_...")).toBe("unauthorized");
    expect(reasonKey("no route for POST /api/anything/at/all")).toBe("no route");
    expect(reasonKey("Anything that starts with a capital")).toBe("(unworded)");
  });

  it("collapses ids in routes and names client families coarsely", () => {
    expect(routeKey("/api/submissions/41/withdraw")).toBe("/api/submissions/:id/withdraw");
    expect(routeKey(`/a/${"a".repeat(64)}`)).toBe("/a/:sha");
    expect(routeKey("/api/members/any-handle-at-all")).toBe("/api/members/:x");
    expect(clientFamily("Python-urllib/3.11")).toBe("python-urllib");
    expect(clientFamily("python-requests/2.32")).toBe("python-lib");
    expect(clientFamily("curl/8.4.0")).toBe("curl");
    expect(clientFamily(null)).toBe("none");
  });
});

describe("refused writes are counted", () => {
  it("counts a refused REST write under the member who made it", async () => {
    const m = await register("refused-a");
    const r = await post("/api/tasks", { guild: "evals" }, m.secret);
    expect(r.status).toBe(400);
    const rows = await rowsFor("member_id = ?", m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: "/api/tasks", status: 400, client: "python-urllib", count: 1 });
    // A second identical refusal is the same row, counted twice.
    await post("/api/tasks", { guild: "evals" }, m.secret);
    expect((await rowsFor("member_id = ?", m.id))[0]!.count).toBe(2);
  });

  it("folds unknown paths into one row, so made-up routes cannot grow the table", async () => {
    const before = (await rowsFor("status = 404")).length;
    for (const p of ["/nope-1", "/nope-2", "/api/nope-3", "/api/also/nope/4"]) {
      expect((await post(p, {})).status).toBe(404);
    }
    const rows = await rowsFor("status = 404");
    expect(rows.length - before).toBeLessThanOrEqual(1);
    expect(rows.every((r) => r.route === "(no route)")).toBe(true);
  });

  it("stores nothing a caller wrote even through an escaped quote", async () => {
    // Security review, 2026-09-30: `"x\"SECRET..."` walked through the
    // first masking, which stopped at the escaped quote.
    const m = await register("refused-escape");
    const r = await post("/api/check", { spec: { kind: "json-array", item_keys: ['x\\"SECRETTOKEN-abc'] }, artifact: "[]" }, m.secret);
    expect(r.status).toBe(400);
    const rows = await rowsFor("member_id = ?", m.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("SECRETTOKEN");
    expect((await api("GET", "/api/refusals")).res.headers.get("content-type")).toContain("json");
    expect(JSON.stringify((await api("GET", "/api/refusals")).body)).not.toContain("SECRETTOKEN");
  });

  it("folds a free path segment into the route pattern, whatever the status", async () => {
    // POST on /api/members/<handle> answers 405 and used to keep the handle.
    const before = (await rowsFor("status = 405")).length;
    for (const h of ["inventedone", "inventedtwo", "inventedthree"]) {
      expect((await post(`/api/members/${h}`, {})).status).toBe(405);
    }
    const rows = await rowsFor("status = 405");
    expect(rows.length - before).toBeLessThanOrEqual(1);
    expect(JSON.stringify(rows)).not.toContain("invented");
  });

  it("stops adding rows past a daily cap and counts the rest in one overflow row", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM refusals WHERE route LIKE 'cap-test:%' OR route = '(overflow)'").run();
    const existing = (await env.DB.prepare("SELECT COUNT(*) AS n FROM refusals WHERE utc_day = ?").bind(day).first<{ n: number }>())!.n;
    for (let i = 0; i < 5; i += 1) {
      await recordRefusal(env as unknown as Env, { route: `cap-test:${i}`, status: 400, message: "bad", memberId: null, userAgent: null }, existing + 3);
    }
    const capped = await rowsFor("route LIKE 'cap-test:%'");
    const overflow = await rowsFor("route = '(overflow)'");
    expect(capped).toHaveLength(3);
    expect(overflow.reduce((n, r) => n + r.count, 0)).toBe(2);
  });

  it("counts a write refused for lack of a key as anonymous", async () => {
    const before = (await rowsFor("route = '/api/artifacts' AND status = 401 AND member_id = 0")).reduce((n, r) => n + r.count, 0);
    expect((await post("/api/artifacts", { content: "x" })).status).toBe(401);
    const after = (await rowsFor("route = '/api/artifacts' AND status = 401 AND member_id = 0")).reduce((n, r) => n + r.count, 0);
    expect(after).toBe(before + 1);
  });

  it("never stores what the request carried, even when the error message echoes it", async () => {
    const m = await register("refused-echo");
    const r = await post("/api/check", { spec: { kind: "json-array", item_keys: ["PAYLOAD_7f3a secret field"] }, artifact: "[]" }, m.secret);
    expect(r.status).toBe(400);
    const rows = await rowsFor("member_id = ?", m.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("PAYLOAD");
  });

  it("does not count accepted writes or refused reads", async () => {
    const m = await register("refused-none");
    expect((await post("/api/comments", { task_id: 999999, body: "hello" }, m.secret)).status).toBeGreaterThanOrEqual(400);
    const baseline = (await rowsFor("member_id = ?", m.id)).length;
    expect((await api("GET", "/api/tasks/999999")).status).toBe(404);
    expect((await api("GET", "/api/me", { token: m.secret })).status).toBe(200);
    expect((await rowsFor("member_id = ?", m.id)).length).toBe(baseline);
  });

  it("counts a write tool refused over MCP, which answers HTTP 200", async () => {
    const m = await register("refused-mcp");
    const call = (token?: string) =>
      SELF.fetch("https://ergonia.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_work", arguments: { task_id: 999999, artifact: "x" } } }),
      });
    const withKey = await call(m.secret);
    expect(withKey.status).toBe(200);
    const rows = await rowsFor("member_id = ? AND route = 'mcp:submit_work'", m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBeGreaterThanOrEqual(400);

    const before = (await rowsFor("route = 'mcp:submit_work' AND status = 401")).reduce((n, r) => n + r.count, 0);
    await call();
    const after = (await rowsFor("route = 'mcp:submit_work' AND status = 401")).reduce((n, r) => n + r.count, 0);
    expect(after).toBe(before + 1);
  });
});

describe("GET /api/refusals", () => {
  it("serves aggregates without naming any member", async () => {
    const m = await register("refused-public");
    await post("/api/tasks", { guild: "evals" }, m.secret);
    const r = await api("GET", "/api/refusals?days=7");
    expect(r.status).toBe(200);
    expect(r.body.counting_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const tasks = r.body.refusals.find((x: Row) => x.route === "/api/tasks" && x.status === 400);
    expect(tasks.members).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("refused-public");
    expect(text).not.toContain("member_id");
  });

  it("is disclosed on /api/official", async () => {
    expect((await api("GET", "/api/official")).body.features.refusals.status).toBe("on");
  });
});

describe("flag REFUSALS off", () => {
  it("counts nothing and serves no route", async () => {
    const off = { ...(env as unknown as Env), REFUSALS: "off" };
    const m = await register("refused-off");
    const req = new Request("https://ergonia.test/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${m.secret}` },
      body: JSON.stringify({ guild: "evals" }),
    });
    expect((await worker.fetch(req, off)).status).toBe(400);
    expect(await rowsFor("member_id = ?", m.id)).toHaveLength(0);
    expect((await worker.fetch(new Request("https://ergonia.test/api/refusals"), off)).status).toBe(404);
  });
});
