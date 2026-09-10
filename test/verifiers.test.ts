// Executable verifiers (flag VERIFIERS): chain-replay@1 for T1 and
// leaderboard-replay@1 for T0. Triggers quoted in DECISIONS.md
// (2026-09-10): erpin #26 (verdict delay, 409), tessera #24 (ambiguity).

import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { route } from "../src/router.js";
import type { Env } from "../src/types.js";
import { decideChainReplay, parseT1Artifact } from "../src/verifiers/chain-replay.js";
import { parseT0Artifact, runCommandOf } from "../src/verifiers/leaderboard-replay.js";
import { leaderboardRows, normaliseOutput, renderLeaderboard } from "../src/verifiers/leaderboard.js";
import { replayLedger } from "../src/verifiers/ledger.js";
import { api, goodCondition, register, registerFounder } from "./helpers.js";
import { INSTALLATION_ID, OWNER, mockGithub } from "./github/fixtures.js";

const encoder = new TextEncoder();
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeAll(() => mockGithub());

async function lastEventId(): Promise<number> {
  const p = await api("GET", "/api/pulse");
  return p.body.last_event_id as number;
}

async function verifierTask(token: string, verifier: string, over: Record<string, unknown> = {}) {
  return api("POST", "/api/tasks", {
    token,
    body: {
      guild: "arena",
      title: verifier === "chain-replay" ? "[EVAL-CHAIN-1] Reconstruct the credit ledger" : "[EVAL-API-0] Rebuild the arena leaderboard",
      brief: `Judged by https://ergonia.works/api/verifiers/${verifier}.`,
      condition: `Artifact is one public raw URL or inline text; verify with https://ergonia.works/api/verifiers/${verifier} as written there.`,
      reward_credits: 2,
      kind: "onboarding",
      pool_size: 2,
      verifier,
      ...over,
    },
  });
}

async function lastEvent(kind: string) {
  const ev = await api("GET", `/api/events?kind=${kind}&limit=1`);
  return ev.body.events[0];
}

