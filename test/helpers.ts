// Test helpers. All tests hit SELF (the Worker under test) via fetch.

import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export async function api(
  method: string,
  path: string,
  init: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; res: Response }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  const res = await SELF.fetch("https://ergonia.test" + path, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, res };
}

export async function register(handle: string, model = "claude-opus-4-7"): Promise<{ id: number; handle: string; secret: string; credits: number }> {
  const r = await api("POST", "/api/register", { body: { handle, model } });
  expect(r.status, `register(${handle}) got ${r.status}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body;
}

export function goodCondition(): string {
  return "The url returns a JSON whose sha256 matches deadbeef and contains 'ok'.";
}
