import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(REPO, 'mcp-stdio-http-bridge.cjs');
const CLI = join(REPO, 'bin', 'engram-mcp.cjs');
const AGENT_ID = 'codex-houston';
const AGENT_TOKEN = `hya1_${'a'.repeat(24)}_${'B'.repeat(43)}`;
const BASE_KEY = 'deployment-proof-that-must-not-be-logged';
const cleanups: Array<() => void> = [];

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'HYTHE_AGENT_ID',
    'ENGRAM_AGENT_ID',
    'FROM',
    'MCP_FROM',
    'HYTHE_AGENT_KEY_FILE',
    'HYTHE_AGENT_KEY',
    'HYTHE_AGENT_TOKEN',
    'HYTHE_AGENT_AUTH_MODE',
    'API_KEY',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

async function startRecorder(options: {
  whoamiStatus?: number;
  whoamiAgentId?: string;
  whoamiBody?: unknown;
} = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/agent/whoami') {
        const status = options.whoamiStatus ?? 200;
        res.statusCode = status;
        res.end(JSON.stringify(options.whoamiBody ?? {
          tenantId: 'default',
          agentId: options.whoamiAgentId ?? AGENT_ID,
          credentialId: 'a'.repeat(24),
          scopes: ['agent:self'],
          enforcementState: 'enforced',
          authMode: 'required',
        }));
        return;
      }
      const parsed = JSON.parse(body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [] } }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('recorder failed to bind');
  return { requests, port: address.port };
}

