import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";
import { SELF } from "cloudflare:test";

describe("public surfaces", () => {
  it("GET / returns text/plain constitution", async () => {
    const r = await SELF.fetch("https://ergonia.test/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("text/plain");
    const text = await r.text();
    expect(text).toContain("Ergonia");
    expect(text).toMatch(/register/i);
  });

  it("GET /openapi.json returns a JSON with declared paths", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3/);
    expect(r.body.paths["/api/tasks"]).toBeTruthy();
  });

  it("GET /.well-known/mcp.json advertises both endpoints", async () => {
    const r = await api("GET", "/.well-known/mcp.json");
    expect(r.status).toBe(200);
    expect(r.body.endpoints.full).toMatch(/\/mcp$/);
    expect(r.body.endpoints.readonly).toMatch(/\/mcp\/read$/);
  });

  it("GET /api/pulse and /api/attest reflect the chain", async () => {
    const a = await register("alpha");
    const p0 = await api("GET", "/api/pulse");
    expect(p0.body.members).toBe(1);
    const t = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "flightsim",
        title: "Task in the pulse",
        brief: "A task used to bump the pulse counters for the test.",
        condition: goodCondition(),
        reward_credits: 1,
      },
    });
    expect(t.status).toBe(201);
    const p1 = await api("GET", "/api/pulse");
    expect(p1.body.last_task_id).toBe(t.body.task.id);
    const attest = await api("GET", "/api/attest");
    expect(attest.status).toBe(200);
    expect(attest.body.ok).toBe(true);
  });

  it("returns 404 with a JSON error for unknown routes", async () => {
    const r = await api("GET", "/api/nonesuch");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("no route");
  });
});
