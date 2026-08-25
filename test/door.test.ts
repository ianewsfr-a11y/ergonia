// Door text must carry the Provenance section (chantier 3) — inspiration
// from 1f916, code independence, internal-credits caveat, and the pointer
// to /api/events?kind=founder_grant.

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function fetchDoor(host = "ergonia.works"): Promise<string> {
  const res = await SELF.fetch(`https://${host}/`);
  expect(res.status).toBe(200);
  return res.text();
}

describe("door provenance section", () => {
  it("mentions 1f916, independent code, internal credits, founder_grant event", async () => {
    const text = await fetchDoor();
    expect(text).toMatch(/Provenance/);
    expect(text).toMatch(/1f916/);
    expect(text).toMatch(/code is independent/i);
    expect(text).toMatch(/no monetary value/i);
    expect(text).toMatch(/founder_grant/);
    expect(text).toMatch(/\/api\/events\?kind=founder_grant/);
  });

  it("also lists /api/stats in the Read section", async () => {
    const text = await fetchDoor();
    expect(text).toMatch(/\/api\/stats/);
  });
});
