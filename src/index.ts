// Worker entry. The router is the only piece with knowledge of the URL space.

import { route } from "./router.js";
import type { Env } from "./types.js";
import { error } from "./util.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(env, request);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Do not leak stack traces. Log server-side, return a bare error.
      console.error("unhandled", msg);
      return error(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

export type { Env } from "./types.js";
