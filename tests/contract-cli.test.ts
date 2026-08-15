/**
 * CLI contract — the npx install path (Phase-1 second-user readiness).
 *
 * Proves the package's selected `bin` claims: legacy engram-mcp or HYTHE
 * hythe-mcp --help / init / default
 * bridge delegation, .env write-once safety, and that the publish payload
 * actually carries the bin + bridge. The bridge's live HTTP round-trip is
 * covered by internal/final-tree-smoke.mjs; this suite covers the CLI
 * surface an outsider touches first. Live bridge HTTP round-trips run against
 * the hermetic server here; ENG4 resource transport is covered by
 * contract-mcp-resources-http.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'bin', 'engram-mcp.cjs');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const isHytheDistribution = pkg.hytheDistribution === true;
const cliName = isHytheDistribution ? 'hythe-mcp' : 'engram-mcp';
const serverKey = isHytheDistribution ? 'hythe' : 'engram';
const keyFileEnv = isHytheDistribution ? 'HYTHE_API_KEY_FILE' : 'ENGRAM_API_KEY_FILE';
const agentIdEnv = isHytheDistribution ? 'HYTHE_AGENT_ID' : 'ENGRAM_AGENT_ID';
const testAgentId = 'codex-public-client';
const packageSpec = `${pkg.name}@${pkg.version}`;

const run = (args: string[], opts: Record<string, unknown> = {}) =>
  spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 15000, ...opts });

const containsCredentialShapedToken = (text: string) =>
  text.split(/[^A-Za-z0-9+/=]+/).some((token) =>
    /^[A-Fa-f0-9]{32,}$/.test(token)
    || (token.length >= 43 && /^[A-Za-z0-9+/]+={0,2}$/.test(token))
  );

describe('package-selected CLI (bin install path)', () => {
  it('package.json maps the client and operator bins to shipped entrypoints', () => {
    expect(pkg.bin).toEqual({
      [cliName]: 'bin/engram-mcp.cjs',
      'hythe-agent-auth': 'dist/agent-auth/operator.js',
    });
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
    expect(res.stdout).toContain('--agent-id <agent-id>');
  });

  it('unknown commands fail loudly (exit 2), never silently fall through to the bridge', () => {
    const res = run(['frobnicate']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/unknown command 'frobnicate'/);
  });

  it('init without --write-env emits identity-bound, secret-free config for all four clients', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-'));
    try {
      const res = run(['init', '--agent-id', testAgentId], { cwd: dir });
      const envPath = join(dir, '.env');
      expect(res.status).toBe(0);
      expect(existsSync(envPath)).toBe(false);
      expect(res.stdout.includes(envPath)).toBe(true);
      expect(/No credential file (?:was )?written/.test(res.stdout)).toBe(true);
      expect(containsCredentialShapedToken(res.stdout)).toBe(false);
      for (const client of ['Claude Code', 'Codex', 'Cursor', 'Claude Desktop']) {
        expect(res.stdout.includes(client)).toBe(true);
      }

      // The JSON block is real, parseable config — extract the Cursor section.
      const lines = res.stdout.split('\n');
      const start = lines.findIndex((l) => l.includes('Cursor (.cursor/mcp.json)'));
      const end = lines.findIndex((l, i) => i > start && l.startsWith('───'));
      expect(start).toBeGreaterThan(-1);
      const block = JSON.parse(lines.slice(start + 1, end).join('\n').trim());
      expect(block.mcpServers[serverKey].command).toBe('npx');
      expect(block.mcpServers[serverKey].args).toEqual(['-y', packageSpec]);
      const clientEnv = block.mcpServers[serverKey].env;
      expect(Object.keys(clientEnv).sort()).toEqual([keyFileEnv, agentIdEnv, 'MCP_HOST', 'MCP_PORT'].sort());
      expect(clientEnv[keyFileEnv] === envPath).toBe(true);
      expect(clientEnv[agentIdEnv]).toBe(testAgentId);
      expect(clientEnv.MCP_HOST === '127.0.0.1').toBe(true);
      expect(clientEnv.MCP_PORT === '6174').toBe(true);
      expect(Object.hasOwn(clientEnv, 'API_KEY')).toBe(false);
      expect(res.stdout).toContain(`--env ${agentIdEnv}='${testAgentId}'`);
      expect(res.stdout).toContain(`${agentIdEnv} = "${testAgentId}"`);
      expect(res.stdout).toContain('Claude plugin hooks are separate child processes');
      expect(res.stdout).toContain(`${agentIdEnv}='${testAgentId}' claude`);
      expect(res.stdout).toContain(`--branch v${pkg.version}`);
      expect(res.stdout).toContain('server source is not bundled');
      expect(res.stdout).not.toContain('Start the server:  docker compose');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init rejects unknown, stray, duplicate flag, and typo arguments without creating files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-unknown-'));
    try {
      const cases = [
        ['--agent-auth-mod', 'required'],
        ['stray-positional'],
        ['--write-env', '--write-env'],
      ];
      for (const extra of cases) {
        const res = run(['init', '--agent-id', testAgentId, ...extra], { cwd: dir });
        expect(res.status, extra.join(' ')).toBe(2);
        expect(res.stderr).toMatch(/unknown|stray|specified only once/i);
        expect(existsSync(join(dir, '.env'))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts Docker only from the exact matching server checkout and rejects stale lookalikes', () => {
    const matching = run(['init', '--agent-id', testAgentId], { cwd: REPO });
    expect(matching.status).toBe(0);
    expect(matching.stdout).toContain('Start the server:  docker compose');
    expect(matching.stdout).not.toContain('not an exact HYTHE');

    const stale = mkdtempSync(join(tmpdir(), 'hythe-stale-checkout-'));
    try {
      mkdirSync(join(stale, 'src'));
      mkdirSync(join(stale, 'docker'));
      writeFileSync(join(stale, 'tsconfig.json'), '{}\n');
      writeFileSync(join(stale, 'docker', 'Dockerfile'), 'FROM scratch\n');
      writeFileSync(join(stale, 'docker', 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(join(stale, 'package.json'), JSON.stringify({
        name: pkg.name,
        version: '0.1.4',
        hytheDistribution: true,
      }));
      writeFileSync(join(stale, 'package-lock.json'), JSON.stringify({
        name: pkg.name,
        version: '0.1.4',
        packages: { '': { version: '0.1.4' } },
      }));

      const result = run(['init', '--agent-id', testAgentId], { cwd: stale });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`not an exact HYTHE v${pkg.version}`);
      expect(result.stdout).toContain(`--branch v${pkg.version}`);
      expect(result.stdout).not.toContain('Start the server:  docker compose');
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
  });

  it('init requires one valid --agent-id and rejects missing, invalid, or duplicate values', () => {
    const cases = [
      { args: ['init'], error: /--agent-id.*required/i },
      { args: ['init', '--agent-id'], error: /--agent-id.*value/i },
      { args: ['init', '--agent-id', '   '], error: /--agent-id.*1.*100/i },
      { args: ['init', '--agent-id', 'agent/other'], error: /--agent-id.*1.*100/i },
      { args: ['init', '--agent-id', 'agent\nsmuggled'], error: /--agent-id.*1.*100/i },
      { args: ['init', '--agent-id', 'a'.repeat(101)], error: /--agent-id.*1.*100/i },
      { args: ['init', '--agent-id', 'agent-a', '--agent-id', 'agent-b'], error: /--agent-id.*once/i },
    ];
    for (const testCase of cases) {
      const res = run(testCase.args);
      expect(res.status, testCase.args.join(' ')).toBe(2);
      expect(res.stderr).toMatch(testCase.error);
    }
  });

  it('init --write-env writes ./.env mode 600 once and REFUSES to overwrite (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-'));
    try {
      const first = run(['init', '--write-env', '--agent-id', testAgentId], { cwd: dir });
      expect(first.status).toBe(0);
      const envPath = join(dir, '.env');
      const written = readFileSync(envPath, 'utf8');
      const key = written.match(/^API_KEY=([A-Za-z0-9+/=]+)$/m)?.[1];
      expect(key, 'generated API key missing from protected .env').toBeTruthy();
      expect(Buffer.from(key!, 'base64').length).toBe(32);
      expect(first.stdout.includes(key!)).toBe(false);
      expect(containsCredentialShapedToken(first.stdout)).toBe(false);
      expect(first.stdout.includes(envPath)).toBe(true);
      expect(statSync(envPath).mode & 0o777).toBe(0o600);

      const second = run(['init', '--write-env', '--agent-id', testAgentId], { cwd: dir });
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
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-key-file-'));
    try {
      const keyFile = join(dir, '.env');
      writeFileSync(keyFile, `API_KEY=${apiKey}\n`, { mode: 0o600 });
      const env = {
        ...process.env,
        [keyFileEnv]: keyFile,
        MCP_HOST: base.hostname,
        MCP_PORT: base.port,
      };
      delete env.API_KEY;
      const res = run(['demo'], { env });
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Demo seeded');
      expect(res.stdout).toMatch(/demo-bob resumed the scope|resumed the scope and read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

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
    delete (env as Record<string, unknown>).HYTHE_API_KEY_FILE;
    delete (env as Record<string, unknown>).ENGRAM_API_KEY_FILE;
    const res = run(['demo'], { env });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/API_KEY env var is required/);
  });

  it('credential-file loading rejects group/world-readable files without echoing their contents', () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-key-mode-'));
    try {
      const keyFile = join(dir, '.env');
      const marker = 'credential-that-must-not-appear-in-errors';
      writeFileSync(keyFile, `API_KEY=${marker}\n`, { mode: 0o644 });
      const env = { ...process.env, [keyFileEnv]: keyFile };
      delete env.API_KEY;
      const res = run(['demo'], { env });
      expect(res.status).toBe(2);
      expect(/mode-400 or mode-600/.test(res.stderr)).toBe(true);
      expect(res.stderr.includes(marker)).toBe(false);
      expect(res.stdout.includes(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('default bridge authenticates from a protected key file while direct API_KEY remains compatible', () => {
    const base = new URL(process.env.NEURAL_URL || 'http://localhost:6399');
    const apiKey = process.env.NEURAL_API_KEY || '';
    expect(apiKey, 'hermetic server API key missing').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'engram-cli-bridge-key-'));
    try {
      const keyFile = join(dir, '.env');
      writeFileSync(keyFile, `API_KEY=${apiKey}\n`, { mode: 0o600 });
      const request = JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} }) + '\n';
      const environments = [
        { API_KEY: apiKey },
        { [keyFileEnv]: keyFile },
      ];

      for (const credentialEnv of environments) {
        const env = {
          ...process.env,
          [agentIdEnv]: testAgentId,
          MCP_HOST: base.hostname,
          MCP_PORT: base.port,
          MCP_BRIDGE_STATE_DIR: dir,
          ...credentialEnv,
        };
        if (!(Object.hasOwn(credentialEnv, 'API_KEY'))) delete env.API_KEY;
        if (!(Object.hasOwn(credentialEnv, keyFileEnv))) delete env[keyFileEnv];
        const res = run([], { env, input: request });
        const response = res.stdout.split('\n').filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((item) => item.id === 41);
        expect(res.status).toBe(0);
        expect(response !== undefined).toBe(true);
        expect(Array.isArray(response?.result?.tools)).toBe(true);
        expect(response?.error === undefined).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default mode hands the process to the stdio bridge (stays alive on stdin, exits on stdin close)', async () => {
    const child = spawn('node', [CLI], {
      env: {
        ...process.env,
        [agentIdEnv]: testAgentId,
        MCP_HOST: '127.0.0.1',
        MCP_PORT: '1',
      },
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
