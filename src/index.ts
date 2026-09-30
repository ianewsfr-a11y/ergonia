// Worker entry. The router is the only piece with knowledge of the URL space.

import { route } from "./router.js";
import type { Env } from "./types.js";
import { error } from "./util.js";
import { refusalsEnabled } from "./features.js";
import { isWriteMethod, recordRefusal, refusalRoute } from "./refusals.js";
import { resolveAuth } from "./auth.js";

// The error text of a refused response, or a neutral placeholder. Never
// throws, whatever the body is: counting must not change the answer.
async function errorTextOf(res: Response): Promise<string> {
  const body: unknown = await res.clone().json().catch(() => null);
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `http ${res.status}`;
}

// A refused write is counted (flag REFUSALS, src/refusals.ts). Awaited
// so the count exists when the response does; it runs only on 4xx for a
// write, and a failure to count never changes the answer the caller
// gets. Not on 5xx: those are our faults, already logged, and when the
// database is the fault, counting would only add load to it (security
// review, 2026-09-30). A 401 or a 429 is filed without looking the
// caller up, so a flood of either costs no extra read.
async function countRefusal(env: Env, request: Request, res: Response): Promise<void> {
  if (!refusalsEnabled(env) || !isWriteMethod(request.method) || res.status < 400 || res.status >= 500) return;
  try {
    const message = await errorTextOf(res);
    const auth = res.status === 401 || res.status === 429 ? null : await resolveAuth(env, request);
    await recordRefusal(env, {
      route: refusalRoute(new URL(request.url).pathname, message),
      status: res.status,
      message,
      memberId: auth?.member.id ?? null,
      userAgent: request.headers.get("user-agent"),
    });
  } catch (e: unknown) {
    console.error("refusal not counted", e instanceof Error ? e.message : String(e));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await route(env, request);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Do not leak stack traces. Log server-side, return a bare error.
      console.error("unhandled", msg);
      return error(500, "internal error");
    }
    await countRefusal(env, request, res);
    // HEAD must return the same headers/status as GET, but no body.
    // The router treats HEAD as GET; we drop the body here.
    if (request.method.toUpperCase() === "HEAD") {
      return new Response(null, { status: res.status, headers: res.headers });
    }
    return res;
  },
} satisfies ExportedHandler<Env>;

export type { Env } from "./types.js";
