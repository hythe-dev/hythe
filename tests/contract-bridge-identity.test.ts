import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(REPO, 'mcp-stdio-http-bridge.cjs');
const cleanups: Array<() => void> = [];
const bridgeSource = readFileSync(BRIDGE, 'utf8');
const boundToolsBlock = /const AGENT_ID_BOUND_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(bridgeSource)?.[1] || '';
const agentIdBoundTools = Array.from(boundToolsBlock.matchAll(/'([^']+)'/g), (match) => match[1]);

function identityCleanEnv(extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['HYTHE_AGENT_ID', 'ENGRAM_AGENT_ID', 'FROM', 'MCP_FROM']) {
    delete env[key];
  }
  return { ...env, ...extra };
}

async function startRecorder(
  responseFor: (request: any) => unknown = (request) => ({
    jsonrpc: '2.0', id: request.id, result: { content: [] },
  })
) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseFor(parsed)));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('recorder did not bind a TCP port');
  return { requests, port: address.port };
}

async function runBridge(bridge: string, env: NodeJS.ProcessEnv, message: unknown | unknown[]) {
  const child = spawn('node', [bridge], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const messages = Array.isArray(message) ? message : [message];
  child.stdin.end(`${messages.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`bridge timed out; stderr=${stderr}`));
    }, 10_000);
    child.on('error', rejectExit);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return { status, stdout, stderr };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('stdio bridge identity boundary', () => {
  it('keeps the bridge policy closed over every declared or implicit acting identity', () => {
    const targetOnlyAgentIdTools = new Set(['send_ai_message', 'get_agent_status']);
    const declaredActingTools = Object.values(UnifiedToolSchemas)
      .filter((tool) => Object.prototype.hasOwnProperty.call(tool.inputSchema?.properties || {}, 'agentId'))
      .map((tool) => tool.name)
      .filter((name) => !targetOnlyAgentIdTools.has(name));
    const implicitActingTools = [
      'create_entities',
      'create_relations',
      'compact_memory',
      'delete_entity',
      'remove_observations',
      'update_observation',
      'delete_observations_by_entity',
      'begin_session',
      'checkpoint',
      'resume',
    ];
    const expected = Array.from(new Set([...declaredActingTools, ...implicitActingTools])).sort();
    expect(agentIdBoundTools.sort()).toEqual(expected);
  });

  it('binds an omitted send_ai_message.from to HYTHE_AGENT_ID', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'send_ai_message', arguments: { to: 'peer', content: 'hello' } },
    });

    expect(response.status).toBe(0);
    expect(recorder.requests).toHaveLength(1);
    expect((recorder.requests[0] as any).params.arguments.from).toBe('codex-public-client');
  });

  it('rejects an explicit sender mismatch locally and never forwards it', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'send_ai_message',
        arguments: { from: 'impersonated-agent', to: 'peer', content: 'hello' },
      },
    });

    expect(response.status).toBe(0);
    const json = JSON.parse(response.stdout.trim());
    expect(json.id).toBe(2);
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toMatch(/sender identity.*match/i);
    expect(recorder.requests).toHaveLength(0);
  });

  it('rejects mismatched acting identities for every identity-bearing tool before forwarding', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), agentIdBoundTools.map((name, index) => ({
      jsonrpc: '2.0', id: 100 + index, method: 'tools/call',
      params: { name, arguments: { agentId: 'impersonated-agent' } },
    })));

    expect(response.status).toBe(0);
    const responses = response.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(agentIdBoundTools.length);
    expect(responses.every((entry) => entry.error?.code === -32602)).toBe(true);
    expect(responses.every((entry) => /bridge-bound identity/i.test(entry.error?.message))).toBe(true);
    expect(response.stdout).not.toContain('impersonated-agent');
    expect(response.stderr).not.toContain('impersonated-agent');
    expect(recorder.requests).toHaveLength(0);
  });

  it('injects the bridge identity into every identity-bearing tool when omitted', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), agentIdBoundTools.map((name, index) => ({
      jsonrpc: '2.0', id: 200 + index, method: 'tools/call',
      params: { name, arguments: {} },
    })));

    expect(response.status).toBe(0);
    expect(recorder.requests).toHaveLength(agentIdBoundTools.length);
    for (const request of recorder.requests as any[]) {
      expect(request.params.arguments.agentId, request.params.name).toBe('codex-public-client');
    }
  });

  it('does not mistake recipient, status-target, or filter fields for caller identity', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), [
      {
        jsonrpc: '2.0', id: 300, method: 'tools/call',
        params: { name: 'send_ai_message', arguments: { agentId: 'peer-target', content: 'hello' } },
      },
      {
        jsonrpc: '2.0', id: 301, method: 'tools/call',
        params: { name: 'get_agent_status', arguments: { agentId: 'peer-target' } },
      },
      {
        jsonrpc: '2.0', id: 302, method: 'tools/call',
        params: { name: 'search_entities', arguments: { query: 'topic', agentFilter: 'peer-target' } },
      },
    ]);

    expect(response.status).toBe(0);
    expect(recorder.requests).toHaveLength(3);
    expect((recorder.requests[0] as any).params.arguments).toMatchObject({
      agentId: 'peer-target',
      from: 'codex-public-client',
    });
    expect((recorder.requests[1] as any).params.arguments.agentId).toBe('peer-target');
    expect((recorder.requests[2] as any).params.arguments.agentFilter).toBe('peer-target');
  });

  it('rejects a Houston message resource on the Hythe-bound bridge locally with zero HTTP requests', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-hythe',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 350, method: 'resources/read',
      params: { uri: 'engram://message/p%3Au-proj/codex-houston/m-secret' },
    });

    expect(response.status).toBe(0);
    const json = JSON.parse(response.stdout.trim());
    expect(json).toMatchObject({ id: 350, error: { code: -32602 } });
    expect(json.error.message).toMatch(/recipient.*bridge-bound identity/i);
    expect(response.stdout).not.toContain('codex-houston');
    expect(response.stderr).not.toContain('codex-houston');
    expect(recorder.requests).toHaveLength(0);
  });

  it('rejects legacy recipient-unbound message resource handles locally with zero HTTP requests', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'agent-x',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 351, method: 'resources/read',
      params: { uri: 'engram://message/p%3Au-proj/m-secret' },
    });

    expect(response.status).toBe(0);
    expect(JSON.parse(response.stdout.trim())).toMatchObject({
      id: 351,
      error: { code: -32602 },
    });
    expect(recorder.requests).toHaveLength(0);
  });

  it('forwards a message resource bound to the bridge recipient unchanged', async () => {
    const recorder = await startRecorder((request) => ({
      jsonrpc: '2.0', id: request.id, result: { contents: [{ text: 'full body' }] },
    }));
    const uri = 'engram://message/p%3Au-proj/agent-x/m-mine';
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'agent-x',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 352, method: 'resources/read', params: { uri },
    });

    expect(response.status).toBe(0);
    expect(recorder.requests).toHaveLength(1);
    expect((recorder.requests[0] as any)).toMatchObject({
      method: 'resources/read', params: { uri },
    });
    expect(JSON.parse(response.stdout.trim())).toMatchObject({
      id: 352,
      result: { contents: [{ text: 'full body' }] },
    });
  });

  it('preserves snapshot and handoff resource reads', async () => {
    const recorder = await startRecorder();
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'agent-x',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), [
      {
        jsonrpc: '2.0', id: 353, method: 'resources/read',
        params: { uri: 'engram://snapshot/p%3Au-proj/s-1' },
      },
      {
        jsonrpc: '2.0', id: 354, method: 'resources/read',
        params: { uri: 'engram://handoff/p%3Au-proj/h-1' },
      },
    ]);

    expect(response.status).toBe(0);
    expect(recorder.requests).toHaveLength(2);
    expect((recorder.requests as any[]).map((request) => request.params.uri)).toEqual([
      'engram://snapshot/p%3Au-proj/s-1',
      'engram://handoff/p%3Au-proj/h-1',
    ]);
  });

  it('does not let a response bridgeCommand replace the configured identity', async () => {
    const recorder = await startRecorder((request) => ({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [],
        bridgeCommand: { agentId: 'server-override', autoRegister: false },
      },
    }));
    const response = await runBridge(BRIDGE, identityCleanEnv({
      HYTHE_AGENT_ID: 'codex-public-client',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'send_ai_message', arguments: { to: 'peer', content: 'hello' } },
    });

    expect(response.status).toBe(0);
    expect((recorder.requests[0] as any).params.arguments.from).toBe('codex-public-client');
    expect(response.stderr).toMatch(/refusing to replace (?:the )?configured agent identity/i);
    expect(JSON.parse(response.stdout.trim()).result.bridgeCommand).toBeUndefined();
  });

  it('fails closed when HYTHE_AGENT_ID conflicts with any legacy identity alias', () => {
    for (const alias of ['ENGRAM_AGENT_ID', 'FROM', 'MCP_FROM']) {
      const result = spawnSync('node', [BRIDGE], {
        encoding: 'utf8',
        env: identityCleanEnv({ HYTHE_AGENT_ID: 'codex-a', [alias]: 'codex-b' }),
        input: '',
      });
      expect(result.status, alias).toBe(2);
      expect(result.stderr).toContain('HYTHE_AGENT_ID');
      expect(result.stderr).toContain(alias);
      expect(result.stderr).toMatch(/conflict/i);
    }
  });

  it('requires explicit identity in the HYTHE distribution without minting a host identity', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hythe-bridge-state-'));
    try {
      const result = spawnSync('node', [BRIDGE], {
        encoding: 'utf8',
        env: identityCleanEnv({ MCP_BRIDGE_STATE_DIR: stateDir }),
        input: '',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/HYTHE_AGENT_ID/);
      expect(() => readFileSync(join(stateDir, 'bridge-identity-test.json'))).toThrow();
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('does not let transport sender variables select a HYTHE logical identity', () => {
    for (const transport of ['FROM', 'MCP_FROM']) {
      const result = spawnSync('node', [BRIDGE], {
        encoding: 'utf8',
        env: identityCleanEnv({ [transport]: 'transport-only' }),
        input: '',
      });
      expect(result.status, transport).toBe(2);
      expect(result.stderr).toMatch(/HYTHE_AGENT_ID.*required/i);
      expect(result.stderr).not.toContain('transport-only');
    }
  });

  it('rejects logical identities outside the portable agent-id alphabet', () => {
    for (const invalid of ['agent with spaces', 'agent/other', 'agent\nsmuggled']) {
      const result = spawnSync('node', [BRIDGE], {
        encoding: 'utf8',
        env: identityCleanEnv({ HYTHE_AGENT_ID: invalid }),
        input: '',
      });
      expect(result.status, invalid).toBe(2);
      expect(result.stderr).toMatch(/HYTHE_AGENT_ID.*1-100/i);
      expect(result.stderr).not.toContain(invalid);
    }
  });

  it('preserves generated-host fallback for a generic legacy distribution', async () => {
    const recorder = await startRecorder();
    const dir = mkdtempSync(join(tmpdir(), 'engram-generic-bridge-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bridge = join(dir, 'mcp-stdio-http-bridge.cjs');
    const stateDir = join(dir, 'state');
    copyFileSync(BRIDGE, bridge);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ hytheDistribution: false }));

    const response = await runBridge(bridge, identityCleanEnv({
      MCP_BRIDGE_STATE_DIR: stateDir,
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(recorder.port),
    }), {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'send_ai_message', arguments: { to: 'peer', content: 'hello' } },
    });

    expect(response.status).toBe(0);
    const from = (recorder.requests[0] as any).params.arguments.from;
    expect(from).toMatch(/^agent-/);
    expect(readFileSync(join(stateDir, `bridge-identity-${hostname().split('.')[0]}.json`), 'utf8'))
      .toContain(from);
  });
});
