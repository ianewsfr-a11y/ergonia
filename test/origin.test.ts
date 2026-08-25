// Verifies that the door, openapi.json, llms.txt and .well-known/mcp.json
// all build their URLs from the request Host, so serving the same worker
// under workers.dev, ergonia.works, or a local dev host produces
// documents whose examples are always accurate.

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { requestOrigin } from "../src/origin.js";

async function textAt(host: string, path: string): Promise<string> {
  const res = await SELF.fetch(`https://${host}${path}`);
  expect(res.status, `GET ${path} @ ${host}`).toBe(200);
  return res.text();
}

async function jsonAt<T = any>(host: string, path: string): Promise<T> {
  const res = await SELF.fetch(`https://${host}${path}`);
  expect(res.status, `GET ${path} @ ${host}`).toBe(200);
  return (await res.json()) as T;
}

describe("dynamic origin — door and machine surfaces", () => {
  const workersDev = "ergonia.ianewsfr.workers.dev";
  const custom = "ergonia.works";

  it("door mentions the request host in every example URL (workers.dev)", async () => {
    const body = await textAt(workersDev, "/");
    expect(body).toContain(`https://${workersDev}/api/register`);
    expect(body).toContain(`https://${workersDev}/mcp`);
    expect(body).toContain(`https://${workersDev}/.well-known/mcp.json`);
    // Old hardcoded ergonia.dev must not appear anywhere.
    expect(body).not.toContain("ergonia.dev");
  });

  it("door mentions the request host in every example URL (custom domain)", async () => {
    const body = await textAt(custom, "/");
    expect(body).toContain(`https://${custom}/api/register`);
    expect(body).toContain(`https://${custom}/mcp`);
    expect(body).not.toContain(workersDev);
  });

  it("openapi.json servers[].url reflects the request host", async () => {
    const wd = await jsonAt(workersDev, "/openapi.json");
    expect(wd.servers[0].url).toBe(`https://${workersDev}`);
    const cd = await jsonAt(custom, "/openapi.json");
    expect(cd.servers[0].url).toBe(`https://${custom}`);
  });

  it("llms.txt renders absolute URLs on the request host", async () => {
    const wd = await textAt(workersDev, "/llms.txt");
    expect(wd).toContain(`${workersDev}/mcp`);
    expect(wd).toContain(`${workersDev}/api/attest`);
    const cd = await textAt(custom, "/llms.txt");
    expect(cd).toContain(`${custom}/mcp`);
    expect(cd).not.toContain(workersDev);
  });

  it("/.well-known/mcp.json endpoints reflect the request host", async () => {
    const wd = await jsonAt(workersDev, "/.well-known/mcp.json");
    expect(wd.endpoints.full).toBe(`https://${workersDev}/mcp`);
    expect(wd.endpoints.readonly).toBe(`https://${workersDev}/mcp/read`);
    const cd = await jsonAt(custom, "/.well-known/mcp.json");
    expect(cd.endpoints.full).toBe(`https://${custom}/mcp`);
  });

  it("door serves Vary: Host so caches don't cross-serve", async () => {
    const res = await SELF.fetch(`https://${workersDev}/`);
    expect((res.headers.get("vary") ?? "").toLowerCase()).toContain("host");
  });
});

describe("requestOrigin() — unit", () => {
  it("prefers X-Forwarded-Host + X-Forwarded-Proto if present", () => {
    const req = new Request("https://internal.example/", {
      headers: {
        host: "internal.example",
        "x-forwarded-host": "ergonia.works",
        "x-forwarded-proto": "https",
      },
    });
    expect(requestOrigin(req)).toBe("https://ergonia.works");
  });

  it("uses Host header with inferred https for a public hostname", () => {
    const req = new Request("https://internal.example/", {
      headers: { host: "ergonia.works" },
    });
    expect(requestOrigin(req)).toBe("https://ergonia.works");
  });

  it("infers http for localhost / 127.0.0.1", () => {
    const req = new Request("http://internal.example/", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(requestOrigin(req)).toBe("http://127.0.0.1:8787");
  });

  it("falls back to url.origin when no headers help", () => {
    const req = new Request("https://origin.example/");
    // headers.get('host') returns null in this synthetic case → fallback path
    expect(requestOrigin(req)).toBe("https://origin.example");
  });

  it("takes only the first entry of a comma-separated X-Forwarded-Host", () => {
    const req = new Request("https://internal.example/", {
      headers: { "x-forwarded-host": "ergonia.works, other.example" },
    });
    expect(requestOrigin(req)).toBe("https://ergonia.works");
  });
});
