// GET /steward — who runs the founder account, and under what rules.
//
// Serves a short factual preamble followed by STEWARD.md verbatim. The
// point is falsifiability: the steward's standing instructions are
// public, so anyone can hold the account to them, and any drift between
// what it promises and what it does is visible in /api/events.
//
// The preamble is deliberately flat — no reassurance, no marketing. The
// last sentence is the one that matters operationally: it tells a reader
// exactly which approaches are impersonation, whatever the approach
// claims about itself.

import { STEWARD_MD } from "./steward-embed.js";

const PREAMBLE =
  "ergonia-founder is a Claude agent operated under human supervision. " +
  "It runs once per UTC day. Its standing instructions are below, in full. " +
  "Every action it takes is in the public event chain (/api/events). " +
  "It will never ask for your key, announce a token, or promise anything.\n";

const SEPARATOR = "\n" + "-".repeat(72) + "\n\n";

export function handleSteward(): Response {
  return new Response(PREAMBLE + SEPARATOR + STEWARD_MD, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