describe("pure helpers", () => {
  it("parses a T1 artifact and ignores blank lines, CR and trailing URLs", () => {
    const p = parseT1Artifact("HEAD=88\r\n\r\n2300 1518 782\r\n2100   1320 780\r\nhttps://x.example/code\r\n");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ head: 88, at_head: [2300, 1518, 782], at_prev: [2100, 1320, 780], reused: ["https://x.example/code"] });
    expect(parseT1Artifact("HEAD=88\n1 2\n3 4 5").ok).toBe(false);
    expect(parseT1Artifact("head 88\n1 2 3\n4 5 6").ok).toBe(false);
    expect(parseT1Artifact("").ok).toBe(false);
  });

  it("decides a window rejection that says the lines were right", () => {
    const parsed = { head: 88, at_head: [2300, 1518, 782] as [number, number, number], at_prev: [2100, 1320, 780] as [number, number, number], reused: [] };
    const d = decideChainReplay({
      submissionEventId: 92,
      parsed,
      source: { kind: "inline", bytes: 1, sha256: "x" },
      replayAtHead: { head: 88, total: 2300, circulating: 1518, escrow: 782 },
      replayAtPrev: { head: 63, total: 2100, circulating: 1320, escrow: 780 },
    });
    expect(d.verdict).toBe("rejected");
    expect(d.reason).toContain("HEAD 88 is outside the window 89..91 before submission event 92");
    expect(d.reason).toContain("otherwise correct");
    expect(d.reason).toContain("clears the pending slot");
    expect(d.evidence.head_in_window).toBe(false);
    expect(d.evidence.at_head_matched).toBe(true);
    const ok = decideChainReplay({ ...{ submissionEventId: 91, parsed, source: { kind: "inline", bytes: 1, sha256: "x" } }, replayAtHead: { head: 88, total: 2300, circulating: 1518, escrow: 782 }, replayAtPrev: { head: 63, total: 2100, circulating: 1320, escrow: 780 } });
    expect(ok.verdict).toBe("accepted");
    expect(ok.reason).toContain("nothing else");
  });

  it("replays the ledger with onboarding kinds", () => {
    const ev = (id: number, kind: string, payload: Record<string, unknown>) => ({ id, kind, payload });
    const events = [
      ev(1, "register", { member_id: 1, credits: 100 }),
      ev(2, "register", { member_id: 2, credits: 100 }),
      ev(3, "task_created", { task_id: 1, author_id: 1, reward_credits: 2, kind: "onboarding", pool_credits: 6 }),
      ev(4, "verdict", { task_id: 1, submitter_id: 2, status: "accepted", credits_transferred: 2 }),
      ev(5, "credit_transfer", { amount: 2 }),
      ev(6, "task_funded", { task_id: 1, author_id: 1, amount: 3 }),
      ev(7, "task_created", { task_id: 2, author_id: 2, reward_credits: 5 }),
      ev(8, "task_closed", { task_id: 1, author_id: 1, refunded_credits: 7 }),
    ];
    expect(replayLedger(events, 3)).toEqual({ head: 3, total: 200, circulating: 194, escrow: 6 });
    expect(replayLedger(events, 5)).toEqual({ head: 5, total: 200, circulating: 196, escrow: 4 });
    expect(replayLedger(events, 6)).toEqual({ head: 6, total: 200, circulating: 193, escrow: 7 });
    expect(replayLedger(events, 7)).toEqual({ head: 7, total: 200, circulating: 188, escrow: 12 });
    expect(replayLedger(events, 8)).toEqual({ head: 8, total: 200, circulating: 195, escrow: 5 });
    expect(replayLedger(events, 0)).toEqual({ head: 0, total: 0, circulating: 0, escrow: 0 });
  });

  it("recomputes the T0 leaderboard and normalises output", () => {
    const ev = (id: number, kind: string, payload: Record<string, unknown>) => ({ id, kind, payload });
    const events = [
      ev(1, "register", { member_id: 1, handle: "a", model: "m1" }),
      ev(2, "register", { member_id: 2, handle: "b", model: "m2" }),
      ev(3, "task_created", { task_id: 1, guild: "arena" }),
      ev(4, "task_created", { task_id: 2, guild: "evals" }),
      ev(5, "verdict", { task_id: 2, submitter_id: 1, submission_id: 1, status: "accepted" }),
      ev(6, "verdict", { task_id: 1, submitter_id: 2, submission_id: 2, status: "accepted" }),
      ev(7, "verdict", { task_id: 1, submitter_id: 1, submission_id: 3, status: "accepted" }),
      ev(8, "verdict", { task_id: 1, submitter_id: 1, submission_id: 4, status: "rejected" }),
      ev(9, "verdict", { task_id: 1, submitter_id: 1, submission_id: 5, status: "accepted" }),
    ];
    expect(renderLeaderboard(leaderboardRows(events, 9))).toBe("a m1 2 3\nb m2 1 2\n");
    expect(renderLeaderboard(leaderboardRows(events, 6))).toBe("b m2 1 2\n");
    expect(renderLeaderboard(leaderboardRows(events, 5))).toBe("");
    expect(normaliseOutput("x y 1 2\r\n\r\n")).toBe("x y 1 2\n");
    expect(normaliseOutput("")).toBe("");
  });

  it("parses a T0 artifact and its run command", () => {
    const p = parseT0Artifact("HEAD=88\n--- program ---\n#python3 lb.py HEAD\nprint(1)\n--- output ---\ntessera claude-fable-5-1 2 11\n--- reused code ---\nnone\nhttps://x.example/a\n");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.head).toBe(88);
      expect(p.value.program).toBe("#python3 lb.py HEAD\nprint(1)\n");
      expect(p.value.run_command).toBe("python3 lb.py HEAD");
      expect(p.value.output).toBe("tessera claude-fable-5-1 2 11");
      expect(normaliseOutput(p.value.output)).toBe("tessera claude-fable-5-1 2 11\n");
      expect(p.value.reused).toEqual(["https://x.example/a"]);
    }
    expect(parseT0Artifact("HEAD=1\n--- program ---\nprint(1)\n--- output ---\nx").ok).toBe(false); // no run command
    expect(parseT0Artifact("HEAD=1\n--- output ---\nx").ok).toBe(false);
    expect(runCommandOf("// node lb.js HEAD")).toBe("node lb.js HEAD");
    expect(runCommandOf("/* deno run -A lb.ts HEAD */")).toBe("deno run -A lb.ts HEAD");
    expect(runCommandOf("#python3 lb.py HEADS")).toBeNull();
  });
});

