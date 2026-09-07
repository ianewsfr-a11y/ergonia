// Canonicalization rules of the T2 harness (scripts/arena/verify.mjs),
// checked on fixture events, never against the live API.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  eventRecord,
  isoSeconds,
  parseArtifact,
  replayLedger,
  sha256Hex,
  windowText,
  type ChainEvent,
} from "../scripts/arena/lib/chain.mjs";

const ev = (id: number, kind: string, payload: Record<string, unknown>, createdAt: number): ChainEvent => ({
  id,
  kind,
  payload,
  prev_hash: id === 1 ? "GENESIS" : "p".repeat(64),
  hash: "h".repeat(64),
  created_at: createdAt,
});

describe("T2 canonicalization", () => {
  it("sorts keys at every depth and emits no whitespace", () => {
    const s = canonicalJson({ z: 1, a: { y: [3, { d: 1, c: 2 }], b: "x y" } });
    expect(s).toBe('{"a":{"b":"x y","y":[3,{"c":2,"d":1}]},"z":1}');
    expect(s).not.toMatch(/\s(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/); // no whitespace outside strings
  });

  it("truncates sub-seconds instead of rounding", () => {
    expect(isoSeconds(1788807589523)).toBe("2026-09-07T18:59:49Z");
    expect(isoSeconds(1788807589999)).toBe("2026-09-07T18:59:49Z");
    expect(isoSeconds(1788807590000)).toBe("2026-09-07T18:59:50Z");
  });

  it("records the six served fields with created_at truncated, keys sorted", () => {
    const rec = canonicalJson(eventRecord(ev(2, "comment", { task_id: 11, comment_id: 15 }, 1788807589523)));
    expect(rec).toBe(
      '{"created_at":"2026-09-07T18:59:49Z","hash":"' + "h".repeat(64) + '","id":2,"kind":"comment","payload":{"comment_id":15,"task_id":11},"prev_hash":"' + "p".repeat(64) + '"}',
    );
  });

  it("joins lines with LF, ascending id, no trailing newline, whatever the input order", () => {
    const a = ev(1, "register", { handle: "a", member_id: 1, credits: 100, model: "m" }, 1787692130555);
    const b = ev(2, "register", { handle: "b", member_id: 2, credits: 100, model: "m" }, 1787692131999);
    const text = windowText([b, a]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"id":1');
    expect(lines[1]).toContain('"id":2');
    expect(text.endsWith("\n")).toBe(false);
    expect(text).not.toContain("\r");
  });

  it("hashes the UTF-8 bytes of the text (known vector)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("gives a stable hash for a fixture window", async () => {
    const w = [
      ev(1, "register", { credits: 100, handle: "a", member_id: 1, model: "m" }, 1787692130555),
      ev(2, "task_created", { author: "a", author_id: 1, expiry: null, guild: "arena", reward_credits: 30, task_id: 1, title: "t" }, 1787692131000),
    ];
    const h1 = await sha256Hex(windowText(w));
    const h2 = await sha256Hex(windowText([w[1]!, w[0]!]));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("artifact parsing", () => {
  it("reads the three lines in any order and ignores the rest", () => {
    const p = parseArtifact("note: hello\nSHA256=ABC\nHEAD=40\r\nFIRST_ID=1\n");
    expect(p).toEqual({ first_id: 1, head: 40, sha256: "abc" });
  });
  it("reports missing lines as null", () => {
    expect(parseArtifact("HEAD=3")).toEqual({ first_id: null, head: 3, sha256: null });
  });
});

describe("ledger replay", () => {
  const chain: ChainEvent[] = [
    ev(1, "register", { credits: 100, handle: "a", member_id: 1, model: "m" }, 1),
    ev(2, "register", { credits: 100, handle: "b", member_id: 2, model: "m" }, 2),
    ev(3, "founder_grant", { amount: 50, handle: "a", member_id: 1, reason: "seed" }, 3),
    ev(4, "task_created", { author: "a", author_id: 1, expiry: null, guild: "arena", reward_credits: 30, task_id: 1, title: "t" }, 4),
    ev(5, "task_created", { author: "a", author_id: 1, expiry: null, guild: "arena", reward_credits: 20, task_id: 2, title: "u" }, 5),
    ev(6, "submission", { artifact: "x", handle: "b", member_id: 2, submission_id: 1, task_id: 1 }, 6),
    ev(7, "verdict", { author_id: 1, credits_transferred: 30, karma_delta: 10, reason: "ok", status: "accepted", submission_id: 1, submitter_id: 2, task_id: 1 }, 7),
    ev(8, "credit_transfer", { amount: 30, from_member_id: 1, reason: "task_reward", submission_id: 1, task_id: 1, to_member_id: 2 }, 8),
    ev(9, "verdict", { author_id: 1, credits_transferred: 0, karma_delta: 0, reason: "no", status: "rejected", submission_id: 2, submitter_id: 2, task_id: 2 }, 9),
    ev(10, "task_closed", { author_id: 1, refunded_credits: 20, task_id: 2 }, 10),
  ];
  it("conserves the total and counts the accepted payout once", () => {
    const l = replayLedger(chain);
    expect(l.total).toBe(250);
    expect(l.circulating).toBe(250);
    expect(l.escrow).toBe(0);
    expect(l.balances).toEqual({ a: 120, b: 130 });
  });
  it("shows escrow while tasks are open, and leaves it on a rejected verdict", () => {
    expect(replayLedger(chain, 5)).toMatchObject({ total: 250, circulating: 200, escrow: 50, open_tasks: [1, 2] });
    expect(replayLedger(chain, 9)).toMatchObject({ total: 250, circulating: 230, escrow: 20, open_tasks: [2] });
  });
});
