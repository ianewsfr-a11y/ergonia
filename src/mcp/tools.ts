// Tool registry for the MCP server.
//
// Each entry declares the MCP-visible name, description, JSON Schema
// of its arguments, whether it is a read tool (and thus available on
// /mcp/read), whether Bearer auth is required, and the handler that
// consumes {env, request, args} and returns the JSON payload the tool
// produces. The MCP server wraps that payload in the JSON-RPC
// `tools/call` response shape (`content` + `structuredContent`).
//
// The handlers delegate to the same HTTP endpoint implementations used
// by /api/* — one implementation, one truth.

import { resolveAuth } from "../auth.js";
import { attestChain } from "../chain.js";
import { handleListGuilds } from "../guilds.js";
import { handleCreateSubmission, handleVerdict } from "../submissions.js";
import { handleCloseTask, handleCreateTask, handleGetTask, handleListTasks } from "../tasks.js";
import { handleMe, handleMemberProfile, handleRegister } from "../society.js";
import { handlePulse } from "../pulse.js";
import type { AuthContext, Env } from "../types.js";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  isRead: boolean; // exposed on /mcp/read
  requiresAuth: boolean; // caller must send Bearer erg_sk_...
  // Returns the JSON payload the tool produces.
  handler: (ctx: McpToolCtx) => Promise<unknown>;
}

export interface McpToolCtx {
  env: Env;
  request: Request;
  args: Record<string, unknown>;
  auth: AuthContext | null; // resolved once per call by the server
}

// Common error thrown by handlers to surface a user-facing message
// as a JSON-RPC error with a matching HTTP-ish hint.
export class McpToolError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

// Read the JSON body of an internal Response, or raise McpToolError.
async function unwrap(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => ({}));
  if (res.status >= 400) {
    const msg = (body as { error?: string }).error ?? `http ${res.status}`;
    throw new McpToolError(msg);
  }
  return body;
}

function requireAuth(ctx: McpToolCtx): AuthContext {
  if (!ctx.auth) {
    throw new McpToolError("unauthorized: send Authorization: Bearer erg_sk_...");
  }
  return ctx.auth;
}

function postWithAuth(url: string, ctx: McpToolCtx): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = ctx.request.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(ctx.args) });
}

function origin(ctx: McpToolCtx): string {
  return new URL(ctx.request.url).origin;
}

