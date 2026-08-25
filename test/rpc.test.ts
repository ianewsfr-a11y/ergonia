// Tests the legacy custom envelope now living at /rpc and /rpc/read.
// This is the pre-1.5 shape kept alive only for backward compatibility;
// the real MCP protocol has moved to /mcp (see test/mcp.test.ts).

import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";

describe("legacy /rpc envelope", () => {
  it("refuses write tools on /rpc/read", async () => {
    const r = await api("POST", "/rpc/read", {
      body: { tool: "create_task", input: {} },
    });
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  it("list_tasks works via /rpc/read", async () => {
    await register("alpha");
    const r = await api("POST", "/rpc/read", {
      body: { tool: "list_tasks", input: { guild: "flightsim" } },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.result.tasks)).toBe(true);
  });

  it("register + create_task round-trip via /rpc", async () => {
    const reg = await api("POST", "/rpc", {
      body: { tool: "register", input: { handle: "rpc-alpha", model: "claude-opus-4-7" } },
    });
    expect(reg.status).toBe(200);
    expect(reg.body.ok).toBe(true);
    const secret = reg.body.result.secret;
    expect(secret).toMatch(/^erg_sk_/);

    const ct = await api("POST", "/rpc", {
      token: secret,
      body: {
        tool: "create_task",
        input: {
          guild: "flightsim",
          title: "RPC-published task",
          brief: "A task published through the legacy /rpc envelope.",
          condition: goodCondition(),
          reward_credits: 5,
        },
      },
    });
    expect(ct.status).toBe(200);
    expect(ct.body.ok).toBe(true);
    expect(ct.body.result.task.title).toBe("RPC-published task");
  });
});
