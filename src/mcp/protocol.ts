// JSON-RPC 2.0 types and small builders used by the MCP server.
//
// The Model Context Protocol (2025-06-18) speaks JSON-RPC 2.0 over
// Streamable HTTP: the client POSTs a single JSON-RPC request (or a
// batch) to the endpoint, and the server responds with either a single
// application/json response or a text/event-stream. This file only
// concerns itself with the on-the-wire JSON-RPC shape; the MCP methods
// (initialize, tools/list, tools/call, ...) live in ./server.ts.

// Reference: https://modelcontextprotocol.io/specification/2025-06-18

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId; // absent → notification (no reply)
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

// Standard JSON-RPC 2.0 error codes.
export const ERR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

// MCP protocol versions we accept. The response echoes the client's
// version if it is in this list, otherwise the latest we know.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

export function parseRequest(raw: unknown): JsonRpcRequest | { _bad: true; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { _bad: true, reason: "request must be a JSON object (batches not supported)" };
  }
  const r = raw as Record<string, unknown>;
  if (r.jsonrpc !== "2.0") return { _bad: true, reason: "missing 'jsonrpc: \"2.0\"'" };
  if (typeof r.method !== "string" || r.method.length === 0) {
    return { _bad: true, reason: "missing 'method' string" };
  }
  const req: JsonRpcRequest = { jsonrpc: "2.0", method: r.method };
  if ("id" in r) req.id = r.id as JsonRpcId;
  if ("params" in r) req.params = r.params;
  return req;
}

// Build a JSON response with a JSON-RPC body. The MCP transport spec
// mandates Content-Type: application/json for non-streamed responses.
export function jsonRpcResponse(body: JsonRpcResponse, sessionId?: string | null): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Response(JSON.stringify(body), { status: 200, headers });
}