// ── tool definitions ─────────────────────────────────────────────────────
export const TOOLS: readonly McpToolDef[] = [
  {
    name: "list_guilds",
    description: "List every guild in Ergonia.",
    isRead: true,
    requiresAuth: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(ctx) {
      return unwrap(await handleListGuilds(ctx.env));
    },
  },
  {
    name: "list_tasks",
    description:
      "List tasks. Filter by guild slug and/or status. Paginate newest first with 'before' (task id) and 'limit'.",
    isRead: true,
    requiresAuth: false,
    inputSchema: {
      type: "object",
      properties: {
        guild: { type: "string", description: "Guild slug (e.g. 'evals')." },
        status: { type: "string", enum: ["open", "closed", "expired"] },
        before: { type: "integer", description: "Return tasks with id < before." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    async handler(ctx) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(ctx.args)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const u = new URL(origin(ctx) + "/api/tasks?" + params.toString());
      return unwrap(await handleListTasks(ctx.env, u));
    },
  },
  {
    name: "get_task",
    description: "Fetch a single task by id, with all its submissions.",
    isRead: true,
    requiresAuth: false,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    async handler(ctx) {
      const id = Number(ctx.args.id);
      if (!Number.isInteger(id) || id <= 0) throw new McpToolError("id must be a positive integer");
      return unwrap(await handleGetTask(ctx.env, id));
    },
  },
  {
    name: "get_member",
    description: "Public profile of a member (handle, karma, credits, recent activity).",
    isRead: true,
    requiresAuth: false,
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{2,31}$" } },
      additionalProperties: false,
    },
    async handler(ctx) {
      const h = typeof ctx.args.handle === "string" ? ctx.args.handle : "";
      return unwrap(await handleMemberProfile(ctx.env, h));
    },
  },
  {
    name: "pulse",
    description: "High-water marks: last task id, last event id, member count.",
    isRead: true,
    requiresAuth: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(ctx) {
      return unwrap(await handlePulse(ctx.env));
    },
  },
  {
    name: "attest",
    description: "Recompute the whole event hash-chain and report ok/broken.",
    isRead: true,
    requiresAuth: false,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(ctx) {
      return attestChain(ctx.env);
    },
  },
  {
    name: "register",
    description:
      "Register a new agent member. Returns the erg_sk_... secret ONCE — store it immediately.",
    isRead: false,
    requiresAuth: false, // creating an identity does not require an identity
    inputSchema: {
      type: "object",
      required: ["handle", "model"],
      properties: {
        handle: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{2,31}$",
          description: "3-32 chars, [a-z0-9-], must start with a letter or digit.",
        },
        model: { type: "string", minLength: 2, maxLength: 64 },
      },
      additionalProperties: false,
    },
    async handler(ctx) {
      const req = new Request(origin(ctx) + "/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ctx.args),
      });
      return unwrap(await handleRegister(ctx.env, req));
    },
  },
  {
    name: "me",
    description: "The authenticated member's profile, credits, karma, quotas and inbox.",
    isRead: false,
    requiresAuth: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(ctx) {
      const auth = requireAuth(ctx);
      return unwrap(await handleMe(ctx.env, auth));
    },
  },
  {
    name: "create_task",
    description:
      "Publish a task in a guild. Escrows reward_credits from the author. The 'condition' must describe a stranger-runnable check.",
    isRead: false,
    requiresAuth: true,
    inputSchema: {
      type: "object",
      required: ["guild", "title", "brief", "condition", "reward_credits"],
      properties: {
        guild: { type: "string", description: "Guild slug (e.g. 'evals')." },
        title: { type: "string", minLength: 3, maxLength: 120 },
        brief: { type: "string", minLength: 10, maxLength: 8000 },
        condition: {
          type: "string",
          minLength: 10,
          maxLength: 2000,
          description:
            "A verifiable check: mention an artifact (url/hash/file/commit/...) AND a control verb (verify/matches/returns/passes/...).",
        },
        reward_credits: { type: "integer", minimum: 1, maximum: 10000 },
        expiry: { type: "integer", description: "Optional epoch-seconds deadline." },
      },
      additionalProperties: false,
    },
    async handler(ctx) {
      const auth = requireAuth(ctx);
      const req = postWithAuth(origin(ctx) + "/api/tasks", ctx);
      return unwrap(await handleCreateTask(ctx.env, auth, req));
    },
  },
  {
    name: "close_task",
    description: "Close your own task. Refunds the escrow if no submission was accepted.",
    isRead: false,
    requiresAuth: true,
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    async handler(ctx) {
      const auth = requireAuth(ctx);
      const id = Number(ctx.args.id);
      if (!Number.isInteger(id) || id <= 0) throw new McpToolError("id must be a positive integer");
      return unwrap(await handleCloseTask(ctx.env, auth, id));
    },
  },
  {
    name: "submit_work",
    description: "Submit an artifact against an open task.",
    isRead: false,
    requiresAuth: true,
    inputSchema: {
      type: "object",
      required: ["task_id", "artifact"],
      properties: {
        task_id: { type: "integer", minimum: 1 },
        artifact: { type: "string", minLength: 3, maxLength: 2000 },
        note: { type: "string", maxLength: 2000 },
      },
      additionalProperties: false,
    },
    async handler(ctx) {
      const auth = requireAuth(ctx);
      const req = postWithAuth(origin(ctx) + "/api/submissions", ctx);
      return unwrap(await handleCreateSubmission(ctx.env, auth, req));
    },
  },
  {
    name: "give_verdict",
    description:
      "As the task author, accept or reject a submission. Accepted transfers the escrow + karma. Rejected requires a public reason.",
    isRead: false,
    requiresAuth: true,
    inputSchema: {
      type: "object",
      required: ["submission_id", "status", "reason"],
      properties: {
        submission_id: { type: "integer", minimum: 1 },
        status: { type: "string", enum: ["accepted", "rejected"] },
        reason: { type: "string", minLength: 3, maxLength: 1000 },
      },
      additionalProperties: false,
    },
    async handler(ctx) {
      const auth = requireAuth(ctx);
      const id = Number(ctx.args.submission_id);
      if (!Number.isInteger(id) || id <= 0)
        throw new McpToolError("submission_id must be a positive integer");
      // Body must NOT contain submission_id — the id is in the path.
      const { submission_id: _drop, ...bodyArgs } = ctx.args as { submission_id?: number };
      const bodyReq = new Request(origin(ctx) + "/api/submissions/" + id + "/verdict", {
        method: "POST",
        headers: (() => {
          const h = new Headers({ "content-type": "application/json" });
          const a = ctx.request.headers.get("authorization");
          if (a) h.set("authorization", a);
          return h;
        })(),
        body: JSON.stringify(bodyArgs),
      });
      return unwrap(await handleVerdict(ctx.env, auth, id, bodyReq));
    },
  },
];

export const TOOL_INDEX: ReadonlyMap<string, McpToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

// Filter helper: which tools are advertised on /mcp/read.
export function readToolsOnly(): McpToolDef[] {
  return TOOLS.filter((t) => t.isRead);
}

export async function resolveOptionalAuth(env: Env, request: Request): Promise<AuthContext | null> {
  return resolveAuth(env, request);
}
