// Publishes Ergonia to the official MCP Registry without the third-party
// mcp-publisher binary. It reimplements exactly what that CLI does, which
// is small and worth not taking on trust:
//
//   1. timestamp = RFC3339 UTC
//   2. signature = Ed25519 over the timestamp string, hex encoded
//   3. POST /v0/auth/http {domain, timestamp, signed_timestamp} -> JWT
//   4. POST /v0/publish   with the server.json body and that JWT
//
// Signing uses Node's own crypto against the PEM already on disk, so no
// downloaded executable ever touches the private key.
//
//   node registry-publish.mjs <key.pem> <server.json> [--dry-run]

import { readFileSync } from "node:fs";
import { createPrivateKey, sign as edSign } from "node:crypto";

const REGISTRY = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io";
const DOMAIN = process.env.MCP_DOMAIN || "ergonia.works";

const keyPath = process.argv[2];
const serverPath = process.argv[3];
const dryRun = process.argv.includes("--dry-run");

if (!keyPath || !serverPath) {
  console.error("usage: registry-publish.mjs <key.pem> <server.json> [--dry-run]");
  process.exit(2);
}

const server = JSON.parse(readFileSync(serverPath, "utf8"));
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== "ed25519") {
  console.error(`expected an ed25519 key, got ${key.asymmetricKeyType}`);
  process.exit(2);
}

// Step 1 & 2 — sign the timestamp. Ed25519 signs the message directly,
// so the algorithm argument is null.
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const signature = edSign(null, Buffer.from(timestamp, "utf8"), key);
const signedTimestamp = signature.toString("hex");

console.log("domain           :", DOMAIN);
console.log("timestamp        :", timestamp);
console.log("signature (hex)  :", signedTimestamp.slice(0, 32) + "… (" + signedTimestamp.length / 2 + " bytes)");
console.log("server name      :", server.name);
console.log("server version   :", server.version);
console.log("remote           :", server.remotes?.[0]?.url, `(${server.remotes?.[0]?.type})`);
console.log("");

// Step 3 — exchange the signature for a registry token.
const authRes = await fetch(`${REGISTRY}/v0/auth/http`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ domain: DOMAIN, timestamp, signed_timestamp: signedTimestamp }),
});
const authBody = await authRes.text();
if (!authRes.ok) {
  console.error(`token exchange failed: HTTP ${authRes.status}`);
  console.error(authBody.slice(0, 600));
  process.exit(1);
}
const token = JSON.parse(authBody).registry_token;
if (!token) {
  console.error("no registry_token in the response");
  process.exit(1);
}
console.log(`token exchange   : OK (JWT, ${token.length} chars, not printed)`);

if (dryRun) {
  console.log("\n--dry-run: authentication proved, nothing published.");
  process.exit(0);
}

// Step 4 — publish.
const pubRes = await fetch(`${REGISTRY}/v0/publish`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(server),
});
const pubBody = await pubRes.text();
console.log(`publish          : HTTP ${pubRes.status}`);
try {
  const parsed = JSON.parse(pubBody);
  console.log(JSON.stringify(parsed, null, 2).slice(0, 1500));
} catch {
  console.log(pubBody.slice(0, 1000));
}
process.exitCode = pubRes.ok ? 0 : 1;
