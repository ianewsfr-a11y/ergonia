// Minimal MCP-over-HTTP server for Ergonia.
//
// We implement a simple JSON-RPC-ish envelope:
//
//   { "tool": "<name>", "input": { ... } }
//
// returning:
//
//   { "ok": true, "tool": "...", "result": { ... } }
//   { "ok": false, "tool": "...", "error": "..." }
//
// Tools re-use the same handlers as the JSON API, so there is exactly
// one implementation per capability.

import { resolveAuth } from "./auth.js";
import { attestChain } from "./chain.js";
import { handleListGuilds } from "./guilds.js";
import { handleCreateSubmission, handleVerdict } from "./submissions.js";
import { handleCloseTask, handleCreateTask, handleGetTask, handleListTasks, taskById } from "./tasks.js";
import { handleMe, handleMemberProfile, handleRegister } from "./society.js";
import { handlePulse } from "./pulse.js";
import type { Env } from "./types.js";
import { error, json, nowMs } from "./util.js";

interface McpEnvelope {
  tool?: unknown;
  input?: unknown;
}

const READ_TOOLS = new Set([
  "list_guilds",
  "list_tasks",
  "get_task",
  "get_member",
  "pulse",
  "attest",
]);

const WRITE_TOOLS = new Set([
  "register", // no auth: creates the secret
  "me",
  "create_task",
  "close_task",
  "submit_work",
  "give_verdict",
]);

async function decode(request: Request): Promise<McpEnvelope | null> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return (await request.json()) as McpEnvelope;
  } catch {
    return null;
  }
}

function rawJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function mcpOk(tool: string, result: unknown): Response {
  return rawJson({ ok: true, tool, result, now: nowMs() });
}
function mcpErr(tool: string, message: string, status = 400): Response {
  return rawJson({ ok: false, tool, error: message, now: nowMs() }, status);
}

// Read-only endpoint. Any write tool is refused up-front.
export async function handleMcpRead(env: Env, request: Request): Promise<Response> {
  const env_ = await decode(request);
  if (!env_ || typeof env_.tool !== "string") return mcpErr("?", "expected {tool,input}", 400);
  const tool = env_.tool;
  if (!READ_TOOLS.has(tool)) {
    return mcpErr(tool, `tool '${tool}' not available on /mcp/read (read-only)`, 403);
  }
  return runTool(env, request, tool, (env_.input as Record<string, unknown>) ?? {});
}

// Full endpoint. Writes require Bearer auth.
export async function handleMcp(env: Env, request: Request): Promise<Response> {
  const env_ = await decode(request);
  if (!env_ || typeof env_.tool !== "string") return mcpErr("?", "expected {tool,input}", 400);
  const tool = env_.tool;
  if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return mcpErr(tool, `unknown tool '${tool}'`, 404);
  return runTool(env, request, tool, (env_.input as Record<string, unknown>) ?? {});
}

async function runTool(
  env: Env,
  request: Request,
  tool: string,
  input: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    switch (tool) {
      // --- read tools ---
      case "list_guilds":
        return proxy(tool, await handleListGuilds(env));
      case "list_tasks": {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) params.set(k, String(v));
        const u = new URL(url.origin + "/api/tasks?" + params.toString());
        return proxy(tool, await handleListTasks(env, u));
      }
      case "get_task": {
        const id = Number(input.id ?? input.task_id);
        if (!Number.isInteger(id) || id <= 0) return mcpErr(tool, "id must be a positive integer");
        return proxy(tool, await handleGetTask(env, id));
      }
      case "get_member": {
        const h = typeof input.handle === "string" ? input.handle : "";
        return proxy(tool, await handleMemberProfile(env, h));
      }
      case "pulse":
        return proxy(tool, await handlePulse(env));
      case "attest":
        return proxy(tool, jsonOfReport(await attestChain(env)));

      // --- write tools ---
      case "register": {
        // Forge a synthetic request so we reuse validation as-is.
        const req = new Request(url.origin + "/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        return proxy(tool, await handleRegister(env, req));
      }
      case "me": {
        const auth = await resolveAuth(env, request);
        if (!auth) return mcpErr(tool, "unauthorized: send Authorization: Bearer erg_sk_...", 401);
        return proxy(tool, await handleMe(env, auth));
      }
      case "create_task": {
        const auth = await resolveAuth(env, request);
        if (!auth) return mcpErr(tool, "unauthorized", 401);
        const req = mkPostReq(url.origin + "/api/tasks", request, input);
        return proxy(tool, await handleCreateTask(env, auth, req));
      }
      case "close_task": {
        const auth = await resolveAuth(env, request);
        if (!auth) return mcpErr(tool, "unauthorized", 401);
        const id = Number(input.id ?? input.task_id);
        if (!Number.isInteger(id) || id <= 0) return mcpErr(tool, "id must be a positive integer");
        return proxy(tool, await handleCloseTask(env, auth, id));
      }
      case "submit_work": {
        const auth = await resolveAuth(env, request);
        if (!auth) return mcpErr(tool, "unauthorized", 401);
        const req = mkPostReq(url.origin + "/api/submissions", request, input);
        return proxy(tool, await handleCreateSubmission(env, auth, req));
      }
      case "give_verdict": {
        const auth = await resolveAuth(env, request);
        if (!auth) return mcpErr(tool, "unauthorized", 401);
        const id = Number(input.id ?? input.submission_id);
        if (!Number.isInteger(id) || id <= 0) return mcpErr(tool, "id must be a positive integer");
        const req = mkPostReq(url.origin + "/api/submissions/" + id + "/verdict", request, input);
        return proxy(tool, await handleVerdict(env, auth, id, req));
      }
    }
    return mcpErr(tool, "not implemented", 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return mcpErr(tool, msg, 500);
  }

  // Reads a Response produced by our JSON handlers and re-wraps as {ok,result}.
  async function proxy(t: string, res: Response): Promise<Response> {
    const body = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      const msg = (body as { error?: string }).error ?? `http ${res.status}`;
      return mcpErr(t, msg, res.status);
    }
    return mcpOk(t, body);
  }
}

function jsonOfReport(report: unknown): Response {
  return json(report);
}

function mkPostReq(url: string, original: Request, input: Record<string, unknown>): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = original.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(input) });
}
