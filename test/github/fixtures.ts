// Fixtures for the G1 GitHub integration tests: signed webhook
// deliveries against the allowlisted dogfood repository, and fetchMock
// interceptors for the four GitHub API calls the Worker makes.

import { SELF, fetchMock } from "cloudflare:test";

export const WEBHOOK_SECRET = "test-webhook-secret"; // mirrors vitest.config.ts
export const INSTALLATION_ID = 777;
export const REPO = { id: 1348332583, full_name: "ianewsfr-a11y/ergonia", default_branch: "main" } as const;
export const OWNER = { id: 278779481, login: "ianewsfr-a11y", type: "User" } as const;
export const GH = "https://api.github.com";

const encoder = new TextEncoder();

export async function sign(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  let hex = "";
  for (let i = 0; i < sig.length; i++) hex += sig[i]!.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

let deliverySeq = 0;
export function newDelivery(): string {
  deliverySeq += 1;
  return `00000000-0000-4000-8000-${String(deliverySeq).padStart(12, "0")}`;
}

export async function webhook(
  event: string,
  payload: unknown,
  opts: { delivery?: string; signature?: string | null; secret?: string } = {},
): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(payload);
  const signature = opts.signature === undefined ? await sign(raw, opts.secret) : opts.signature;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? newDelivery(),
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  // Raw string body on purpose: the signature is over these exact bytes.
  const res = await SELF.fetch("https://ergonia.test/api/github/webhook", { method: "POST", headers, body: raw });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// ---- payload builders -------------------------------------------------

export function repoObj(over: Partial<{ id: number; full_name: string; default_branch: string }> = {}) {
  return { id: REPO.id, full_name: REPO.full_name, default_branch: REPO.default_branch, ...over };
}

export function issuesPayload(
  action: "labeled" | "unlabeled" | "closed" | "deleted",
  issue: { number: number; title?: string; body?: string; state?: string },
  labelName = "ergonia-bounty",
  repo = repoObj(),
) {
  return {
    action,
    issue: {
      number: issue.number,
      title: issue.title ?? `Issue ${issue.number}`,
      body: issue.body ?? "Steps to reproduce.",
      state: issue.state ?? "open",
      html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    },
    label: { name: labelName },
    repository: repo,
    installation: { id: INSTALLATION_ID },
  };
}

export function pullRequestPayload(action: string, number: number, repo = repoObj()) {
  return { action, pull_request: { number }, repository: repo, installation: { id: INSTALLATION_ID } };
}

export function checkRunPayload(headSha: string, repo = repoObj()) {
  return {
    action: "completed",
    check_run: { head_sha: headSha, name: "test", status: "completed", conclusion: "success" },
    repository: repo,
    installation: { id: INSTALLATION_ID },
  };
}

export function installationPayload(
  action: "created" | "deleted",
  account: { id: number; login: string; type: string } = OWNER,
) {
  return { action, installation: { id: INSTALLATION_ID, account }, repositories: [repoObj()] };
}

// ---- GitHub API mocks ---------------------------------------------------

export function mockGithub() {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(GH)
    .intercept({ path: `/app/installations/${INSTALLATION_ID}/access_tokens`, method: "POST" })
    .reply(201, { token: "ghs_testtoken", expires_at: new Date(Date.now() + 3600_000).toISOString() })
    .persist();
}

export interface CheckRunMock {
  name: string;
  status?: string;
  conclusion?: string | null;
}

export function mockCheckRuns(ref: string, runs: CheckRunMock[], times = 1) {
  const i = fetchMock
    .get(GH)
    .intercept({ path: new RegExp(`^/repos/${REPO.full_name}/commits/${ref}/check-runs(\\?.*)?$`), method: "GET" })
    .reply(200, {
      total_count: runs.length,
      check_runs: runs.map((r) => ({ name: r.name, status: r.status ?? "completed", conclusion: r.conclusion === undefined ? "success" : r.conclusion })),
    });
  if (times > 1) i.times(times);
  return i;
}

export function mockPull(
  number: number,
  over: Partial<{ state: string; merged: boolean; head_sha: string; base_ref: string; base_repo: string; body: string; login: string }> = {},
  times = 1,
) {
  const sha = over.head_sha ?? "a".repeat(40);
  const i = fetchMock
    .get(GH)
    .intercept({ path: `/repos/${REPO.full_name}/pulls/${number}`, method: "GET" })
    .reply(200, {
      number,
      state: over.state ?? "open",
      merged: over.merged ?? false,
      head: { sha, repo: { full_name: REPO.full_name } },
      base: { ref: over.base_ref ?? "main", repo: { full_name: over.base_repo ?? REPO.full_name } },
      body: over.body ?? `Fixes #1`,
      user: { login: over.login ?? "ianewsfr-a11y" },
      html_url: `https://github.com/${REPO.full_name}/pull/${number}`,
    });
  if (times > 1) i.times(times);
  return i;
}

export function mockPullNotFound(number: number) {
  return fetchMock
    .get(GH)
    .intercept({ path: `/repos/${REPO.full_name}/pulls/${number}`, method: "GET" })
    .reply(404, { message: "Not Found" });
}

let commentSeq = 9000;
export function mockComment(issueNumber: number, times = 1) {
  const i = fetchMock
    .get(GH)
    .intercept({ path: `/repos/${REPO.full_name}/issues/${issueNumber}/comments`, method: "POST" })
    .reply(201, () => {
      commentSeq += 1;
      return { id: commentSeq, html_url: `https://github.com/${REPO.full_name}/issues/${issueNumber}#issuecomment-${commentSeq}` };
    });
  if (times > 1) i.times(times);
  return i;
}

export function mockCommentFails(issueNumber: number) {
  return fetchMock
    .get(GH)
    .intercept({ path: `/repos/${REPO.full_name}/issues/${issueNumber}/comments`, method: "POST" })
    .reply(502, { message: "bad gateway" });
}
