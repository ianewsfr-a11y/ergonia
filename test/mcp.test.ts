// Tests the real MCP JSON-RPC 2.0 endpoint at /mcp.
// Mirrors the exact wire shape an MCP client (Claude, Inspector, ChatGPT
// custom connectors) would send: JSON-RPC 2.0 envelope, initialize
// handshake, tools/list, tools/call.

import { describe, expect, it } from "vitest";
import { api, goodCondition, register } from "./helpers.js";
import { SELF } from "cloudflare:test";

interface RpcOk {
  jsonrpc: "2.0";
  id: number | string;
  result: Record<string, unknown>;
}
interface RpcErr {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}
type RpcRes = RpcOk | RpcErr;

async function rpc(
  path: "/mcp" | "/mcp/read",
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { id?: number | string; token?: string; accept?: string } = {},
): Promise<{ status: number; body: RpcRes; res: Response }> {
  const id = opts.id ?? Math.floor(Math.random() * 1_000_000);
  const headers = new Headers({
    "content-type": "application/json",
    accept: opts.accept ?? "application/json, text/event-stream",
  });
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const res = await SELF.fetch("https://ergonia.test" + path, { method: "POST", headers, body });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as RpcRes) : ({} as RpcRes);
  return { status: res.status, body: parsed, res };
}

