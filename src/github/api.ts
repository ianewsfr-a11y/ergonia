// The four GitHub REST calls G1 makes, and nothing else:
//   GET  /repos/{repo}/pulls/{n}                  resolve a pull request
//   GET  /repos/{repo}/commits/{ref}/check-runs   list check runs on a commit or branch
//   POST /repos/{repo}/issues/{n}/comments        post an Ergonia status comment
// (the installation-token exchange lives in app-auth.ts).
//
// No Contents permission is requested by the App, and no call here
// reads repository files. Responses are parsed into the few fields the
// verifier uses; the raw check-run response is kept verbatim in
// github_check_snapshots for audit.

import type { Env } from "../types.js";
import { GITHUB_API_VERSION, USER_AGENT, githubApiBase } from "./config.js";

export class GithubApiError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    super(`GitHub API ${what} responded HTTP ${status}`);
    this.status = status;
  }
}

async function ghFetch(
  env: Env,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${githubApiBase(env)}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": GITHUB_API_VERSION,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export interface PullRequestView {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head_sha: string;
  base_ref: string;
  base_repo_full_name: string;
  head_repo_full_name: string | null;
  body: string;
  author_login: string;
  html_url: string;
}

export async function getPullRequest(
  env: Env,
  token: string,
  repoFullName: string,
  number: number,
): Promise<PullRequestView> {
  const { status, json } = await ghFetch(env, token, "GET", `/repos/${repoFullName}/pulls/${number}`);
  if (status !== 200) throw new GithubApiError(status, `GET pulls/${number}`);
  const o = (json ?? {}) as Record<string, unknown>;
  const head = (o.head ?? {}) as Record<string, unknown>;
  const base = (o.base ?? {}) as Record<string, unknown>;
  const baseRepo = (base.repo ?? {}) as Record<string, unknown>;
  const headRepo = (head.repo ?? null) as Record<string, unknown> | null;
  const user = (o.user ?? {}) as Record<string, unknown>;
  return {
    number: Number(o.number),
    state: o.state === "open" ? "open" : "closed",
    merged: o.merged === true,
    head_sha: String(head.sha ?? ""),
    base_ref: String(base.ref ?? ""),
    base_repo_full_name: String(baseRepo.full_name ?? ""),
    head_repo_full_name: headRepo ? String(headRepo.full_name ?? "") : null,
    body: typeof o.body === "string" ? o.body : "",
    author_login: String(user.login ?? ""),
    html_url: String(o.html_url ?? ""),
  };
}

export interface CheckRunView {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CheckRunsView {
  total_count: number;
  check_runs: CheckRunView[];
  raw_json: string;
}

export async function listCheckRuns(
  env: Env,
  token: string,
  repoFullName: string,
  ref: string,
): Promise<CheckRunsView> {
  const { status, json } = await ghFetch(
    env,
    token,
    "GET",
    `/repos/${repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  );
  if (status !== 200) throw new GithubApiError(status, `GET commits/${ref}/check-runs`);
  const o = (json ?? {}) as Record<string, unknown>;
  const runs = Array.isArray(o.check_runs) ? (o.check_runs as Record<string, unknown>[]) : [];
  return {
    total_count: Number(o.total_count ?? runs.length),
    check_runs: runs.map((r) => ({
      name: String(r.name ?? ""),
      status: String(r.status ?? ""),
      conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
    })),
    raw_json: JSON.stringify(json ?? {}),
  };
}

export interface PostedComment {
  id: number;
  html_url: string;
}

export async function postIssueComment(
  env: Env,
  token: string,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<PostedComment> {
  const { status, json } = await ghFetch(
    env,
    token,
    "POST",
    `/repos/${repoFullName}/issues/${issueNumber}/comments`,
    { body },
  );
  if (status !== 201) throw new GithubApiError(status, `POST issues/${issueNumber}/comments`);
  const o = (json ?? {}) as Record<string, unknown>;
  return { id: Number(o.id ?? 0), html_url: String(o.html_url ?? "") };
}
