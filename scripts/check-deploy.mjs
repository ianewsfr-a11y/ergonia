#!/usr/bin/env node
// Post-deploy check, run by `npm run deploy` right after `wrangler deploy`.
//
// Asserts that the deployment serving ergonia.works carries exactly the
// flags the repository declares in wrangler.toml [vars]:
//   - GITHUB_INTEGRATION = "on"  -> /api/official.github_integration.status
//     must be "house_dogfood" and third_party_enabled false;
//   - VERIFIERS, ONBOARDING_TASKS, ARTIFACTS -> /api/official.features.<x>.status
//     must equal the declared value ("on" or "off"), and the routes of an
//     off feature must answer 404 while the manifests of an on feature
//     answer 200.
// A deploy that silently dropped or flipped a flag (for example from a
// tree where a var was edited away) fails here, loudly, instead of
// changing the platform's behaviour without anyone noticing.
//
// Override the origin with ERGONIA_URL to check another deployment.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const origin = (process.env.ERGONIA_URL ?? "https://ergonia.works").replace(/\/+$/, "");
const FEATURE_VARS = ["VERIFIERS", "ONBOARDING_TASKS", "ARTIFACTS"];
const FEATURE_KEYS = { VERIFIERS: "verifiers", ONBOARDING_TASKS: "onboarding_tasks", ARTIFACTS: "artifacts" };

function fail(msg, code = 1) {
  console.error(`check-deploy: ${msg}`);
  process.exit(code);
}

// Minimal TOML read of the [vars] block: `KEY = "value"` lines only.
export function declaredVars(tomlText) {
  const out = {};
  let inVars = false;
  for (const raw of tomlText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars || line.startsWith("#") || line.length === 0) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function get(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    fail(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
}

async function main() {
  const tomlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../wrangler.toml");
  const vars = declaredVars(readFileSync(tomlPath, "utf8"));
  for (const v of ["GITHUB_INTEGRATION", ...FEATURE_VARS]) {
    if (!(v in vars)) fail(`wrangler.toml [vars] does not declare ${v}; every flag must be explicit`);
  }

  const official = await get(`${origin}/api/official`);
  if (official.status !== 200) fail(`${origin}/api/official answered HTTP ${official.status}`);
  const body = official.body ?? {};

  const status = body?.github_integration?.status;
  const thirdParty = body?.github_integration?.third_party_enabled;
  if (vars.GITHUB_INTEGRATION === "on") {
    if (status !== "house_dogfood") {
      fail(`github_integration.status is ${JSON.stringify(status)} on ${origin}; expected "house_dogfood". The deployed Worker does not carry GITHUB_INTEGRATION=on (see wrangler.toml [vars]).`);
    }
    if (thirdParty !== false) fail(`github_integration.third_party_enabled is ${JSON.stringify(thirdParty)}; expected false.`);
  } else if (body.github_integration !== undefined) {
    fail(`github_integration is disclosed on ${origin} while wrangler.toml declares GITHUB_INTEGRATION=${JSON.stringify(vars.GITHUB_INTEGRATION)}`);
  }

  const features = body.features;
  if (!features || typeof features !== "object") fail(`/api/official carries no features block on ${origin}`);
  const summary = [];
  for (const v of FEATURE_VARS) {
    const expected = vars[v] === "on" ? "on" : "off";
    const key = FEATURE_KEYS[v];
    const got = features[key]?.status;
    if (got !== expected) fail(`features.${key}.status is ${JSON.stringify(got)} on ${origin}; wrangler.toml declares ${v}=${JSON.stringify(vars[v])} (expected ${JSON.stringify(expected)})`);
    summary.push(`${key}=${got}`);
  }

  // Route-level assertions, so "off" means unreachable and "on" means served.
  const probes = [
    { feature: "verifiers", url: `${origin}/api/verifiers/chain-replay`, onStatus: 200 },
    { feature: "verifiers", url: `${origin}/api/verifiers/leaderboard-replay`, onStatus: 200 },
    { feature: "artifacts", url: `${origin}/a/${"0".repeat(64)}`, onStatus: 404, onIsAlso404: true },
  ];
  for (const p of probes) {
    const r = await get(p.url);
    const on = features[p.feature]?.status === "on";
    if (!on && r.status !== 404) fail(`${p.url} answered HTTP ${r.status} while features.${p.feature} is off; expected 404`);
    if (on && !p.onIsAlso404 && r.status !== p.onStatus) fail(`${p.url} answered HTTP ${r.status} while features.${p.feature} is on; expected ${p.onStatus}`);
    if (on && p.onIsAlso404 && r.status !== 404) fail(`${p.url} answered HTTP ${r.status}; expected 404 for an unknown artifact`);
  }
  if (features.verifiers?.status === "on") {
    for (const url of [`${origin}/api/verifiers/chain-replay`, `${origin}/api/verifiers/leaderboard-replay`]) {
      const r = await get(url);
      if (r.body?.third_party_enabled !== false) fail(`${url} does not report third_party_enabled=false`);
    }
  }

  const gh = vars.GITHUB_INTEGRATION === "on" ? "github_integration.status = house_dogfood, third_party_enabled = false; " : "";
  console.log(`check-deploy OK: ${origin} ${gh}features: ${summary.join(", ")} (as declared in wrangler.toml)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
