import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "./migrations"));
  // A throwaway RSA key for the GitHub App JWT path under test. Generated
  // per run, never written anywhere. Exported as PKCS#1 on purpose: that
  // is the format GitHub hands out, and the wrapper in app-auth.ts is
  // exercised by it.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const testAppKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      // The 20/day comment loop sits near the 5 s default on a loaded
      // machine (seen 2026-09-10 at 5013 ms in the full suite, 478 ms alone).
      testTimeout: 20_000,
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            compatibilityDate: "2025-01-15",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Enables /api/admin/* for the suite only. Production leaves
              // this unset so those routes 404. Test-only value; the real
              // one, if ever needed, comes from `wrangler secret put`.
              ADMIN_GRANT_SECRET: "test-admin-secret",
              // G1 GitHub integration under test. Test-only values; the
              // real ones come from `wrangler secret put`.
              GITHUB_INTEGRATION: "on",
              GITHUB_APP_ID: "424242",
              GITHUB_APP_PRIVATE_KEY: testAppKeyPem,
              GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
              // 2026-09-10 features, on under test; production declares
              // them in wrangler.toml [vars] and check-deploy asserts them.
              VERIFIERS: "on",
              ONBOARDING_TASKS: "on",
              ARTIFACTS: "on",
              T0_RUNNER_REPO: "ianewsfr-a11y/ergonia-steward",
              T0_RUNNER_WORKFLOW: "t0-run.yml",
            },
          },
        },
      },
    },
  };
});