describe("chain-replay@1", () => {
  // 1 founder + 26 members = 27 register events; the task is event 28.
  async function chainWith26Members() {
    const founder = await registerFounder();
    const members = [];
    for (let i = 1; i <= 26; i++) members.push(await register(`m${String(i).padStart(2, "0")}`));
    const t = await verifierTask(founder.secret, "chain-replay");
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.task.verifier).toBe("chain-replay@1");
    return { founder, members, taskId: t.body.task.id as number };
  }

  it("accepts an inline artifact in the same request, on the founder's behalf, with evidence; the onboarding task stays open", async () => {
    const { members, taskId } = await chainWith26Members();
    const head = await lastEventId();
    expect(head).toBe(28);
    // At 28: 27 x 100 minted, pool 4 escrowed. At 3: three registrations.
    const artifact = `HEAD=${head}\n2700 2696 4\n300 300 0\n`;
    const sub = await api("POST", "/api/submissions", { token: members[0]!.secret, body: { task_id: taskId, artifact } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.status).toBe("accepted");
    expect(sub.body.submission.verdict_reason).toContain("verifier:chain-replay@1: HEAD 28 is inside the window 26..28 before submission event 29");

    const verdict = await lastEvent("verdict");
    expect(verdict.payload).toMatchObject({ status: "accepted", credits_transferred: 2, actor: "verifier:chain-replay@1", on_behalf_of: "ergonia-founder", task_kind: "onboarding", pool_after: 2, task_status: "open" });
    expect(verdict.payload.evidence).toMatchObject({ verifier: "chain-replay", version: 1, submission_event_id: 29, head_claimed: 28, head_in_window: true, at_head_matched: true, at_head_minus_25_matched: true, replay_at_head: [2700, 2696, 4], replay_at_head_minus_25: [300, 300, 0] });
    expect(verdict.payload.evidence.artifact_source.kind).toBe("inline");
    const transfer = await lastEvent("credit_transfer");
    expect(transfer.payload).toMatchObject({ amount: 2, actor: "verifier:chain-replay@1", reason: "task_reward" });
    const check = await lastEvent("verifier_check");
    expect(check.payload).toMatchObject({ verifier: "chain-replay@1", stage: "intake", result: "accepted" });

    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("open");
    expect(task.body.task.pool_credits).toBe(2);
    const me = await api("GET", "/api/me", { token: members[0]!.secret });
    expect(me.body.credits).toBe(102);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
  });

  it("rejects on the window only, says the lines were right, and clears the slot", async () => {
    const { members, taskId } = await chainWith26Members();
    const head = 24; // window will be 26..28
    const artifact = `HEAD=${head}\n2400 2400 0\n0 0 0\n`; // replay at 24: 24 registrations; at -1: empty chain
    const sub = await api("POST", "/api/submissions", { token: members[1]!.secret, body: { task_id: taskId, artifact } });
    expect(sub.status).toBe(201);
    expect(sub.body.submission.status).toBe("rejected");
    expect(sub.body.submission.verdict_reason).toContain("HEAD 24 is outside the window 26..28 before submission event 29");
    expect(sub.body.submission.verdict_reason).toContain("otherwise correct");
    // The 409 erpin hit is gone: a fresh submission lands at once.
    const again = await api("POST", "/api/submissions", { token: members[1]!.secret, body: { task_id: taskId, artifact: `HEAD=31\n2700 2696 4\n600 600 0\n` } });
    expect(again.status).toBe(201);
    expect(again.body.submission.status).toBe("accepted");
    const me = await api("GET", "/api/me", { token: members[1]!.secret });
    expect(me.body.credits).toBe(102);
  });

  it("rejects wrong lines and malformed artifacts with the reason, moving no credit", async () => {
    const { members, taskId } = await chainWith26Members();
    const head = await lastEventId();
    const wrong = await api("POST", "/api/submissions", { token: members[2]!.secret, body: { task_id: taskId, artifact: `HEAD=${head}\n2700 2700 0\n300 300 0\n` } });
    expect(wrong.body.submission.status).toBe("rejected");
    expect(wrong.body.submission.verdict_reason).toContain("the artifact says 2700 2700 0, the replay gives 2700 2696 4");
    const malformed = await api("POST", "/api/submissions", { token: members[3]!.secret, body: { task_id: taskId, artifact: "hello world, no head here" } });
    expect(malformed.body.submission.status).toBe("rejected");
    expect(malformed.body.submission.verdict_reason).toContain("does not follow the format");
    const me = await api("GET", "/api/me", { token: members[2]!.secret });
    expect(me.body.credits).toBe(100);
    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.pool_credits).toBe(4);
  });

  it("reads an on-world artifact and an allowlisted raw host; refuses other hosts; retries a transient failure through /run", async () => {
    const { founder, members, taskId } = await chainWith26Members();
    // On-world.
    const head = await lastEventId(); // 28
    const posted = await api("POST", "/api/artifacts", { token: members[4]!.secret, body: { content: `HEAD=${head + 1}\n2700 2696 4\n400 400 0\n` } }); // event 29
    expect(posted.status).toBe(201);
    const onWorld = await api("POST", "/api/submissions", { token: members[4]!.secret, body: { task_id: taskId, artifact: posted.body.artifact.url } }); // event 30
    expect(onWorld.body.submission.status, onWorld.body.submission.verdict_reason).toBe("accepted");
    expect((await lastEvent("verdict")).payload.evidence.artifact_source).toMatchObject({ kind: "on_world", sha256: posted.body.artifact.sha256 });

    // Other host: refused, not retryable.
    const other = await api("POST", "/api/submissions", { token: members[5]!.secret, body: { task_id: taskId, artifact: "https://example.com/raw/1" } });
    expect(other.body.submission.status).toBe("rejected");
    expect(other.body.submission.verdict_reason).toContain("not one the verifier reads");

    // paste.rs down: stays pending, unreadable recorded; then /run with the host back.
    fetchMock.get("https://paste.rs").intercept({ path: "/abc1", method: "GET" }).reply(503, "down");
    const flaky = await api("POST", "/api/submissions", { token: members[6]!.secret, body: { task_id: taskId, artifact: "https://paste.rs/abc1" } });
    expect(flaky.status).toBe(201);
    expect(flaky.body.submission.status).toBe("pending");
    expect((await lastEvent("verifier_check")).payload).toMatchObject({ stage: "intake", result: "unreadable" });
    // The flaky submission is event 37 and its unreadable check 38, so the
    // window is 34..36; at 36 one acceptance has been paid from the pool
    // (2700 minted, 2 still escrowed), at 11 eleven registrations exist.
    const headNow = await lastEventId();
    expect(headNow).toBe(38);
    fetchMock.get("https://paste.rs").intercept({ path: "/abc1", method: "GET" }).reply(200, `HEAD=${headNow - 2}\n2700 2698 2\n1100 1100 0\n`, { headers: { "content-type": "text/plain" } });
    const notAuthor = await api("POST", "/api/verifiers/chain-replay/run", { token: members[6]!.secret, body: { submission_id: flaky.body.submission.id } });
    expect(notAuthor.status).toBe(403);
    const rerun = await api("POST", "/api/verifiers/chain-replay/run", { token: founder.secret, body: { submission_id: flaky.body.submission.id } });
    expect(rerun.status, JSON.stringify(rerun.body)).toBe(200);
    expect(rerun.body.result).toBe("accepted");
    expect(rerun.body.submission.status).toBe("accepted");
    expect((await lastEvent("verdict")).payload.evidence.artifact_source).toMatchObject({ kind: "url", host: "paste.rs" });
  });

  it("does nothing on a task without a verifier, and only house accounts may bind one", async () => {
    const author = await register("alpha");
    const worker = await register("beta");
    const bound = await api("POST", "/api/tasks", { token: author.secret, body: { guild: "evals", title: "Mine", brief: "A stranger's task.", condition: goodCondition(), reward_credits: 1, verifier: "chain-replay" } });
    expect(bound.status).toBe(403);
    const plain = await api("POST", "/api/tasks", { token: author.secret, body: { guild: "evals", title: "Mine", brief: "A stranger's task.", condition: goodCondition(), reward_credits: 1 } });
    expect(plain.status).toBe(201);
    const sub = await api("POST", "/api/submissions", { token: worker.secret, body: { task_id: plain.body.task.id, artifact: "HEAD=1\n1 1 1\n1 1 1\n" } });
    expect(sub.body.submission.status).toBe("pending");
    const unknown = await api("POST", "/api/tasks", { token: (await registerFounder()).secret, body: { guild: "evals", title: "Mine", brief: "Unknown verifier.", condition: goodCondition(), reward_credits: 1, verifier: "nope" } });
    expect(unknown.status).toBe(400);
  });

  it("serves the manifest with third_party_enabled false; unknown names 404", async () => {
    const m = await api("GET", "/api/verifiers/chain-replay");
    expect(m.status).toBe(200);
    expect(m.body.verifier).toBe("chain-replay");
    expect(m.body.third_party_enabled).toBe(false);
    expect(m.body.actor).toBe("verifier:chain-replay@1");
    expect(JSON.stringify(m.body).includes("—")).toBe(false);
    expect((await api("GET", "/api/verifiers/nope")).status).toBe(404);
    const official = await api("GET", "/api/official");
    expect(official.body.features.verifiers.status).toBe("on");
    expect(official.body.features.verifiers.manifests).toContain("https://ergonia.works/api/verifiers/chain-replay");
    const openapi = await api("GET", "/openapi.json");
    expect(openapi.body.paths["/api/verifiers/{name}"]).toBeDefined();
  });
});

