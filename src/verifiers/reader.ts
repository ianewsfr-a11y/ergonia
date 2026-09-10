// How an executable verifier reads a submission's artifact.
//
// Three sources, in the order the T0/T1 briefs offer them:
//   inline    the artifact field holds the text itself (chained as is)
//   on_world  https://ergonia.works/a/<sha256>, read from D1, hash re-checked
//   url       one public raw host from the allowlist below, GET only,
//             https only, redirects followed by hand with the host
//             re-checked at every hop, 200 kB cap, 10 s budget
//
// The allowlist mirrors the steward's read-public (ergonia-steward,
// lib/public-fetch.mjs, DECISIONS.md P0-B (a)) so the Worker and the
// steward read the same set of hosts. No credential is ever sent. Every
// other URL is unreadable by construction, and the verifier says so in
// its rejection instead of guessing.

import { artifactBySha, parseOnWorldUrl } from "../artifacts.js";
import { sha256Hex } from "../hash.js";
import type { Env } from "../types.js";

export const READ_CAP_BYTES = 200_000;
export const READ_TIMEOUT_MS = 10_000;
const MAX_HOPS = 3;

export const ALLOWED_RAW_HOSTS: ReadonlyArray<{ host: string; path_prefix?: string }> = Object.freeze([
  { host: "raw.githubusercontent.com" },
  { host: "gist.githubusercontent.com" },
  { host: "paste.rs" },
  { host: "pastebin.com", path_prefix: "/raw/" },
]);

export type ArtifactSource =
  | { kind: "inline"; bytes: number; sha256: string }
  | { kind: "on_world"; sha256: string; bytes: number }
  | { kind: "url"; url: string; host: string; bytes: number; sha256: string };

export type ReadResult =
  | { ok: true; text: string; source: ArtifactSource }
  | { ok: false; reason: string; retryable: boolean };

export function isUrl(artifact: string): boolean {
  return /^https?:\/\//i.test(artifact.trim());
}

function allowedUrl(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  for (const a of ALLOWED_RAW_HOSTS) {
    if (u.hostname !== a.host) continue;
    if (a.path_prefix && !u.pathname.startsWith(a.path_prefix)) return false;
    return true;
  }
  return false;
}

export function describeAllowedHosts(): string {
  return ALLOWED_RAW_HOSTS.map((a) => (a.path_prefix ? `${a.host}${a.path_prefix}` : a.host)).join(", ");
}

export async function readArtifact(env: Env, artifact: string, fetchImpl: typeof fetch = fetch): Promise<ReadResult> {
  const trimmed = artifact.trim();
  if (!isUrl(trimmed)) {
    const text = trimmed;
    return { ok: true, text, source: { kind: "inline", bytes: new TextEncoder().encode(text).length, sha256: await sha256Hex(text) } };
  }
  const sha = parseOnWorldUrl(trimmed);
  if (sha) {
    const row = await artifactBySha(env, sha);
    if (!row) return { ok: false, reason: `no on-world artifact at ${trimmed}`, retryable: false };
    const recomputed = await sha256Hex(row.content);
    if (recomputed !== row.sha256) return { ok: false, reason: "on-world artifact failed its own hash check", retryable: false };
    return { ok: true, text: row.content, source: { kind: "on_world", sha256: row.sha256, bytes: row.bytes } };
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "artifact is not a valid URL", retryable: false };
  }
  if (!allowedUrl(u)) {
    return {
      ok: false,
      reason: `artifact host is not one the verifier reads (${describeAllowedHosts()}); use an inline artifact, an on-world artifact, or one of those hosts`,
      retryable: false,
    };
  }
  return fetchAllowed(u, fetchImpl);
}

async function fetchAllowed(start: URL, fetchImpl: typeof fetch): Promise<ReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    let u = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      let res: Response;
      try {
        res = await fetchImpl(u.toString(), {
          method: "GET",
          redirect: "manual",
          headers: { accept: "text/plain, */*;q=0.5", "user-agent": "ergonia-verifier (https://ergonia.works/api/official)" },
          signal: controller.signal,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: `artifact could not be fetched from ${u.hostname}: ${msg}`, retryable: true };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, reason: `redirect without location from ${u.hostname}`, retryable: false };
        let next: URL;
        try {
          next = new URL(loc, u);
        } catch {
          return { ok: false, reason: `invalid redirect from ${u.hostname}`, retryable: false };
        }
        if (!allowedUrl(next)) return { ok: false, reason: `redirect to ${next.hostname} leaves the allowed hosts`, retryable: false };
        u = next;
        continue;
      }
      if (res.status >= 500) return { ok: false, reason: `${u.hostname} answered HTTP ${res.status}`, retryable: true };
      if (res.status !== 200) return { ok: false, reason: `${u.hostname} answered HTTP ${res.status} for the artifact URL`, retryable: false };
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > READ_CAP_BYTES) return { ok: false, reason: `artifact is larger than ${READ_CAP_BYTES} bytes`, retryable: false };
      const capped = await readCapped(res, READ_CAP_BYTES);
      if (capped === null) return { ok: false, reason: `artifact is larger than ${READ_CAP_BYTES} bytes`, retryable: false };
      const text = new TextDecoder("utf-8").decode(capped);
      return { ok: true, text, source: { kind: "url", url: u.toString(), host: u.hostname, bytes: capped.length, sha256: await sha256Hex(text) } };
    }
    return { ok: false, reason: `more than ${MAX_HOPS} redirects`, retryable: false };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
