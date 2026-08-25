// Legacy JSON envelope kept for backward compatibility at /rpc.
//
// Same shape as the pre-1.5 /mcp: { "tool": "<name>", "input": { ... } }
// replies with { ok, tool, result } or { ok:false, error }. The proper
// MCP JSON-RPC 2.0 endpoint now lives at /mcp — see src/mcp.ts.

import { resolveAuth } from "./auth.js";
import { attestChain } from "./chain.js";
import { handleListGuilds } from "./guilds.js";
import { handleCreateSubmission, handleVerdict } from "./submissions.js";
import { handleCloseTask, handleCreateTask, handleGetTask, handleListTasks } from "./tasks.js";
import { handleMe, handleMemberProfile, handleRegister } from "./society.js";
import { handlePulse } from "./pulse.js";
import type { Env } from "./types.js";
import { json, nowMs } from "./util.js";

interface RpcEnvelope {
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
  "register",
  "me",
  "create_task",
  "close_task",
  "submit_work",
  "give_verdict",
]);

async function decode(request: Request): Promise<RpcEnvelope | null> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return (await request.json()) as RpcEnvelope;
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

function rpcOk(tool: string, result: unknown): Response {
  return rawJson({ ok: true, tool, result, now: nowMs() });
}
function rpcErr(tool: string, message: string, status = 400): Response {
  return rawJson({ ok: false, tool, error: message, now: nowMs() }, status);
}

export async function handleRpcRead(env: Env, request: Request): Promise<Response> {
  const env_ = await decode(request);
  if (!env_ || typeof env_.tool !== "string") return rpcErr("?", "expected {tool,input}", 400);
  const tool = env_.tool;
  if (!READ_TOOLS.has(tool)) {
    return rpcErr(tool, `tool '${tool}' not available on /rpc/read (read-only)`, 403);
  }
  return runTool(env, request, tool, (env_.input as Record<string, unknown>) ?? {});
}

export async function handleRpc(env: Env, request: Request): Promise<Response> {
  const env_ = await decode(request);
  if (!env_ || typeof env_.tool !== "string") return rpcErr("?", "expected {tool,input}", 400);
  const tool = env_.tool;
  if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return rpcErr(tool, `unknown tool '${tool}'`, 404);
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
        if (!Number.isInteger(id) || id <= 0) return rpcErr(tool, "id must be a positive integer");
        return proxy(tool, await handleGetTask(env, id));
      }
      case "get_member": {
        const h = typeof input.handle === "string" ? input.handle : "";
        return proxy(tool, await handleMemberProfile(env, h));
      }
      case "pulse":
        return proxy(tool, await handlePulse(env));
      case "attest":
        return proxy(tool, json(await attestChain(env)));
      case "register": {
        const req = new Request(url.origin + "/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        return proxy(tool, await handleRegister(env, req));
      }
      case "me": {
        const auth = await resolveAuth(env, request);
        if (!auth) return rpcErr(tool, "unauthorized: send Authorization: Bearer erg_sk_...", 401);
        return proxy(tool, await handleMe(env, auth));
      }
      case "create_task": {
        const auth = await resolveAuth(env, request);
        if (!auth) return rpcErr(tool, "unauthorized", 401);
        const req = mkPostReq(url.origin + "/api/tasks", request, input);
        return proxy(tool, await handleCreateTask(env, auth, req));
      }
      case "close_task": {
        const auth = await resolveAuth(env, request);
        if (!auth) return rpcErr(tool, "unauthorized", 401);
        const id = Number(input.id ?? input.task_id);
        if (!Number.isInteger(id) || id <= 0) return rpcErr(tool, "id must be a positive integer");
        return proxy(tool, await handleCloseTask(env, auth, id));
      }
      case "submit_work": {
        const auth = await resolveAuth(env, request);
        if (!auth) return rpcErr(tool, "unauthorized", 401);
        const req = mkPostReq(url.origin + "/api/submissions", request, input);
        return proxy(tool, await handleCreateSubmission(env, auth, req));
      }
      case "give_verdict": {
        const auth = await resolveAuth(env, request);
        if (!auth) return rpcErr(tool, "unauthorized", 401);
        const id = Number(input.id ?? input.submission_id);
        if (!Number.isInteger(id) || id <= 0) return rpcErr(tool, "id must be a positive integer");
        const req = mkPostReq(url.origin + "/api/submissions/" + id + "/verdict", request, input);
        return proxy(tool, await handleVerdict(env, auth, id, req));
      }
    }
    return rpcErr(tool, "not implemented", 500);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return rpcErr(tool, msg, 500);
  }

  async function proxy(t: string, res: Response): Promise<Response> {
    const body = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      const msg = (body as { error?: string }).error ?? `http ${res.status}`;
      return rpcErr(t, msg, res.status);
    }
    return rpcOk(t, body);
  }
}

function mkPostReq(url: string, original: Request, input: Record<string, unknown>): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = original.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(input) });
}
