/**
 * Vitest global setup — hermetic test server.
 *
 * Boots an isolated Neural MCP server on an ephemeral port with a throwaway
 * DB and test-friendly env, so `npm test` is self-contained and never touches
 * a developer's live :6174 instance or real data. Sets NEURAL_URL /
 * NEURAL_API_KEY for the contract tests, and tears the server + temp DB down
 * afterward.
 *
 * Escape hatch: if NEURAL_URL is already set, we skip booting and run against
 * that server (for CI or manual runs against a specific deployment).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_API_KEY = 'test-api-key-' + 'a'.repeat(32);

export default async function setup(): Promise<() => Promise<void>> {
  // Respect an externally-provided server (CI/manual). No-op teardown.
  if (process.env.NEURAL_URL) {
    console.log(`[test] Using external server at ${process.env.NEURAL_URL}`);
    return async () => {};
  }

  const port = Number(process.env.NEURAL_TEST_PORT || 6399);
  const hubPort = Number(process.env.NEURAL_TEST_HUB_PORT || 3399);
  const tmpDir = mkdtempSync(join(tmpdir(), 'neural-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const baseUrl = `http://localhost:${port}`;

  const child: ChildProcess = spawn('npx', ['tsx', 'src/unified-neural-mcp-server.ts'], {
    cwd: process.cwd(),
    // detached so the child leads its own process group — tsx forks a
    // grandchild node process (the real server), and we must signal the whole
    // group on teardown or it orphans.
    detached: true,
    env: {
      ...process.env,
      NEURAL_MCP_PORT: String(port),
      MESSAGE_HUB_PORT: String(hubPort),
      NEURAL_DB_PATH: dbPath,
      API_KEY: TEST_API_KEY,
      // Test-friendly: high limits + admin/data/legacy-mutation surfaces the
      // contract suite exercises. None of these are production defaults.
      GENERAL_RATE_LIMIT_POINTS: '1000000',
      MESSAGE_RATE_LIMIT_POINTS: '1000000',
      ENABLE_ADMIN_ENDPOINTS: '1',
      ENABLE_DATA_MANAGEMENT: '1',
      ALLOW_LEGACY_GRAPH_MUTATIONS: '1',
      NODE_ENV: 'test',
    },
    // Hide the (very chatty) startup stdout; surface real errors via stderr.
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  // Wait for the server to report healthy.
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!healthy) {
    child.kill('SIGKILL');
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`[test] Neural MCP server did not become healthy on ${baseUrl} within 30s`);
  }

  process.env.NEURAL_URL = baseUrl;
  process.env.NEURAL_API_KEY = TEST_API_KEY;
  console.log(`[test] Hermetic server ready at ${baseUrl} (db: ${dbPath})`);

  return async () => {
    // Signal the whole process group (negative PID) so the tsx grandchild
    // server is killed too, not just the npx parent.
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };
}
