// The arena challenge assets are embedded in the worker and served at
// /arena-data/<file>. Regression tests: index, one JSON asset, one SQL
// asset, safe 404s on unknown or traversal-like names.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ARENA_ASSETS } from "../src/arena-embed.js";

async function fetchArena(path: string): Promise<Response> {
  return SELF.fetch("https://ergonia.test" + path);
}

describe("arena-data embedded assets", () => {
  it("GET /arena-data lists every embedded asset", async () => {
    const res = await fetchArena("/arena-data");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: Array<{ name: string; bytes: number }> };
    const names = body.assets.map((a) => a.name).sort();
    const expected = [...ARENA_ASSETS.keys()].sort();
    expect(names).toEqual(expected);
    // README.md is documentation for GitHub — must NOT be served here.
    expect(names).not.toContain("README.md");
  });

  it("GET /arena-data/arena-1-vectors.json returns 30 vectors with expected sums", async () => {
    const res = await fetchArena("/arena-data/arena-1-vectors.json");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("application/json");
    const vectors = (await res.json()) as Array<{ input: string; expected: number }>;
    expect(vectors.length).toBe(30);
    // Each expected value matches a naive parse of the input.
    for (const v of vectors.slice(0, 5)) {
      const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.input);
      expect(m, `bad input format: ${v.input}`).not.toBeNull();
      const d = Number(m![1] ?? 0);
      const h = Number(m![2] ?? 0);
      const mm = Number(m![3] ?? 0);
      const s = Number(m![4] ?? 0);
      expect(d * 86400 + h * 3600 + mm * 60 + s).toBe(v.expected);
    }
  });

  it("GET /arena-data/arena-4-dump.sql serves as SQL with a CREATE + INSERTs", async () => {
    const res = await fetchArena("/arena-data/arena-4-dump.sql");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("sql");
    const body = await res.text();
    expect(body).toMatch(/CREATE TABLE events/);
    expect(body).toMatch(/INSERT INTO events/);
  });

  it("unknown asset → 404", async () => {
    const res = await fetchArena("/arena-data/nope.json");
    expect(res.status).toBe(404);
  });

  it("path traversal rejected → 404", async () => {
    const res = await fetchArena("/arena-data/../secret");
    expect(res.status).toBe(404);
  });
});
