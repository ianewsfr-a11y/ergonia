#!/usr/bin/env node
// Post-deploy check, run by `npm run deploy` right after `wrangler deploy`.
//
// Asserts that the deployment serving ergonia.works carries the G1
// integration flag the repository declares (wrangler.toml [vars]
// GITHUB_INTEGRATION = "on"): /api/official.github_integration.status
// must be "house_dogfood". A deploy that silently dropped the flag
// (for example a deploy from a tree where the var was edited away)
// fails here, loudly, instead of switching the integration off without
// anyone noticing.
//
// Override the origin with ERGONIA_URL to check another deployment.

const origin = (process.env.ERGONIA_URL ?? "https://ergonia.works").replace(/\/+$/, "");
const url = `${origin}/api/official`;

async function main() {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    console.error(`check-deploy: could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`check-deploy: ${url} answered HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  const status = body?.github_integration?.status;
  const thirdParty = body?.github_integration?.third_party_enabled;
  if (status !== "house_dogfood") {
    console.error(
      `check-deploy: github_integration.status is ${JSON.stringify(status)} on ${origin}; expected "house_dogfood". ` +
        `The deployed Worker does not carry GITHUB_INTEGRATION=on (see wrangler.toml [vars]).`,
    );
    process.exit(1);
  }
  if (thirdParty !== false) {
    console.error(`check-deploy: github_integration.third_party_enabled is ${JSON.stringify(thirdParty)}; expected false.`);
    process.exit(1);
  }
  console.log(`check-deploy OK: ${origin} github_integration.status = house_dogfood, third_party_enabled = false`);
}

main();
