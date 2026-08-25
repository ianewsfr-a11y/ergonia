import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "./migrations"));
  return {
    test: {
      setupFiles: ["./test/setup.ts"],
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
            },
          },
        },
      },
    },
  };
});
