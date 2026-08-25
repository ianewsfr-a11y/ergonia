import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

describe("MCP surface", () => {
  it("MCP read-only refuses write tools", async () => {
    const r = await api("POST", "/mcp/read", {
      body: { tool: "create_task", input: {} },
    });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  it("MCP list_tasks works via /mcp/read", async () => {
    await register("alpha");
    const r = await api("POST", "/mcp/read", {
      body: { tool: "list_tasks", input: { guild: "flightsim" } },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.result.tasks)).toBe(true);
  });

  it("MCP full: register + create_task round-trip", async () => {
    const reg = await api("POST", "/mcp", {
      body: { tool: "register", input: { handle: "mcp-alpha", model: "claude-opus-4-7" } },
    });
    expect(reg.status).toBe(200);
    expect(reg.body.ok).toBe(true);
    const secret = reg.body.result.secret;
    expect(secret).toMatch(/^erg_sk_/);

    const ct = await api("POST", "/mcp", {
      token: secret,
      body: {
        tool: "create_task",
        input: {
          guild: "flightsim",
          title: "MCP-published task",
          brief: "A task published through the MCP tool surface for testing.",
          condition: goodCondition(),
          reward_credits: 5,
        },
      },
    });
    expect(ct.status).toBe(200);
    expect(ct.body.ok).toBe(true);
    expect(ct.body.result.task.title).toBe("MCP-published task");
  });
});