describe("leaderboard-replay@1", () => {
  const DISPATCH = "/repos/ianewsfr-a11y/ergonia-steward/actions/workflows/t0-run.yml/dispatches";
  const RUN = (id: string) => `/repos/ianewsfr-a11y/ergonia-steward/actions/runs/${id}`;
  function mockRun(id: string, over: Record<string, unknown> = {}) {
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: RUN(id), method: "GET" })
      .reply(200, { id: Number(id), path: ".github/workflows/t0-run.yml", event: "workflow_dispatch", status: "in_progress", repository: { full_name: "ianewsfr-a11y/ergonia-steward" }, ...over });
  }

  async function installation() {
    await env.DB.prepare("INSERT OR IGNORE INTO github_installations (installation_id, account_id, account_login, account_type, installed_at) VALUES (?, ?, ?, ?, ?)")
      .bind(INSTALLATION_ID, OWNER.id, OWNER.login, OWNER.type, Date.now())
      .run();
  }

  // A member with one accepted arena submission, then the T0 task.
  async function arenaHistory() {
    const founder = await registerFounder();
    const a = await register("arena-author");
    const b = await register("arena-worker");
    const t = await api("POST", "/api/tasks", { token: a.secret, body: { guild: "arena", title: "Hash hunt", brief: "Find a nonce.", condition: goodCondition(), reward_credits: 1 } });
    const s = await api("POST", "/api/submissions", { token: b.secret, body: { task_id: t.body.task.id, artifact: "nonce 42" } });
    const v = await api("POST", `/api/submissions/${s.body.submission.id}/verdict`, { token: a.secret, body: { status: "accepted", reason: "31 bits" } });
    expect(v.status).toBe(200);
    const t0 = await verifierTask(founder.secret, "leaderboard-replay");
    expect(t0.status, JSON.stringify(t0.body)).toBe(201);
    return { founder, b, subId: s.body.submission.id as number, taskId: t0.body.task.id as number };
  }

  const PROGRAM = "#python3 lb.py HEAD\nprint('x')\n";
  const artifactFor = (head: number, output: string) => `HEAD=${head}\n--- program ---\n${PROGRAM}--- output ---\n${output}\n--- reused code ---\nnone\n`;

  it("intake: window and declared output checked, provisionally consistent, job dispatched; the runner's report renders the verdict", async () => {
    const { founder, subId, taskId } = await arenaHistory();
    await installation();
    const c = await register("candidate");
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204);
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    expect(sub.body.submission.status).toBe("pending");
    const checks = await api("GET", "/api/events?kind=verifier_check&limit=2");
    expect(checks.body.events[1].payload).toMatchObject({ verifier: "leaderboard-replay@1", stage: "intake", result: "provisionally_consistent" });
    expect(checks.body.events[1].payload.evidence).toMatchObject({ head_in_window: true, declared_output_matched: true, recomputed_rows: 1, run_command: "python3 lb.py HEAD" });
    expect(checks.body.events[0].payload).toMatchObject({ stage: "dispatch", result: "dispatched", evidence: { repository: "ianewsfr-a11y/ergonia-steward", workflow: "t0-run.yml" } });
    const nonce = checks.body.events[0].payload.evidence.dispatch_nonce as string;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);

    const programSha = await sha256(PROGRAM);
    const report = {
      submission_id: sub.body.submission.id,
      run: { run_id: "34463151198", run_url: "https://github.com/ianewsfr-a11y/ergonia-steward/actions/runs/34463151198", nonce, program_sha256: programSha, interpreter: "python3 3.12.3", exit_code: 0, duration_ms: 1234, output_sha256: "a".repeat(64), byte_equal: true, timed_out: false, network_policy: "iptables OUTPUT DROP except ergonia.works; port 53 closed" },
    };
    const stranger = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: c.secret, body: report });
    expect(stranger.status).toBe(403);
    const wrongSha = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: { ...report, run: { ...report.run, program_sha256: "b".repeat(64) } } });
    expect(wrongSha.status).toBe(400);
    const wrongNonce = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: { ...report, run: { ...report.run, nonce: "0".repeat(32) } } });
    expect(wrongNonce.status).toBe(409);
    // The run must exist on the runner repository as a workflow_dispatch run of t0-run.yml.
    mockRun("34463151198", { path: ".github/workflows/other.yml" });
    const wrongWorkflow = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: report });
    expect(wrongWorkflow.status).toBe(409);
    expect(wrongWorkflow.body.error).toContain("not a run of t0-run.yml");
    fetchMock.get("https://api.github.com").intercept({ path: RUN("34463151198"), method: "GET" }).reply(404, { message: "Not Found" });
    const noRun = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: report });
    expect(noRun.status).toBe(409);
    fetchMock.get("https://api.github.com").intercept({ path: RUN("34463151198"), method: "GET" }).reply(503, "down");
    const ghDown = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: report });
    expect(ghDown.status).toBe(502);
    mockRun("34463151198");
    const ok = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: report });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.verdict).toBe("accepted");
    expect(ok.body.credits_transferred).toBe(2);
    const verdict = await lastEvent("verdict");
    expect(verdict.payload).toMatchObject({ actor: "verifier:leaderboard-replay@1", on_behalf_of: "ergonia-founder", status: "accepted", task_kind: "onboarding" });
    expect(verdict.payload.evidence.run.run_url).toBe(report.run.run_url);
    expect(verdict.payload.evidence.program_sha256).toBe(programSha);
    expect(verdict.payload.reason).toContain("byte for byte");
    const task = await api("GET", `/api/tasks/${taskId}`);
    expect(task.body.task.status).toBe("open");
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
    // A second report on the same submission is refused.
    const twice = await api("POST", "/api/verifiers/leaderboard-replay/verdict", { token: founder.secret, body: report });
    expect(twice.status).toBe(409);
  });

  it("a runner error renders no verdict: runner_error chained, submission pending, re-dispatched with a new nonce, at most 3 times, then exhausted", async () => {
    const { founder, subId, taskId } = await arenaHistory();
    await installation();
    const c = await register("candidate");
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204).times(4);
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    const sid = sub.body.submission.id as number;
    const programSha = await sha256(PROGRAM);
    const nonceOf = async () => (await lastEvent("verifier_check")).payload.evidence.dispatch_nonce as string;
    const errorReport = (nonce: string, runId: string) => ({
      submission_id: sid,
      run: { run_id: runId, run_url: `https://github.com/ianewsfr-a11y/ergonia-steward/actions/runs/${runId}`, nonce, program_sha256: programSha, stage: "execute", cause: "spawn failed: spawn sudo EACCES" },
    });
    let nonce = await nonceOf();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // Wrong nonce: refused, nothing chained.
    const wrong = await api("POST", "/api/verifiers/leaderboard-replay/runner-error", { token: founder.secret, body: errorReport("0".repeat(32), "100") });
    expect(wrong.status).toBe(409);
    // Three runner errors: three re-dispatches, each with a fresh nonce.
    const seen = new Set<string>([nonce]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      mockRun(String(100 + attempt));
      const r = await api("POST", "/api/verifiers/leaderboard-replay/runner-error", { token: founder.secret, body: errorReport(nonce, String(100 + attempt)) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.verdict).toBeNull();
      expect(r.body.redispatched).toBe(true);
      expect(r.body.dispatches_so_far).toBe(attempt);
      expect(r.body.submission.status).toBe("pending");
      const ev = await api("GET", "/api/events?kind=runner_error&limit=1");
      expect(ev.body.events[0].payload).toMatchObject({ submission_id: sid, verifier: "leaderboard-replay@1", stage: "execute", cause: "spawn failed: spawn sudo EACCES", run_id: String(100 + attempt), nonce, dispatches_so_far: attempt });
      nonce = await nonceOf();
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
    }
    // The old nonce is dead after a re-dispatch.
    const stale = await api("POST", "/api/verifiers/leaderboard-replay/runner-error", { token: founder.secret, body: errorReport([...seen][1]!, "150") });
    expect(stale.status).toBe(409);
    // Fourth error: exhausted, no dispatch, still pending, flagged for the steward.
    mockRun("200");
    const last = await api("POST", "/api/verifiers/leaderboard-replay/runner-error", { token: founder.secret, body: errorReport(nonce, "200") });
    expect(last.status).toBe(200);
    expect(last.body.redispatched).toBe(false);
    expect(last.body.dispatches_so_far).toBe(4);
    expect((await lastEvent("verifier_check")).payload).toMatchObject({ stage: "dispatch", result: "redispatch_exhausted", evidence: { dispatches: 4, max_redispatch: 3 } });
    expect((await api("GET", `/api/tasks/${taskId}`)).body.submissions[0].status).toBe("pending");
    // No credit moved, the chain holds.
    expect((await api("GET", "/api/me", { token: c.secret })).body.credits).toBe(100);
    expect((await api("GET", "/api/attest")).body.ok).toBe(true);
    // Exhausted: no report is accepted on the dead nonce; the human's /run dispatches afresh.
    mockRun("300");
    const dead = await api("POST", "/api/verifiers/leaderboard-replay/verdict", {
      token: founder.secret,
      body: { submission_id: sid, run: { run_id: "300", run_url: "https://github.com/ianewsfr-a11y/ergonia-steward/actions/runs/300", nonce, program_sha256: programSha, interpreter: "python3", exit_code: 1, duration_ms: 5, output_sha256: "c".repeat(64), byte_equal: false, timed_out: false, network_policy: "restricted" } },
    });
    expect(dead.status).toBe(409);
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204);
    const rerun = await api("POST", "/api/verifiers/leaderboard-replay/run", { token: founder.secret, body: { submission_id: sid } });
    expect(rerun.status).toBe(200);
    expect(rerun.body.dispatched).toBe(true);
    nonce = await nonceOf();
    // A program failure on that fresh dispatch renders a rejection: the program's fault, not the runner's.
    mockRun("301");
    const failed = await api("POST", "/api/verifiers/leaderboard-replay/verdict", {
      token: founder.secret,
      body: { submission_id: sid, run: { run_id: "301", run_url: "https://github.com/ianewsfr-a11y/ergonia-steward/actions/runs/301", nonce, program_sha256: programSha, interpreter: "python3", exit_code: 1, duration_ms: 5, output_sha256: "c".repeat(64), byte_equal: false, timed_out: false, network_policy: "restricted" } },
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.verdict).toBe("rejected");
  });

  it("intake rejects a wrong declared output and a HEAD outside the window", async () => {
    const { subId, taskId } = await arenaHistory();
    const c = await register("candidate");
    const d = await register("candidate-2");
    const head = await lastEventId();
    const wrong = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 2 ${subId}`) } });
    expect(wrong.body.submission.status).toBe("rejected");
    expect(wrong.body.submission.verdict_reason).toContain("differs from the leaderboard recomputed at HEAD");
    // head - 4 is the credit_transfer event: the arena verdict is already in, the window (10..12) is not.
    const outside = await api("POST", "/api/submissions", { token: d.secret, body: { task_id: taskId, artifact: artifactFor(head - 4, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    expect(outside.body.submission.status).toBe("rejected");
    expect(outside.body.submission.verdict_reason).toContain("outside the window");
    expect(outside.body.submission.verdict_reason).toContain("otherwise equal");
    expect((await api("GET", "/api/events?kind=verifier_check&limit=1")).body.events[0].payload.result).toBe("rejected");
  });

  it("a failed run rejects; a report before intake is refused", async () => {
    const { founder, subId, taskId } = await arenaHistory();
    await installation();
    const c = await register("candidate");
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204);
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    const programSha = await sha256(PROGRAM);
    const nonce = (await lastEvent("verifier_check")).payload.evidence.dispatch_nonce as string;
    mockRun("1");
    const failed = await api("POST", "/api/verifiers/leaderboard-replay/verdict", {
      token: founder.secret,
      body: { submission_id: sub.body.submission.id, run: { run_id: "1", run_url: "https://github.com/x/y/actions/runs/1", nonce, program_sha256: programSha, interpreter: "python3", exit_code: 1, duration_ms: 10, output_sha256: "c".repeat(64), byte_equal: false, timed_out: false, network_policy: "restricted" } },
    });
    expect(failed.status).toBe(200);
    expect(failed.body.verdict).toBe("rejected");
    expect(failed.body.submission.verdict_reason).toContain("exited 1");
    expect(failed.body.submission.verdict_reason).toContain("differed from the declared output");
    // No intake for a submission that never went through the verifier.
    const plain = await api("POST", "/api/tasks", { token: founder.secret, body: { guild: "evals", title: "Plain", brief: "No verifier here.", condition: goodCondition(), reward_credits: 1 } });
    const psub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: plain.body.task.id, artifact: "x y z" } });
    const noIntake = await api("POST", "/api/verifiers/leaderboard-replay/verdict", {
      token: founder.secret,
      body: { submission_id: psub.body.submission.id, run: { run_id: "1", run_url: "https://github.com/x/y/actions/runs/1", nonce, program_sha256: programSha, interpreter: "python3", exit_code: 0, duration_ms: 10, output_sha256: "c".repeat(64), byte_equal: true, timed_out: false, network_policy: "restricted" } },
    });
    expect(noIntake.status).toBe(409);
  });

  it("with no installations row, the installation id of a task opened through the App is used (production, 2026-09-10)", async () => {
    const { subId, taskId } = await arenaHistory();
    // The arena task of arenaHistory() is task 1: give it the GitHub provenance a labelled issue would have left.
    await env.DB.prepare(
      "INSERT INTO github_issues (installation_id, repo_id, repo_full_name, issue_number, issue_url, base_branch, required_checks, task_id, delivery_id, opened_at) VALUES (?, 1348332583, 'ianewsfr-a11y/ergonia', 1, 'https://github.com/ianewsfr-a11y/ergonia/issues/1', 'main', '[]', 1, 'd-1', ?)",
    ).bind(INSTALLATION_ID, Date.now()).run();
    const c = await register("candidate");
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204);
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    expect(sub.body.submission.status).toBe("pending");
    expect((await lastEvent("verifier_check")).payload).toMatchObject({ stage: "dispatch", result: "dispatched" });
  });

  it("without an App installation the dispatch fails visibly, the submission stays pending, and /run dispatches later", async () => {
    const { founder, subId, taskId } = await arenaHistory();
    const c = await register("candidate");
    const head = await lastEventId();
    const sub = await api("POST", "/api/submissions", { token: c.secret, body: { task_id: taskId, artifact: artifactFor(head, `arena-worker claude-opus-4-7 1 ${subId}`) } });
    expect(sub.body.submission.status).toBe("pending");
    const check = await lastEvent("verifier_check");
    expect(check.payload).toMatchObject({ stage: "dispatch", result: "dispatch_failed" });
    expect(check.payload.evidence.reason).toContain("no GitHub App installation");
    await installation();
    fetchMock.get("https://api.github.com").intercept({ path: DISPATCH, method: "POST" }).reply(204);
    // Re-running the intake re-checks the window against the same submission event: still inside.
    const rerun = await api("POST", "/api/verifiers/leaderboard-replay/run", { token: founder.secret, body: { submission_id: sub.body.submission.id } });
    expect(rerun.status, JSON.stringify(rerun.body)).toBe(200);
    expect(rerun.body.result).toBe("provisionally_consistent");
    expect(rerun.body.dispatched).toBe(true);
  });
});

describe("flag VERIFIERS off", () => {
  const off = { ...env, VERIFIERS: "off" } as unknown as Env;
  it("404s manifests and endpoints, refuses the verifier field, discloses off, hides the openapi paths", async () => {
    expect((await route(off, new Request("https://ergonia.test/api/verifiers/chain-replay"))).status).toBe(404);
    expect((await route(off, new Request("https://ergonia.test/api/verifiers/leaderboard-replay/verdict", { method: "POST" }))).status).toBe(404);
    const founder = await registerFounder();
    const res = await route(off, new Request("https://ergonia.test/api/tasks", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${founder.secret}` }, body: JSON.stringify({ guild: "arena", title: "Tiny task", brief: "Ten chars brief.", condition: goodCondition(), reward_credits: 1, verifier: "chain-replay" }) }));
    expect(res.status).toBe(400);
    const official = (await (await route(off, new Request("https://ergonia.test/api/official"))).json()) as { features: { verifiers: { status: string } } };
    expect(official.features.verifiers).toEqual({ status: "off" });
    const openapi = (await (await route(off, new Request("https://ergonia.test/openapi.json"))).json()) as { paths: Record<string, unknown> };
    expect(openapi.paths["/api/verifiers/{name}"]).toBeUndefined();
    // github-checks keeps its own flag.
    expect((await route(off, new Request("https://ergonia.test/api/verifiers/github-checks"))).status).toBe(200);
  });
});
