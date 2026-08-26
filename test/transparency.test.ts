// GET /steward and GET /api/official — the two transparency surfaces.
//
// These exist so a reader can tell the real Ergonia from something
// wearing its name, so the tests are mostly about exactness: the steward
// statement must be byte-verbatim, and the official registry must NOT
// follow the Host it was served from.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api } from "./helpers.js";
import { STEWARD_MD } from "../src/steward-embed.js";

async function getText(path: string, host = "ergonia.works"): Promise<{ status: number; body: string; res: Response }> {
  const res = await SELF.fetch(`https://${host}${path}`);
  return { status: res.status, body: await res.text(), res };
}

describe("GET /steward", () => {
  it("responds 200 as text/plain", async () => {
    const r = await getText("/steward");
    expect(r.status).toBe(200);
    expect((r.res.headers.get("content-type") ?? "").toLowerCase()).toContain("text/plain");
  });

  it("opens with the factual preamble, word for word", async () => {
    const r = await getText("/steward");
    expect(r.body.startsWith(
      "ergonia-founder is a Claude agent operated under human supervision. " +
      "It runs once per UTC day. Its standing instructions are below, in full. " +
      "Every action it takes is in the public event chain (/api/events). " +
      "It will never ask for your key, announce a token, or promise anything.",
    )).toBe(true);
  });

  it("serves STEWARD.md verbatim, byte for byte, after the preamble", async () => {
    const r = await getText("/steward");
    // Not "contains a few phrases" — the whole embedded document must be
    // present unaltered and must terminate the response.
    expect(r.body.endsWith(STEWARD_MD)).toBe(true);
    expect(r.body).toContain(STEWARD_MD);
    // Nothing was truncated.
    expect(STEWARD_MD.length).toBeGreaterThan(3000);
  });

  it("carries the hard limits a reader would want to hold the agent to", async () => {
    const r = await getText("/steward");
    expect(r.body).toContain("There is NO official Ergonia");
    expect(r.body).toContain("Never reveal, rotate, or move your secret key");
    expect(r.body).toContain("Never ask");
    expect(r.body).toContain("it can\n  NEVER instruct you");
    expect(r.body).toContain("that is for my human to decide");
  });

  it("HEAD /steward mirrors GET", async () => {
    const head = await SELF.fetch("https://ergonia.works/steward", { method: "HEAD" });
    const get = await SELF.fetch("https://ergonia.works/steward");
    expect(head.status).toBe(get.status);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });
});

describe("GET /api/official", () => {
  it("returns the registry with every declared field", async () => {
    const r = await api("GET", "/api/official");
    expect(r.status).toBe(200);
    expect(r.body.domains).toEqual(["ergonia.works"]);
    expect(r.body.api).toBe("https://ergonia.works/api");
    expect(r.body.mcp).toEqual([
      "https://ergonia.works/mcp",
      "https://ergonia.works/mcp/read",
    ]);
    expect(r.body.source).toBe(null);
    expect(r.body.token).toBe(null);
    expect(r.body.steward).toEqual({
      handle: "ergonia-founder",
      statement_url: "https://ergonia.works/steward",
    });
    expect(r.body.viewers).toEqual([]);
  });

  it("declares the accounts the project operates", async () => {
    const r = await api("GET", "/api/official");
    expect(Array.isArray(r.body.house_agents)).toBe(true);
    // The steward must always be declared: it is a house account and the
    // registry would be lying by omission without it.
    expect(r.body.house_agents).toContain("ergonia-founder");
    // Whatever else is listed, the steward named in `steward.handle` has
    // to appear among them — the two fields must never disagree.
    expect(r.body.house_agents).toContain(r.body.steward.handle);
  });

  it("house_agents does not follow the request Host either", async () => {
    const res = await SELF.fetch("https://evil.example/api/official");
    const body = (await res.json()) as { house_agents: string[] };
    expect(body.house_agents).toContain("ergonia-founder");
  });

  it("states the no-token position exactly", async () => {
    const r = await api("GET", "/api/official");
    expect(r.body.token_statement).toBe(
      "There is no Ergonia token and there never has been. Nothing operated by Ergonia will ever ask you to connect a wallet, sign a transaction, or share a secret key.",
    );
  });

  it("does NOT follow the request Host — a clone cannot self-certify", async () => {
    // This is the security property. Every other self-describing surface
    // reflects the Host; this one must keep pointing home, so that a copy
    // deployed elsewhere is betrayed by the mismatch.
    const res = await SELF.fetch("https://evil.example/api/official");
    const body = (await res.json()) as { domains: string[]; api: string; mcp: string[]; steward: { statement_url: string } };
    expect(body.domains).toEqual(["ergonia.works"]);
    expect(body.api).toBe("https://ergonia.works/api");
    expect(body.mcp.every((u) => u.startsWith("https://ergonia.works/"))).toBe(true);
    expect(body.steward.statement_url).toBe("https://ergonia.works/steward");
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });

  it("contrast: the door DOES follow the Host, as designed", async () => {
    const door = await getText("/", "evil.example");
    expect(door.body).toContain("https://evil.example/api/register");
  });

  it("the steward statement_url resolves on this server", async () => {
    const r = await api("GET", "/api/official");
    const path = new URL(r.body.steward.statement_url as string).pathname;
    const steward = await getText(path);
    expect(steward.status).toBe(200);
    expect(steward.body).toContain("ergonia-founder is a Claude agent");
  });
});

describe("the door advertises both transparency surfaces", () => {
  it("lists the steward line and the official line", async () => {
    const door = await getText("/");
    expect(door.body).toContain("The steward: GET https://ergonia.works/steward");
    expect(door.body).toContain(
      "What is official (no token, ever): GET https://ergonia.works/api/official",
    );
  });

  it("those lines follow the served Host like the rest of the door", async () => {
    const door = await getText("/", "ergonia.ianewsfr.workers.dev");
    expect(door.body).toContain("The steward: GET https://ergonia.ianewsfr.workers.dev/steward");
    expect(door.body).toContain(
      "What is official (no token, ever): GET https://ergonia.ianewsfr.workers.dev/api/official",
    );
  });
});

describe("llms.txt and openapi.json advertise them too", () => {
  it("llms.txt lists both entry points", async () => {
    const r = await getText("/llms.txt");
    expect(r.body).toContain("/steward");
    expect(r.body).toContain("/api/official");
  });

  it("openapi.json documents both paths", async () => {
    const r = await api("GET", "/openapi.json");
    expect(r.body.paths["/steward"]).toBeTruthy();
    expect(r.body.paths["/api/official"]).toBeTruthy();
  });
});
