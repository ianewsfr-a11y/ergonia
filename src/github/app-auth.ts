// GitHub App authentication: an RS256 JWT signed with the App's private
// key, exchanged for a short-lived installation token.
//
// The private key is a Worker secret (GITHUB_APP_PRIVATE_KEY). GitHub
// hands it out as PKCS#1 PEM ("BEGIN RSA PRIVATE KEY"); WebCrypto
// imports PKCS#8, so a PKCS#1 body is wrapped in the PKCS#8 envelope
// here. Both forms are accepted. Nothing in this module logs or returns
// key material or tokens beyond the token value the caller needs.

import type { Env } from "../types.js";
import { GITHUB_API_VERSION, USER_AGENT, githubApiBase } from "./config.js";

const encoder = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(s: string): string {
  return b64urlFromBytes(encoder.encode(s));
}

function pemBody(pem: string): { kind: "pkcs1" | "pkcs8"; der: Uint8Array } {
  const trimmed = pem.trim();
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(trimmed);
  const isPkcs8 = /-----BEGIN PRIVATE KEY-----/.test(trimmed);
  if (!isPkcs1 && !isPkcs8) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const b64 = trimmed
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { kind: isPkcs1 ? "pkcs1" : "pkcs8", der };
}

// DER length encoding for the two wrapper SEQUENCE/OCTET STRING lengths.
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  if (n < 0x10000) return [0x82, n >> 8, n & 0xff];
  return [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
}

// PKCS#8 = SEQUENCE { INTEGER 0, AlgorithmIdentifier(rsaEncryption), OCTET STRING(pkcs1) }
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const innerLen = version.length + algo.length + octet.length + pkcs1.length;
  const head = [0x30, ...derLen(innerLen), ...version, ...algo, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head, 0);
  out.set(pkcs1, head.length);
  return out;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const { kind, der } = pemBody(pem);
  const pkcs8 = kind === "pkcs1" ? wrapPkcs1(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// A JWT valid for ~9 minutes, issued 60 s in the past to absorb clock
// skew (GitHub's documented recommendation).
export async function appJwt(env: Env): Promise<string> {
  const appId = env.GITHUB_APP_ID ?? "";
  const pem = env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId || !pem) throw new Error("GitHub App credentials are not configured");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const key = await importPrivateKey(pem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Per-isolate cache. Installation tokens last an hour; we drop them two
// minutes early. The cache holds token strings in memory only.
const tokenCache = new Map<number, CachedToken>();

export async function installationToken(env: Env, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const jwt = await appJwt(env);
  const res = await fetch(`${githubApiBase(env)}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
    },
  });
  if (res.status !== 201) {
    // Status only: the response body of a failed token exchange can
    // contain details we do not want in logs.
    throw new Error(`installation token exchange failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("installation token exchange returned no token");
  }
  const expiresAt =
    typeof body.expires_at === "string" ? Date.parse(body.expires_at) - 2 * 60_000 : Date.now() + 50 * 60_000;
  tokenCache.set(installationId, { token: body.token, expiresAt });
  return body.token;
}

export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}
