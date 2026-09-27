// Standalone checks (flag CHECKS, off by default).
//
//   POST /api/check   (Bearer) {"spec": <schema-check spec>, "artifact": "<text>"}
//
// A schema-check@1 verdict on an artifact the caller supplies, outside
// any task: no escrow, no reward, no submission slot. The verdict is
// chained in a `check` event carrying the spec, the SHA-256 of the
// artifact and every finding, so anyone who holds the artifact can
// re-run the check and compare. The artifact itself is not stored: the
// two parties to a payment already have it, and a public log of paid
// content would turn this endpoint into a free mirror of it.
//
// OBSERVED EXTERNAL PROBLEM. x402r, a refundable-payments extension of
// x402, lets an escrow be released or voided by an arbiter, and its
// documentation names "schema validation or quality checks" as the use
// for its Delivery Protection operator. Its published arbiters are an AI
// judge its own README calls probabilistic, and a human jury (Kleros);
// the one arbiter it lists as replay-verifiable is marked "currently
// unavailable" (BackTrackCo/arbiter-examples, read 2026-09-27). An
// arbiter needs a verdict per payment, and schema-check@1 could only
// give one inside an Ergonia task. DECISIONS.md, 2026-09-27.

import { appendEvent } from "./chain.js";
import { sha256Hex } from "./hash.js";
import { releaseQuota, tryConsumeQuota } from "./quotas.js";
import type { AuthContext, Env } from "./types.js";
import { ARTIFACT_MAX_BYTES } from "./types.js";
import { canonicalJson, error, json, readBodyCapped } from "./util.js";
import { checkAgainstSpec, parseSpec, ID as SCHEMA_CHECK_ID } from "./verifiers/schema-check.js";
import { BRAND } from "./brand.js";

const encoder = new TextEncoder();
// Room for the JSON envelope and a spec of the maximum size around an
// artifact of exactly the cap.
const BODY_SLACK_BYTES = 8192;

interface CheckBody {
  spec?: unknown;
  artifact?: unknown;
}

export async function handleCheck(env: Env, ctx: AuthContext, request: Request): Promise<Response> {
  // Capped while reading, not only by the declared length: a streamed body
  // declares none (security review, 2026-09-27).
  const raw = await readBodyCapped(request, ARTIFACT_MAX_BYTES + BODY_SLACK_BYTES);
  if (!raw.ok) {
    return raw.tooLarge
      ? error(413, `body is larger than the artifact cap (${ARTIFACT_MAX_BYTES} UTF-8 bytes of artifact)`)
      : error(400, "body is not readable UTF-8");
  }
  let body: CheckBody | null = null;
  try {
    body = JSON.parse(raw.text) as CheckBody;
  } catch {
    return error(400, 'expected application/json {"spec": {...}, "artifact": "..."}');
  }
  if (!body || typeof body !== "object") return error(400, 'expected application/json {"spec": {...}, "artifact": "..."}');

  const parsed = parseSpec(body.spec);
  if (!parsed.ok) return error(400, parsed.reason);
  if (typeof body.artifact !== "string") {
    return error(400, "artifact must be a string: the exact text to judge, for example a JSON array serialised as it was delivered");
  }
  const artifact = body.artifact;
  const bytes = encoder.encode(artifact).length;
  if (bytes < 1) return error(400, "artifact must not be empty");
  if (bytes > ARTIFACT_MAX_BYTES) return error(400, `artifact must be at most ${ARTIFACT_MAX_BYTES} UTF-8 bytes (got ${bytes})`);

  // Every validation above is free; only a verdict costs quota. Checked
  // and charged in one statement, so a burst of requests cannot overshoot.
  if (!(await tryConsumeQuota(env, ctx.member, "checks"))) {
    return error(429, "daily check quota exhausted (resets 00:00 UTC)");
  }

  const { findings } = checkAgainstSpec(parsed.spec, artifact);
  const verdict = findings.every((f) => f.ok) ? "pass" : "fail";
  const specCanonical = canonicalJson(parsed.spec);
  const [specSha, artifactSha] = await Promise.all([sha256Hex(specCanonical), sha256Hex(artifact)]);

  let event: Awaited<ReturnType<typeof appendEvent>>;
  try {
    event = await appendEvent(env, "check", {
      member_id: ctx.member.id,
      handle: ctx.member.handle,
      verifier: SCHEMA_CHECK_ID,
      verdict,
      spec: parsed.spec,
      spec_sha256: specSha,
      artifact_sha256: artifactSha,
      artifact_bytes: bytes,
      findings,
    });
  } catch {
    // No record, no charge: a verdict that is not on the chain is not a
    // verdict anyone can check, so the caller gets its unit back.
    await releaseQuota(env, ctx.member, "checks");
    return error(503, "the verdict could not be recorded; nothing was charged, retry");
  }

  return json(
    {
      check: {
        event_id: event.id,
        event_hash: event.hash,
        verifier: SCHEMA_CHECK_ID,
        verdict,
        findings,
        spec_sha256: specSha,
        artifact_sha256: artifactSha,
        artifact_bytes: bytes,
        // Where anyone reads the chained record of this verdict.
        receipt: `${BRAND.origin}/api/events?before=${event.id + 1}&limit=1`,
        replay:
          "Fetch the receipt, confirm SHA-256 of the artifact you hold equals artifact_sha256, then POST the same spec and artifact here, or run the grammar at /api/verifiers/schema-check yourself: the findings must match.",
      },
    },
    { status: 201 },
  );
}
