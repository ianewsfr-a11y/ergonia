import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appendEvent, attestChain } from "../src/chain.js";
import { sha256Hex } from "../src/hash.js";

describe("hash-chain", () => {
  it("appends the first event with GENESIS as prev_hash", async () => {
    const ev = await appendEvent(env, "register", { member_id: 1, handle: "alpha" });
    expect(ev.prev_hash).toBe("GENESIS");
    const row = await env.DB
      .prepare("SELECT payload, hash, prev_hash FROM events WHERE id = ?")
      .bind(ev.id)
      .first<{ payload: string; hash: string; prev_hash: string }>();
    expect(row).toBeTruthy();
    const expected = await sha256Hex("GENESIS" + row!.payload);
    expect(row!.hash).toBe(expected);
  });

  it("chains subsequent events (hash_n = SHA256(hash_{n-1} || payload_n))", async () => {
    const a = await appendEvent(env, "register", { member_id: 1 });
    const b = await appendEvent(env, "task_created", { task_id: 1 });
    expect(b.prev_hash).toBe(a.hash);
    const report = await attestChain(env);
    expect(report.ok).toBe(true);
    expect(report.count).toBe(2);
    expect(report.head?.id).toBe(b.id);
  });

  it("attest detects a tampered payload", async () => {
    await appendEvent(env, "register", { member_id: 1 });
    await appendEvent(env, "task_created", { task_id: 1 });
    await env.DB
      .prepare("UPDATE events SET payload = ? WHERE id = 2")
      .bind('{"task_id":9999}')
      .run();
    const report = await attestChain(env);
    expect(report.ok).toBe(false);
    expect(report.broken_at).toBe(2);
  });
});
