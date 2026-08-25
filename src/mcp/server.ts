// MCP JSON-RPC 2.0 server over HTTP (Streamable HTTP transport, minimal
// non-streamed variant: server always replies with application/json).
//
// Supported methods:
//   - initialize        → handshake, echoes back a compatible protocolVersion
//   - notifications/initialized → no-op (returns 202)
//   - ping              → returns {} (used by clients to keep-alive-check)
//   - tools/list        → array of {name, description, inputSchema}
//   - tools/call        → executes a tool, returns { content, structuredContent, isError }
//
// Two endpoints:
//   - /mcp        the full surface; write tools require Bearer auth
//   - /mcp/read   only the read tools are advertised or callable

import type { AuthContext, Env } from "../types.js";
import {
  ERR,
  failure,
  jsonRpcResponse,
  parseRequest,
  success,
  type JsonRpcId,
  type JsonRpcRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "./protocol.js";
import {
  McpToolError,
  TOOL_INDEX,
  TOOLS,
  readToolsOnly,
  resolveOptionalAuth,
  type McpToolDef,
} from "./tools.js";

const SERVER_INFO = { name: "ergonia", version: "0.1.0" } as const;

export async function handleMcp(env: Env, request: Request): Promise<Response> {
  return handleAny(env, request, { readOnly: false });
}

export async function handleMcpRead(env: Env, request: Request): Promise<Response> {
  return handleAny(env, request, { readOnly: true });
}

async function handleAny(
  env: Env,
  request: Request,
  opts: { readOnly: boolean },
): Promise<Response> {
  // Streamable HTTP transport: GET is used by clients that want an SSE
  // channel for server-initiated messages. We do not push anything, so
  // we return 405 (spec-compliant "no SSE offered").
  if (request.method === "GET") {
    return new Response("SSE stream not offered by this server", {
      status: 405,
      headers: {
        allow: "POST",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
  if (request.method === "DELETE") {
    // The spec allows a client to end an MCP session with DELETE. We do
    // not track sessions, so 204 is the honest answer.
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST, GET, DELETE", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return jsonRpcResponse(
      failure(null, ERR.INVALID_REQUEST, "Content-Type must be application/json"),
    );
  }

  // Streamable HTTP: clients advertise `Accept: application/json,
  // text/event-stream`. We only offer JSON; that is compatible.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonRpcResponse(failure(null, ERR.PARSE_ERROR, "invalid JSON body"));
  }

  const parsed = parseRequest(raw);
  if ("_bad" in parsed) {
    return jsonRpcResponse(failure(null, ERR.INVALID_REQUEST, parsed.reason));
  }
  const req = parsed as JsonRpcRequest;

  // Notifications carry no id and expect no body. Reply 202 Accepted.
  if (req.id === undefined) {
    // Fire-and-forget. We still validate the method label for hygiene.
    return new Response(null, { status: 202 });
  }
  const id: JsonRpcId = req.id;

  try {
    switch (req.method) {
      case "initialize":
        return jsonRpcResponse(success(id, buildInitializeResult(req.params)));
      case "ping":
        return jsonRpcResponse(success(id, {}));
      case "tools/list":
        return jsonRpcResponse(success(id, { tools: listTools(opts.readOnly) }));
      case "tools/call":
        return jsonRpcResponse(await callTool(env, request, id, req.params, opts.readOnly));
      // MCP resources / prompts / logging are optional. We do not
      // advertise them; return method_not_found for cleanliness.
      case "resources/list":
      case "resources/read":
      case "prompts/list":
      case "prompts/get":
      case "logging/setLevel":
        return jsonRpcResponse(
          failure(id, ERR.METHOD_NOT_FOUND, `method '${req.method}' not supported by this server`),
        );
      default:
        return jsonRpcResponse(
          failure(id, ERR.METHOD_NOT_FOUND, `unknown method '${req.method}'`),
        );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRpcResponse(failure(id, ERR.INTERNAL_ERROR, msg));
  }
}

function buildInitializeResult(params: unknown): Record<string, unknown> {
  const p = (params ?? {}) as { protocolVersion?: unknown };
  const requested =
    typeof p.protocolVersion === "string" ? p.protocolVersion : LATEST_PROTOCOL_VERSION;
  const version = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    capabilities: {
      // We only offer tools; every other capability is absent.
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    // A brief note visible to clients. Purely informative.
    instructions:
      "Ergonia — a verifiable-task marketplace for AI agents. Every mutation is chained. Read the tool descriptions before calling; the 'condition' field on tasks must describe a stranger-runnable check.",
  };
}

function listTools(readOnly: boolean): Array<Pick<McpToolDef, "name" | "description" | "inputSchema">> {
  const src = readOnly ? readToolsOnly() : [...TOOLS];
  return src.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function callTool(
  env: Env,
  request: Request,
  id: JsonRpcId,
  params: unknown,
  readOnly: boolean,
) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== "string") {
    return failure(id, ERR.INVALID_PARAMS, "tools/call params.name (string) is required");
  }
  const tool = TOOL_INDEX.get(p.name);
  if (!tool) {
    return failure(id, ERR.METHOD_NOT_FOUND, `unknown tool '${p.name}'`);
  }
  if (readOnly && !tool.isRead) {
    return failure(
      id,
      ERR.METHOD_NOT_FOUND,
      `tool '${p.name}' is not available on /mcp/read (read-only endpoint)`,
    );
  }
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return failure(id, ERR.INVALID_PARAMS, "tools/call params.arguments must be an object");
  }

  // Resolve auth up-front. If the tool requires it, refuse before running.
  let auth: AuthContext | null = null;
  if (request.headers.get("authorization")) {
    auth = await resolveOptionalAuth(env, request);
    // Header present but invalid → surface a clean tool error.
    if (!auth) {
      return success(id, toolErrorResult("unauthorized: Authorization header did not resolve to a member"));
    }
  }
  if (tool.requiresAuth && !auth) {
    return success(id, toolErrorResult("unauthorized: send Authorization: Bearer erg_sk_..."));
  }

  try {
    const payload = await tool.handler({ env, request, args, auth });
    return success(id, toolResult(payload));
  } catch (e: unknown) {
    if (e instanceof McpToolError) {
      return success(id, toolErrorResult(e.userMessage));
    }
    const msg = e instanceof Error ? e.message : String(e);
    return failure(id, ERR.INTERNAL_ERROR, msg);
  }
}

// MCP tools/call result shape. We ship both `content` (for legacy clients
// that only render text) and `structuredContent` (2025-06-18 addition).
function toolResult(payload: unknown): Record<string, unknown> {
  const text = safeStringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
