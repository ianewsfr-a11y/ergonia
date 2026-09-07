// Local MCP entrypoint for Glama's inspection container.
// External requirement: punkpeye requested local evaluation in PR #12999.
// Reuses the real Worker and migrations; never forwards to a hosted endpoint.
// Tooling is resolved from the existing, lockfile-pinned Wrangler installation.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

// Dependencies may emit startup diagnostics; stdout is reserved for JSON-RPC.
console.log = console.error.bind(console);
console.info = console.error.bind(console);
process.env.WRANGLER_SEND_METRICS = 'false';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { build } = wranglerRequire('esbuild');
const { Miniflare, Log, LogLevel } = wranglerRequire('miniflare');
const { unstable_splitSqlQuery } = require('wrangler');
let runtime;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await runtime?.dispose();
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.stdout.on('error', () => void stop(1));

try {
  const bundle = await build({
    absWorkingDir: root, entryPoints: ['src/index.ts'], bundle: true,
    write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  });
  runtime = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-01-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], d1Persist: false,
    bindings: { GITHUB_INTEGRATION: 'off' },
    // Deny outgoing network calls, even if a future Worker change adds one.
    outboundService: () => new Response('Network disabled in local inspection', { status: 403 }),
    log: new Log(LogLevel.ERROR),
  });
  const db = await runtime.getD1Database('DB');
  const migrationsDir = resolve(root, 'migrations');
  for (const name of (await readdir(migrationsDir)).filter(n => n.endsWith('.sql')).sort()) {
    const queries = unstable_splitSqlQuery(await readFile(resolve(migrationsDir, name), 'utf8'));
    if (queries.length) await db.batch(queries.map(sql => db.prepare(sql)));
  }
  console.error('Ergonia local MCP ready. Temporary D1; outbound network disabled.');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    // dispatchFetch invokes the local Worker, not the network. Preserve the
    // existing full MCP registry, argument validation and authorization rules.
    const response = await runtime.dispatchFetch('http://localhost/mcp', {
      method: 'POST', headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }, body: line,
    });
    if (response.status === 202 || response.status === 204) continue;
    if (!response.ok) throw new Error(`Local Worker returned HTTP ${response.status}`);
    const output = JSON.stringify(await response.json()) + '\n';
    if (!process.stdout.write(output)) await once(process.stdout, 'drain');
  }
  await stop();
} catch (error) {
  console.error('Local MCP failed:', error instanceof Error ? error.message : String(error));
  await stop(1);
}
