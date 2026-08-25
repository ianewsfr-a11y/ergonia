// Tiny hand-rolled router. No framework — the surface is small (SPEC §5)
// and the routes are static except for two integer id captures.

import { adminRoutesEnabled, handleFounderGrant } from "./admin.js";
import { handleArenaAsset, handleArenaIndex } from "./arena.js";
import { resolveAuth } from "./auth.js";
import { handleCreateComment, handleListComments } from "./comments.js";
import { handleDoor, handleRobots } from "./door.js";
import { handleListGuilds } from "./guilds.js";
import { handleMcp, handleMcpRead } from "./mcp/server.js";
import { handleLlmsTxt, handleMcpDiscovery, handleOpenApi } from "./openapi.js";
import { handleAttest, handleEvents, handlePulse } from "./pulse.js";
import { checkRateLimit } from "./quotas.js";
import { handleRpc, handleRpcRead } from "./rpc.js";
import { handleStats } from "./stats.js";
import { handleCreateSubmission, handleVerdict } from "./submissions.js";
import { handleCloseTask, handleCreateTask, handleGetTask, handleListTasks } from "./tasks.js";
import { handleMe, handleMemberProfile, handleRegister } from "./society.js";
import type { Env } from "./types.js";
import { error, json } from "./util.js";

export async function route(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const rawMethod = request.method.toUpperCase();
  // HEAD is semantically GET without a body (RFC 9110). Uptime checks,
  // caches, and link checkers rely on it. Route as GET, strip body below.
  const method = rawMethod === "HEAD" ? "GET" : rawMethod;

  // Public "front door" and machine-facing surfaces are unauthenticated
  // and not rate-limited (SPEC §2 — reads are unlimited, and these are read-only).
  if (method === "GET" && path === "/") return handleDoor(request);
  if (method === "GET" && path === "/robots.txt") return handleRobots();
  if (method === "GET" && path === "/llms.txt") return handleLlmsTxt(request);
  if (method === "GET" && path === "/openapi.json") return handleOpenApi(request);
  if (method === "GET" && path === "/.well-known/mcp.json") return handleMcpDiscovery(request);
  if (method === "GET" && path === "/arena-data") return handleArenaIndex();
  if (method === "GET" && path.startsWith("/arena-data/")) return handleArenaAsset(path);

  // /api/* is rate-limited (best-effort, per-IP-per-minute).
  if (path.startsWith("/api/")) {
    if (!(await checkRateLimit(env, request))) {
      return error(429, "rate limit: 120 requests / minute / IP on /api/*");
    }
  }

  if (method === "POST" && path === "/api/register") return handleRegister(env, request);

  if (method === "GET" && path === "/api/guilds") return handleListGuilds(env);
  if (method === "GET" && path === "/api/tasks") return handleListTasks(env, url);
  if (method === "GET" && path === "/api/pulse") return handlePulse(env);
  if (method === "GET" && path === "/api/events") return handleEvents(env, url);
  if (method === "GET" && path === "/api/attest") return handleAttest(env);
  if (method === "GET" && path === "/api/stats") return handleStats(env);

  // /api/admin/* exists only where ADMIN_GRANT_SECRET is provisioned.
  // Production leaves it unset, so these paths 404 exactly like any
  // unknown route — before authentication is even attempted, so the
  // endpoint cannot be probed for existence with a stolen Bearer.
  if (path.startsWith("/api/admin/")) {
    if (!adminRoutesEnabled(env)) return error(404, `no route for ${method} ${path}`);
    if (method === "POST" && path === "/api/admin/founder-grant") {
      const auth = await resolveAuth(env, request);
      if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
      return handleFounderGrant(env, auth, request);
    }
    return error(404, `no route for ${method} ${path}`);
  }

  const taskId = matchInt(path, /^\/api\/tasks\/(\d+)$/);
  if (taskId !== null) {
    if (method === "GET") return handleGetTask(env, taskId);
    return error(405, "method not allowed");
  }

  const taskCommentsId = matchInt(path, /^\/api\/tasks\/(\d+)\/comments$/);
  if (taskCommentsId !== null) {
    if (method !== "GET") return error(405, "method not allowed");
    return handleListComments(env, taskCommentsId, url);
  }

  const taskCloseId = matchInt(path, /^\/api\/tasks\/(\d+)\/close$/);
  if (taskCloseId !== null) {
    if (method !== "POST") return error(405, "method not allowed");
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleCloseTask(env, auth, taskCloseId);
  }

  const memberHandle = matchStr(path, /^\/api\/members\/([a-z0-9][a-z0-9-]{2,31})$/);
  if (memberHandle !== null) {
    if (method !== "GET") return error(405, "method not allowed");
    return handleMemberProfile(env, memberHandle);
  }

  if (method === "POST" && path === "/api/tasks") {
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleCreateTask(env, auth, request);
  }

  if (method === "GET" && path === "/api/me") {
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleMe(env, auth);
  }

  if (method === "POST" && path === "/api/submissions") {
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleCreateSubmission(env, auth, request);
  }

  if (method === "POST" && path === "/api/comments") {
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleCreateComment(env, auth, request);
  }

  const verdictId = matchInt(path, /^\/api\/submissions\/(\d+)\/verdict$/);
  if (verdictId !== null) {
    if (method !== "POST") return error(405, "method not allowed");
    const auth = await resolveAuth(env, request);
    if (!auth) return error(401, "unauthorized: send Authorization: Bearer erg_sk_...");
    return handleVerdict(env, auth, verdictId, request);
  }

  // MCP — real JSON-RPC 2.0 protocol (Streamable HTTP).
  if (path === "/mcp") return handleMcp(env, request);
  if (path === "/mcp/read") return handleMcpRead(env, request);

  // Legacy custom envelope kept at /rpc for backward compatibility.
  if (method === "POST" && path === "/rpc") return handleRpc(env, request);
  if (method === "POST" && path === "/rpc/read") return handleRpcRead(env, request);
  if (method === "GET" && (path === "/rpc" || path === "/rpc/read")) {
    return json({
      note: "POST {tool, input}. This is the legacy envelope kept for compatibility. The real MCP JSON-RPC 2.0 endpoint is at /mcp (see /.well-known/mcp.json).",
    });
  }

  return error(404, `no route for ${method} ${path}`);
}

function matchInt(path: string, re: RegExp): number | null {
  const m = re.exec(path);
  if (!m) return null;
  const n = Number(m[1]!);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function matchStr(path: string, re: RegExp): string | null {
  const m = re.exec(path);
  return m ? m[1]! : null;
}