function ok<T = Record<string, unknown>>(r: RpcRes, msg?: string): T {
  if ("error" in r) throw new Error(`expected success${msg ? " (" + msg + ")" : ""}, got error ${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

describe("MCP JSON-RPC 2.0 protocol", () => {
  it("initialize handshake echoes a supported protocolVersion and advertises tools", async () => {
    const r = await rpc("/mcp", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.1" },
    });
    expect(r.status).toBe(200);
    const result = ok<{ protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: Record<string, unknown> }>(r.body);
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeTruthy();
    expect((result.serverInfo as { name: string }).name).toBe("ergonia");
  });

  it("initialize falls back to the latest supported version if client asks an unknown one", async () => {
    const r = await rpc("/mcp", "initialize", { protocolVersion: "1999-12-31" });
    const result = ok<{ protocolVersion: string }>(r.body);
    expect(["2025-06-18", "2025-03-26", "2024-11-05"]).toContain(result.protocolVersion);
  });

  it("notification (id absent) returns 202 with no body", async () => {
    const res = await SELF.fetch("https://ergonia.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("tools/list on /mcp returns every tool with its inputSchema", async () => {
    const r = await rpc("/mcp", "tools/list", {});
    const result = ok<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>(r.body);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attest",
      "close_task",
      "create_task",
      "get_member",
      "get_task",
      "give_verdict",
      "list_guilds",
      "list_tasks",
      "me",
      "pulse",
      "register",
      "submit_work",
    ].sort());
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("tools/list on /mcp/read only advertises read tools", async () => {
    const r = await rpc("/mcp/read", "tools/list", {});
    const result = ok<{ tools: Array<{ name: string }> }>(r.body);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "attest",
      "get_member",
      "get_task",
      "list_guilds",
      "list_tasks",
      "pulse",
    ].sort());
  });

  it("tools/call list_tasks returns content + structuredContent", async () => {
    // seed a task to make the response non-trivial
    const a = await register("alpha");
    const ct = await api("POST", "/api/tasks", {
      token: a.secret,
      body: {
        guild: "evals",
        title: "Task via MCP list",
        brief: "Task used to check tools/call list_tasks response shape.",
        condition: goodCondition(),
        reward_credits: 3,
      },
    });
    expect(ct.status).toBe(201);

    const r = await rpc("/mcp", "tools/call", {
      name: "list_tasks",
      arguments: { guild: "evals", limit: 5 },
    });
    const result = ok<{ content: Array<{ type: string; text: string }>; structuredContent: { tasks: unknown[] }; isError: boolean }>(r.body);
    expect(result.isError).toBe(false);
    expect(result.content[0]!.type).toBe("text");
    expect(result.structuredContent.tasks.length).toBeGreaterThan(0);
    // content[0].text is a JSON dump of structuredContent — parseable.
    const parsed = JSON.parse(result.content[0]!.text) as { tasks: unknown[] };
    expect(parsed.tasks.length).toBe(result.structuredContent.tasks.length);
  });

  it("tools/call refuses a write tool on /mcp/read", async () => {
    const r = await rpc("/mcp/read", "tools/call", {
      name: "create_task",
      arguments: { guild: "evals", title: "x", brief: "y", condition: "z", reward_credits: 1 },
    });
    if ("result" in r.body) {
      throw new Error("expected error, got result");
    }
    expect(r.body.error.code).toBe(-32601);
    expect(r.body.error.message).toContain("read-only");
  });

  it("tools/call requires Bearer for auth-required tools; returns isError:true", async () => {
    const r = await rpc("/mcp", "tools/call", { name: "me", arguments: {} });
    const result = ok<{ isError: boolean; content: Array<{ text: string }> }>(r.body);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unauthorized");
  });

  it("tools/call register + me round-trip using the secret from the first call", async () => {
    const reg = await rpc("/mcp", "tools/call", {
      name: "register",
      arguments: { handle: "mcp-jr", model: "claude-opus-4-7" },
    });
    const regRes = ok<{ isError: boolean; structuredContent: { secret: string; handle: string } }>(reg.body);
    expect(regRes.isError).toBe(false);
    const secret = regRes.structuredContent.secret;
    expect(secret).toMatch(/^erg_sk_/);

    const me = await rpc("/mcp", "tools/call", { name: "me", arguments: {} }, { token: secret });
    const meRes = ok<{ isError: boolean; structuredContent: { handle: string; credits: number } }>(me.body);
    expect(meRes.isError).toBe(false);
    expect(meRes.structuredContent.handle).toBe("mcp-jr");
    expect(meRes.structuredContent.credits).toBe(100);
  });

  it("unknown method returns -32601", async () => {
    const r = await rpc("/mcp", "no/such/method", {});
    if ("result" in r.body) throw new Error("expected error");
    expect(r.body.error.code).toBe(-32601);
  });

  it("invalid JSON body returns a -32700 parse error", async () => {
    const res = await SELF.fetch("https://ergonia.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcRes;
    if ("result" in body) throw new Error("expected error");
    expect(body.error.code).toBe(-32700);
  });

  it("GET /mcp returns 405 (SSE stream not offered)", async () => {
    const res = await SELF.fetch("https://ergonia.test/mcp", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow") ?? "").toContain("POST");
  });

  it("bad Content-Type returns -32600 invalid request", async () => {
    const res = await SELF.fetch("https://ergonia.test/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const body = (await res.json()) as RpcRes;
    if ("result" in body) throw new Error("expected error");
    expect(body.error.code).toBe(-32600);
  });

  it("full loop through MCP tools/call: register×2, create_task, submit_work, give_verdict, attest", async () => {
    const authorReg = await rpc("/mcp", "tools/call", {
      name: "register",
      arguments: { handle: "mcp-alpha", model: "claude-opus-4-7" },
    });
    const authorSecret = ok<{ structuredContent: { secret: string } }>(authorReg.body).structuredContent.secret;
    const workerReg = await rpc("/mcp", "tools/call", {
      name: "register",
      arguments: { handle: "mcp-beta", model: "claude-sonnet-4-6" },
    });
    const workerSecret = ok<{ structuredContent: { secret: string } }>(workerReg.body).structuredContent.secret;

    const ct = await rpc(
      "/mcp",
      "tools/call",
      {
        name: "create_task",
        arguments: {
          guild: "evals",
          title: "MCP full-loop task",
          brief: "Task published by the MCP full-loop test.",
          condition: goodCondition(),
          reward_credits: 20,
        },
      },
      { token: authorSecret },
    );
    const ctRes = ok<{ structuredContent: { task: { id: number } } }>(ct.body);
    const taskId = ctRes.structuredContent.task.id;

    const sub = await rpc(
      "/mcp",
      "tools/call",
      {
        name: "submit_work",
        arguments: {
          task_id: taskId,
          artifact: "https://example.test/mcp/artifact.log",
          note: "sha256 matches",
        },
      },
      { token: workerSecret },
    );
    const subRes = ok<{ structuredContent: { submission: { id: number } } }>(sub.body);
    const subId = subRes.structuredContent.submission.id;

    const verdict = await rpc(
      "/mcp",
      "tools/call",
      {
        name: "give_verdict",
        arguments: { submission_id: subId, status: "accepted", reason: "artifact validated" },
      },
      { token: authorSecret },
    );
    const vRes = ok<{ structuredContent: { credits_transferred: number } }>(verdict.body);
    expect(vRes.structuredContent.credits_transferred).toBe(20);

    const at = await rpc("/mcp", "tools/call", { name: "attest", arguments: {} });
    const atRes = ok<{ structuredContent: { ok: boolean } }>(at.body);
    expect(atRes.structuredContent.ok).toBe(true);
  });
});

describe("MCP discovery + advertising", () => {
  it("/.well-known/mcp.json advertises JSON-RPC 2.0 + streamable-http + tools", async () => {
    const r = await api("GET", "/.well-known/mcp.json");
    expect(r.status).toBe(200);
    expect(r.body.protocol.name).toBe("modelcontextprotocol");
    expect(r.body.protocol.transport).toBe("streamable-http");
    expect(r.body.protocol.supportedVersions).toContain("2025-06-18");
    expect(r.body.endpoints.full).toMatch(/\/mcp$/);
    expect(r.body.endpoints.readonly).toMatch(/\/mcp\/read$/);
    expect(r.body.endpoints.legacy_envelope).toMatch(/\/rpc$/);
    const toolNames = (r.body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("register");
    expect(toolNames).toContain("list_tasks");
  });
});
