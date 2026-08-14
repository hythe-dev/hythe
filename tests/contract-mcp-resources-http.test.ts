import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(REPO, 'mcp-stdio-http-bridge.cjs');
const API_KEY = `test-resources-${'a'.repeat(32)}`;

function runBridge(port: number, uri: string, stateDir: string): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env };
    for (const key of [
      'ENGRAM_AGENT_ID',
      'MCP_FROM',
      'FROM',
      'HYTHE_AGENT_KEY_FILE',
      'HYTHE_AGENT_KEY',
      'HYTHE_AGENT_TOKEN',
      'HYTHE_AGENT_AUTH_MODE',
    ]) delete env[key];
    Object.assign(env, {
      API_KEY,
      HYTHE_AGENT_ID: 'agent-resource-reader',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_BRIDGE_STATE_DIR: stateDir,
    });
    const child = spawn('node', [BRIDGE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`bridge timed out: ${stderr}`));
    }, 10_000);
    child.on('error', rejectRun);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 91,
      method: 'resources/read',
      params: { uri },
    })}\n`);
  });
}

describe('served MCP resource transport', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let server: NeuralMCPServer;
  let httpServer: HttpServer | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv, API_KEY, ENABLE_ADVANCED_MEMORY: 'false' };
    delete process.env.UNIFIED_SERVER_URL;
    tempDir = mkdtempSync(join(tmpdir(), 'hythe-resource-http-'));
    server = new NeuralMCPServer(0, join(tempDir, 'test.db'));
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolveClose) => httpServer!.close(() => resolveClose()));
      httpServer = undefined;
    }
    server?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('serves resource discovery over the same /mcp endpoint used by the packaged bridge', async () => {
    const app = server.getExpressApp();
    const listed = await supertest(app)
      .post('/mcp')
      .set('X-API-Key', API_KEY)
      .send({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} })
      .expect(200);
    expect(listed.body).toMatchObject({ id: 1, result: { resources: [] } });

    const templates = await supertest(app)
      .post('/mcp')
      .set('X-API-Key', API_KEY)
      .send({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {} })
      .expect(200);
    expect(templates.body.result.resourceTemplates.map((entry: any) => entry.uriTemplate)).toContain(
      'engram://message/{scopeKey}/{recipientAgentId}/{messageId}'
    );
  });

  it('dereferences an exact-recipient message through the packaged stdio bridge and real /mcp route', async () => {
    const secret = 'served-message-body-only-for-resource-reader';
    server.getMemoryManager().getDb().prepare(`
      INSERT INTO ai_messages (
        id, from_agent, from_source, to_agent, content, message_type, priority,
        tenant_id, project_id, task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'message-resource-live', 'sender', 'test', 'agent-resource-reader', secret,
      'info', 'normal', 'default', 'resource-project', null
    );

    httpServer = server.getExpressApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolveListening, rejectListening) => {
      if (httpServer!.listening) return resolveListening();
      httpServer!.once('listening', resolveListening);
      httpServer!.once('error', rejectListening);
    });
    const port = (httpServer.address() as AddressInfo).port;
    const uri = 'engram://message/p%3Aresource-project/agent-resource-reader/message-resource-live';
    const response = await runBridge(port, uri, tempDir);

    expect(response.status).toBe(0);
    expect(response.stderr).not.toContain(secret);
    const body = JSON.parse(response.stdout.trim());
    expect(body).toMatchObject({
      id: 91,
      result: {
        contents: [{ uri, mimeType: 'text/plain', text: secret }],
      },
    });
  });
});
