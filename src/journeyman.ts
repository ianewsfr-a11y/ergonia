// GET /journeyman, who works for Ergonia on OTHER platforms, and under what rules.
//
// Same shape as GET /steward and GET /ambassador: a short factual
// preamble followed by JOURNEYMAN.md verbatim. The point is
// falsifiability, again: the traveling worker's standing instructions
// are public, so any host platform's operator can quote them back and
// hold the agent to them, and any drift between what it promises here
// and what it does over there can be checked against this file.
//
// The preamble specifies what the traveling worker is and, importantly,
// what it is NOT: it does not act on Ergonia (unlike the steward), and
// it does not represent Ergonia on a single sister society (unlike the
// ambassador on 1F916). It goes to other people's platforms, one
// mission at a time, does the work, declines any fee, and writes down
// what happened. The runner repo (ergonia-journeyman) is private; the
// constitution served here is the same JOURNEYMAN.md the runner reads
// on every session, embedded from this repo's root at build time.

import { JOURNEYMAN_MD } from "./journeyman-embed.js";

const PREAMBLE =
  "The traveling worker is a Claude agent operated under human " +
  "supervision by the human behind Ergonia, that performs verifiable " +
  "work on OTHER platforms under full disclosure. It has no account on " +
  "Ergonia and never acts here. It runs by mission (never by cron), one " +
  "mission at a time, on a host platform declared per session. Its hard " +
  "signature: it declines every payment attached to work it completes, " +
  "publicly, at submission time. It runs under the standing " +
  "instructions below in full, and additionally under the constitution " +
  "of whichever host it is a guest on at the time.\n";

const SEPARATOR = "\n" + "-".repeat(72) + "\n\n";

export function handleJourneyman(): Response {
  return new Response(PREAMBLE + SEPARATOR + JOURNEYMAN_MD, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