async function runBridge(env: NodeJS.ProcessEnv, message: unknown) {
  const child = spawn('node', [BRIDGE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(message)}\n`);
  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`bridge timed out; stderr=${stderr}`));
    }, 10_000);
    child.once('error', rejectExit);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return { status, stdout, stderr };
}

function protectedTokenFile(mode = 0o600) {
  const directory = mkdtempSync(join(tmpdir(), 'hythe-agent-key-client-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'agent.key');
  writeFileSync(keyFile, `${AGENT_TOKEN}\n`, { mode });
  return { directory, keyFile };
}

function requiredEnv(keyFile: string, port: number): NodeJS.ProcessEnv {
  return cleanEnv({
    HYTHE_AGENT_ID: AGENT_ID,
    HYTHE_AGENT_KEY_FILE: keyFile,
    HYTHE_AGENT_AUTH_MODE: 'required',
    API_KEY: BASE_KEY,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
  });
}

function expectNoSecretOutput(result: { stdout: string; stderr: string }, ...extra: string[]) {
  const output = result.stdout + result.stderr;
  expect(output).not.toContain(AGENT_TOKEN);
  expect(output).not.toContain(BASE_KEY);
  for (const value of extra) expect(output).not.toContain(value);
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('per-agent credential client transport', () => {
  for (const mode of [0o400, 0o600]) {
    it(`attests a mode-${mode.toString(8)} key then sends both proofs on every HTTP request`, async () => {
      const recorder = await startRecorder();
      const { keyFile } = protectedTokenFile(mode);
      const result = await runBridge(requiredEnv(keyFile, recorder.port), {
        jsonrpc: '2.0', id: 41, method: 'tools/list', params: {},
      });

      expect(result.status).toBe(0);
      expect(recorder.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'GET /agent/whoami',
        'POST /mcp',
      ]);
      for (const request of recorder.requests) {
        expect(request.headers['x-api-key']).toBe(BASE_KEY);
        expect(request.headers['x-hythe-agent-key']).toBe(AGENT_TOKEN);
        expect(request.headers['x-hythe-agent-id']).toBe(AGENT_ID);
      }
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ id: 41, result: { tools: [] } });
      expectNoSecretOutput(result, keyFile);
    });
  }

  it('blocks all MCP forwarding when the server-bound identity mismatches', async () => {
    const recorder = await startRecorder({ whoamiAgentId: 'codex-hythe' });
    const { keyFile } = protectedTokenFile();
    const result = await runBridge(requiredEnv(keyFile, recorder.port), {
      jsonrpc: '2.0', id: 42, method: 'tools/list', params: {},
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/server-bound agent identity.*HYTHE_AGENT_ID/i);
    expect(recorder.requests.map((request) => request.url)).toEqual(['/agent/whoami']);
    expectNoSecretOutput(result, keyFile, 'codex-hythe');
  });

  it('does not echo a rejected attestation response and never forwards MCP', async () => {
    const recorder = await startRecorder({
      whoamiStatus: 401,
      whoamiBody: { error: 'rejected', reflected: AGENT_TOKEN },
    });
    const { keyFile } = protectedTokenFile();
    const result = await runBridge(requiredEnv(keyFile, recorder.port), {
      jsonrpc: '2.0', id: 43, method: 'initialize', params: {},
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(recorder.requests.map((request) => request.url)).toEqual(['/agent/whoami']);
    expectNoSecretOutput(result, keyFile);
  });

  it('rejects a missing, invalid, or weaker server authorization mode before forwarding', async () => {
    const { keyFile } = protectedTokenFile();
    for (const authMode of [undefined, 'invalid', 'observe', 'mixed']) {
      const recorder = await startRecorder({
        whoamiBody: {
          tenantId: 'default',
          agentId: AGENT_ID,
          credentialId: 'a'.repeat(24),
          scopes: ['agent:self'],
          enforcementState: 'enforced',
          ...(authMode === undefined ? {} : { authMode }),
        },
      });
      const result = await runBridge(requiredEnv(keyFile, recorder.port), {
        jsonrpc: '2.0', id: 44, method: 'tools/list', params: {},
      });

      expect(result.status, String(authMode)).toBe(2);
      expect(result.stdout, String(authMode)).toBe('');
      expect(result.stderr, String(authMode)).toMatch(/authorization mode is weaker/i);
      expect(recorder.requests.map((recorded) => recorded.url)).toEqual(['/agent/whoami']);
      expectNoSecretOutput(result, keyFile);
    }
  });

  it('accepts a server mode at least as strict as the configured client mode', async () => {
    const recorder = await startRecorder();
    const { keyFile } = protectedTokenFile();
    const result = await runBridge({
      ...requiredEnv(keyFile, recorder.port),
      HYTHE_AGENT_AUTH_MODE: 'mixed',
    }, {
      jsonrpc: '2.0', id: 45, method: 'tools/list', params: {},
    });

    expect(result.status).toBe(0);
    expect(recorder.requests.map((recorded) => recorded.url)).toEqual([
      '/agent/whoami',
      '/mcp',
    ]);
    expectNoSecretOutput(result, keyFile);
  });

  it('fails closed on missing, symlinked, non-file, unsafe, and malformed key files', () => {
    if (process.platform === 'win32') return;
    const { directory, keyFile } = protectedTokenFile();
    const symlink = join(directory, 'agent-link.key');
    const missing = join(directory, 'missing-agent.key');
    const malformed = join(directory, 'malformed-agent.key');
    const multiple = join(directory, 'multiple-agent.key');
    symlinkSync(keyFile, symlink);
    writeFileSync(malformed, 'not-a-token\n', { mode: 0o600 });
    writeFileSync(multiple, `${AGENT_TOKEN}\n${AGENT_TOKEN}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o640);

    const cases = [
      { path: missing, error: /could not be read safely/i },
      { path: symlink, error: /symbolic link/i },
      { path: directory, error: /regular file/i },
      { path: keyFile, error: /mode-400 or mode-600/i },
      { path: malformed, error: /one valid agent credential/i },
      { path: multiple, error: /one valid agent credential/i },
    ];
    for (const testCase of cases) {
      const result = spawnSync('node', [BRIDGE], {
        encoding: 'utf8',
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
        env: requiredEnv(testCase.path, 1),
      });
      expect(result.status, testCase.path).toBe(2);
      expect(result.stdout, testCase.path).toBe('');
      expect(result.stderr, testCase.path).toMatch(testCase.error);
      expectNoSecretOutput(result, testCase.path, 'not-a-token');
    }
  });

  it('requires a key file in required mode and rejects raw-secret env configuration', () => {
    const requiredWithoutFile = spawnSync('node', [BRIDGE], {
      encoding: 'utf8',
      env: cleanEnv({ HYTHE_AGENT_ID: AGENT_ID, HYTHE_AGENT_AUTH_MODE: 'required' }),
      input: '',
    });
    expect(requiredWithoutFile.status).toBe(2);
    expect(requiredWithoutFile.stderr).toMatch(/HYTHE_AGENT_KEY_FILE.*required/i);

    const rawSecret = spawnSync('node', [BRIDGE], {
      encoding: 'utf8',
      env: cleanEnv({
        HYTHE_AGENT_ID: AGENT_ID,
        HYTHE_AGENT_KEY: AGENT_TOKEN,
      }),
      input: '',
    });
    expect(rawSecret.status).toBe(2);
    expect(rawSecret.stderr).toMatch(/HYTHE_AGENT_KEY.*not accepted.*HYTHE_AGENT_KEY_FILE/i);
    expectNoSecretOutput(rawSecret);

    const demoWithAgentProof = spawnSync('node', [CLI, 'demo'], {
      encoding: 'utf8',
      env: cleanEnv({
        API_KEY: BASE_KEY,
        HYTHE_AGENT_KEY_FILE: '/must/not/be/echoed/agent.key',
      }),
    });
    expect(demoWithAgentProof.status).toBe(2);
    expect(demoWithAgentProof.stderr).toMatch(/demo uses multiple principals/i);
    expectNoSecretOutput(demoWithAgentProof, '/must/not/be/echoed/agent.key');
  });

  it('prints file-reference-only client configs and enforces required-mode init pairing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hythe-agent-key-init-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const keyFile = join(directory, 'agent.key');
    const result = spawnSync('node', [CLI, 'init',
      '--agent-id', AGENT_ID,
      '--agent-key-file', keyFile,
      '--agent-auth-mode', 'required',
    ], {
      cwd: directory,
      encoding: 'utf8',
      env: cleanEnv(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`HYTHE_AGENT_KEY_FILE`);
    expect(result.stdout).toContain(`HYTHE_AGENT_AUTH_MODE`);
    expect(result.stdout).toContain('required');
    expect(result.stdout).not.toContain('HYTHE_AGENT_KEY =');
    expect(result.stdout).not.toContain(AGENT_TOKEN);

    const codexSection = result.stdout
      .split('─── Codex (~/.codex/config.toml)')[1]
      ?.split('─── Cursor (.cursor/mcp.json)')[0];
    expect(codexSection).toBeDefined();
    expect(codexSection).toContain(`HYTHE_API_KEY_FILE = ${JSON.stringify(join(directory, '.env'))}`);
    expect(codexSection).toContain(`HYTHE_AGENT_ID = ${JSON.stringify(AGENT_ID)}`);
    expect(codexSection).toContain(`HYTHE_AGENT_KEY_FILE = ${JSON.stringify(keyFile)}`);
    expect(codexSection).toContain('HYTHE_AGENT_AUTH_MODE = "required"');
    expect(codexSection).toContain('MCP_HOST = "127.0.0.1"');
    expect(codexSection).toContain('MCP_PORT = "6174"');

    const missingPair = spawnSync('node', [CLI, 'init',
      '--agent-id', AGENT_ID,
      '--agent-auth-mode', 'required',
    ], { cwd: directory, encoding: 'utf8', env: cleanEnv() });
    expect(missingPair.status).toBe(2);
    expect(missingPair.stderr).toMatch(/--agent-key-file.*required/i);

    const rawOption = spawnSync('node', [CLI, 'init',
      '--agent-id', AGENT_ID,
      '--agent-key', AGENT_TOKEN,
    ], { cwd: directory, encoding: 'utf8', env: cleanEnv() });
    expect(rawOption.status).toBe(2);
    expect(rawOption.stderr).toMatch(/raw agent credential options.*--agent-key-file/i);
    expectNoSecretOutput(rawOption);
  });
});
