// Worker entry. The router is the only piece with knowledge of the URL space.

import { route } from "./router.js";
import type { Env } from "./types.js";
import { error } from "./util.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const res = await route(env, request);
      // HEAD must return the same headers/status as GET, but no body.
      // The router treats HEAD as GET; we drop the body here.
      if (request.method.toUpperCase() === "HEAD") {
        return new Response(null, { status: res.status, headers: res.headers });
      }
      return res;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Do not leak stack traces. Log server-side, return a bare error.
      console.error("unhandled", msg);
      return error(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

export type { Env } from "./types.js";
