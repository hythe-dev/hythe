/**
 * CLI contract — the npx install path (Phase-1 second-user readiness).
 *
 * Proves the package's selected `bin` claims: legacy engram-mcp or HYTHE
 * hythe-mcp --help / init / default
 * bridge delegation, .env write-once safety, and that the publish payload
 * actually carries the bin + bridge. The bridge's live HTTP round-trip is
 * covered by internal/final-tree-smoke.mjs; this suite covers the CLI
 * surface an outsider touches first.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'bin', 'engram-mcp.cjs');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const isHytheDistribution = pkg.hytheDistribution === true;
const cliName = isHytheDistribution ? 'hythe-mcp' : 'engram-mcp';
const serverKey = isHytheDistribution ? 'hythe' : 'engram';

const run = (args: string[], opts: Record<string, unknown> = {}) =>
  spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 15000, ...opts });

describe('package-selected CLI (bin install path)', () => {
  it('package.json maps the selected single bin to an existing entrypoint and ships bin + bridge', () => {
    expect(pkg.bin).toEqual({ [cliName]: 'bin/engram-mcp.cjs' });
    expect(existsSync(CLI)).toBe(true);
    expect(pkg.files).toContain('bin/');
    expect(pkg.files).toContain('mcp-stdio-http-bridge.cjs');
    expect(pkg.files).toContain('dist/');
  });

  it('--help exits 0 and documents both modes', () => {
    const res = run(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/stdio bridge/);
    expect(res.stdout).toContain(`${cliName} init`);
  });

  it('unknown commands fail loudly (exit 2), never silently fall through to the bridge', () => {
    const res = run(['frobnicate']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown command 'frobnicate'/);
  });

  it('init prints a fresh 32-byte API key and paste-ready config for all four documented clients', () => {
    const res = run(['init']);
    expect(res.status).toBe(0);
    const keyMatch = res.stdout.match(/API_KEY=([A-Za-z0-9+/=]+)/);
    expect(keyMatch, 'generated API key missing').toBeTruthy();
    expect(Buffer.from(keyMatch![1], 'base64').length).toBe(32);
    for (const client of ['Claude Code', 'Codex', 'Cursor', 'Claude Desktop']) {
      expect(res.stdout).toContain(client);
    }
    // The JSON block is real, parseable config — extract the Cursor section.
    const lines = res.stdout.split('\n');
    const start = lines.findIndex((l) => l.includes('Cursor (.cursor/mcp.json)'));
    const end = lines.findIndex((l, i) => i > start && l.startsWith('───'));
    expect(start).toBeGreaterThan(-1);
    const block = JSON.parse(lines.slice(start + 1, end).join('\n').trim());
    expect(block.mcpServers[serverKey].command).toBe('npx');
    expect(block.mcpServers[serverKey].args).toEqual(['-y', pkg.name]);
    expect(block.mcpServers[serverKey].env.API_KEY).toBe(keyMatch![1]);
    // Two runs never reuse a key.
    const res2 = run(['init']);
    expect(res2.stdout.match(/API_KEY=([A-Za-z0-9+/=]+)/)![1]).not.toBe(keyMatch![1]);
  });

  it('init --write-env writes ./.env mode 600 once and REFUSES to overwrite (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-'));
    try {
      const first = run(['init', '--write-env'], { cwd: dir });
      expect(first.status).toBe(0);
      const envPath = join(dir, '.env');
      const written = readFileSync(envPath, 'utf8');
      const key = first.stdout.match(/API_KEY=([A-Za-z0-9+/=]+)/)![1];
      expect(written).toContain(`API_KEY=${key}`);
      expect(statSync(envPath).mode & 0o777).toBe(0o600);

      const second = run(['init', '--write-env'], { cwd: dir });
      expect(second.status).toBe(1);
      expect(second.stderr).toMatch(/refusing to overwrite/);
      expect(readFileSync(envPath, 'utf8')).toBe(written); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('demo subcommand seeds the two-agent story end-to-end against a live server (checkpoint → message → resume)', async () => {
    const base = new URL(process.env.NEURAL_URL || 'http://localhost:6399');
    const apiKey = process.env.NEURAL_API_KEY || '';
    expect(apiKey, 'hermetic server API key missing').toBeTruthy();
    const res = run(['demo'], {
      env: { ...process.env, API_KEY: apiKey, MCP_HOST: base.hostname, MCP_PORT: base.port },
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Demo seeded');
    expect(res.stdout).toMatch(/demo-bob resumed the scope|resumed the scope and read/);

    // Verify against the server, not the CLI's own claims: demo-bob can
    // resume the seeded scope and sees alice's state.
    const reply = await fetch(`${base.origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'resume', arguments: { agentId: 'demo-bob', scope: { project: 'demo-fleet-project' }, budget: 4000 } },
      }),
    });
    const json = await reply.json();
    const bundle = JSON.parse(json.result.content[0].text);
    expect(bundle.working.owner).toBe('demo-alice');
    expect(bundle.working.status).toBe('green');
  });

  it('demo without API_KEY fails closed with a clear message', () => {
    const env = { ...process.env };
    delete (env as Record<string, unknown>).API_KEY;
    const res = run(['demo'], { env });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/API_KEY env var is required/);
  });

  it('server CORS is closed-safe by default: a cross-origin browser request gets no allow-origin grant', async () => {
    const base = new URL(process.env.NEURAL_URL || 'http://localhost:6399');
    const res = await fetch(`${base.origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.NEURAL_API_KEY || '',
        Origin: 'http://attacker.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('default mode hands the process to the stdio bridge (stays alive on stdin, exits on stdin close)', async () => {
    const child = spawn('node', [CLI], {
      env: { ...process.env, MCP_HOST: '127.0.0.1', MCP_PORT: '1' },
      stdio: 'pipe',
    });
    const exited = new Promise<number | null>((resolveExit) => child.on('exit', (c) => resolveExit(c)));
    // Bridge mode waits on stdin — still alive after a beat proves delegation.
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    await exited;
  });
});
