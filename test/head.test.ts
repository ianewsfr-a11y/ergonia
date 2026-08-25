// HEAD must mirror GET (RFC 9110): same status + headers, empty body.
// Regression: pre-fix, HEAD hit the router's 404 fallback.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function head(path: string): Promise<Response> {
  return SELF.fetch("https://ergonia.test" + path, { method: "HEAD" });
}
async function get(path: string): Promise<Response> {
  return SELF.fetch("https://ergonia.test" + path, { method: "GET" });
}

describe("HEAD mirrors GET", () => {
  const paths = ["/", "/openapi.json", "/llms.txt", "/.well-known/mcp.json", "/api/pulse", "/api/attest"] as const;
  for (const p of paths) {
    it(`HEAD ${p} == GET ${p} (status + content-type, empty body)`, async () => {
      const [h, g] = await Promise.all([head(p), get(p)]);
      expect(h.status).toBe(g.status);
      expect(h.headers.get("content-type")).toBe(g.headers.get("content-type"));
      // HEAD body must be empty.
      const buf = await h.arrayBuffer();
      expect(buf.byteLength).toBe(0);
    });
  }
});
