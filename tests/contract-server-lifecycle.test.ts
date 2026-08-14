import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sloMonitor } from '../src/observability/index.js';
import {
  HYTHE_SERVICE_NAME,
  HYTHE_VERSION,
  NeuralMCPServer,
} from '../src/unified-neural-mcp-server.js';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = `lifecycle-test-${'a'.repeat(40)}`;

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before health check (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup has not opened the listener yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('server did not become healthy before timeout');
}

describe.sequential('server lifecycle and release metadata', () => {
  const originalEnv = { ...process.env };
  let server: NeuralMCPServer | undefined;
  let child: ChildProcess | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    child = undefined;
    await server?.close();
    server = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    process.env = { ...originalEnv };
  });

  it('derives every advertised server version from package metadata', async () => {
    process.env = { ...originalEnv, API_KEY, ENABLE_ADVANCED_MEMORY: 'false' };
    server = new NeuralMCPServer(0, ':memory:');
    const app = server.getExpressApp();

    expect(HYTHE_VERSION).toBe(packageMetadata.version);
    const health = await supertest(app).get('/health').expect(200);
    expect(health.body).toMatchObject({
      service: HYTHE_SERVICE_NAME,
      version: packageMetadata.version,
      lifecycle: 'initialized',
    });

    const ready = await supertest(app).get('/ready').expect(503);
    expect(ready.body).toMatchObject({
      ready: false,
      degraded: true,
      version: packageMetadata.version,
      lifecycle: 'initialized',
    });

    const initialized = await supertest(app)
      .post('/mcp')
      .set('X-API-Key', API_KEY)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      .expect(200);
    expect(initialized.body.result.serverInfo.version).toBe(packageMetadata.version);
    expect(initialized.body.result.serverInfo.name).toBe(HYTHE_SERVICE_NAME);

    const status = await supertest(app)
      .get('/system/status')
      .set('X-API-Key', API_KEY)
      .expect(200);
    expect(status.body.version).toBe(packageMetadata.version);
    expect(status.body.service).toBe(HYTHE_SERVICE_NAME);

    const firstClose = server.close();
    const repeatedClose = server.close();
    expect(repeatedClose).toBe(firstClose);
    await firstClose;
    await expect(server.start()).rejects.toThrow(/closing or closed/);
    server = undefined;
  });

  it('treats active critical SLO alerts as degraded after lifecycle readiness', async () => {
    process.env = { ...originalEnv, API_KEY, ENABLE_ADVANCED_MEMORY: 'false' };
    server = new NeuralMCPServer(0, ':memory:');
    (server as any).lifecycleState = 'ready';
    vi.spyOn(server.getMemoryManager(), 'getSystemStatus').mockResolvedValue({
      sqlite: { connected: true },
      vector: { connected: true },
      weaviate: { connected: true },
      advancedSystemsEnabled: true,
    } as any);
    vi.spyOn(sloMonitor, 'getActiveAlerts').mockReturnValue([
      { severity: 'critical' } as any,
    ]);

    const ready = await supertest(server.getExpressApp()).get('/ready').expect(207);
    expect(ready.body).toMatchObject({
      ready: true,
      degraded: true,
      lifecycle: 'ready',
      criticalAlerts: 1,
    });
  });

  it('handles SIGTERM once, drains both listeners, and exits zero', async () => {
    const httpPort = await getFreePort();
    let hubPort = await getFreePort();
    while (hubPort === httpPort) hubPort = await getFreePort();
    tempDir = mkdtempSync(join(tmpdir(), 'hythe-lifecycle-'));
    const dbPath = join(tempDir, 'lifecycle.db');
    let output = '';

    child = spawn(process.execPath, ['--import', 'tsx', 'src/unified-neural-mcp-server.ts'], {
      cwd: REPO,
      env: {
        ...originalEnv,
        API_KEY,
        ENABLE_ADVANCED_MEMORY: 'false',
        NEURAL_DB_PATH: dbPath,
        NEURAL_MCP_PORT: String(httpPort),
        MESSAGE_HUB_PORT: String(hubPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

    await waitForHealth(httpPort, child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timeout = setTimeout(() => reject(new Error(`shutdown timed out:\n${output}`)), 5_000);
      child!.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    });
    child.kill('SIGTERM');
    // A second signal must not begin a second teardown sequence.
    child.kill('SIGINT');

    const result = await exited;

    expect(result).toEqual({ code: 0, signal: null });
    expect(output.match(/received; draining HYTHE/g)).toHaveLength(1);
    expect(output).toContain('HYTHE shutdown complete');
  }, 15_000);

  it('keeps Docker health promotion stricter than liveness', () => {
    const dockerfile = readFileSync(join(REPO, 'docker/Dockerfile'), 'utf8');
    const compose = readFileSync(join(REPO, 'docker/pavilion-production.compose.yml'), 'utf8');
    for (const deployment of [dockerfile, compose]) {
      expect(deployment).toContain("fetch('http://localhost:6174/ready')");
      expect(deployment).toContain('r.status===200&&b.ready===true&&b.degraded===false');
    }
  });
});
