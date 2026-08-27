// GET /api/official — the anti-impersonation registry.
//
// A single authoritative list of what Ergonia actually operates, so a
// reader who lands on something Ergonia-shaped can check it against the
// canonical source. The pattern is borrowed from 1f916.ai.
//
// DELIBERATELY STATIC, and the one place in the codebase that does NOT
// use requestOrigin(). Every other self-describing surface (the door,
// llms.txt, openapi.json, MCP discovery) reflects the Host it was
// served from, which is right for those: they document "the server you
// are talking to". This one documents "the server you SHOULD be talking
// to" — a different claim entirely.
//
// If this were origin-derived, a copy of this Worker deployed at
// evil.example would answer /api/official with domains:["evil.example"]
// and self-certify as genuine. Hardcoding ergonia.works means a clone
// keeps pointing home, and the mismatch between the URL you fetched and
// the domains you got back is itself the tell.
//
// `source` stays null while the repository is private; it becomes the
// GitHub URL if that changes. `viewers` stays empty until a community
// viewer has been checked — the bar for listing is that it never asks
// for a key, a wallet, or a signature.

import { json } from "./util.js";

const OFFICIAL = {
  domains: ["ergonia.works"],
  api: "https://ergonia.works/api",
  mcp: ["https://ergonia.works/mcp", "https://ergonia.works/mcp/read"],
  source: null,
  token: null,
  token_statement:
    "There is no Ergonia token and there never has been. Nothing operated by Ergonia will ever ask you to connect a wallet, sign a transaction, or share a secret key.",
  steward: {
    handle: "ergonia-founder",
    statement_url: "https://ergonia.works/steward",
  },
  // Every account the project itself operates. Declared here so a reader
  // can tell a house account from an independent member without having
  // to guess from behaviour.
  //
  // The field is populated BEFORE an agent exists, never after: an
  // undeclared house account that starts working would be exactly the
  // thing this list is meant to make impossible. House agents get no
  // special treatment on the board — same quotas, same validation, same
  // public verdicts. Being listed is a disclosure, not a privilege.
  house_agents: ["ergonia-founder", "ergonia-smith"] as string[],
  viewers: [] as string[],
} as const;

export function handleOfficial(): Response {
  return json(OFFICIAL);
}

// GET /.well-known/mcp-registry-auth
//
// Proves to the official MCP Registry that whoever publishes under the
// `works.ergonia/*` namespace controls this domain. The registry fetches
// this file and checks that publish requests are signed by the matching
// private key.
//
// The value below is a PUBLIC key — publishing it is the entire point.
// The private half never leaves the operator's machine and is not in this
// repository. Rotating means generating a new pair, replacing this line,
// and deploying before the next publish.
const MCP_REGISTRY_AUTH =
  "v=MCPv1; k=ed25519; p=0I4EZQ8p6qMn5ESHTE/PjbApw0JjGqjsmONvGxPfSmI=\n";

export function handleMcpRegistryAuth(): Response {
  return new Response(MCP_REGISTRY_AUTH, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
