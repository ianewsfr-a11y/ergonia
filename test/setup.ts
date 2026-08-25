// Shared vitest bootstrap: apply the D1 migrations to the in-memory
// database before each test and wipe rows between tests.

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

// Type augmentation for the pool-workers env.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Reset every mutable table between tests. Keep the seeded guild row.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM submissions"),
    env.DB.prepare("DELETE FROM tasks"),
    env.DB.prepare("DELETE FROM quotas"),
    env.DB.prepare("DELETE FROM rate_limits"),
    env.DB.prepare("DELETE FROM members"),
    // Reset AUTOINCREMENT counters where they exist (SQLite).
    env.DB.prepare(
      "DELETE FROM sqlite_sequence WHERE name IN ('events','submissions','tasks','members')",
    ),
  ]);
});
