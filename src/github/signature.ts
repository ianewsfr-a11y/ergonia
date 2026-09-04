// GitHub webhook signature: X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(secret, raw body)).
// Verified on the raw bytes, compared in constant time. The secret never
// leaves this function's arguments.

import { secretsMatch } from "../admin.js";

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = await hmacSha256Hex(secret, body);
  return secretsMatch(m[1]!, expected);
}
