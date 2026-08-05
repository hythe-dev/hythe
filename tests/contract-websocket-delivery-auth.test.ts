import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

const TEST_API_KEY = `ws-test-${'a'.repeat(40)}`;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a WebSocket test port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function openClient(
  url: string,
  headers: Record<string, string>
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForMessage(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

async function registerClient(ws: WebSocket, agentId: string): Promise<any> {
  const registered = waitForMessage(ws, 'registration.success');
  ws.send(JSON.stringify({ type: 'register', agentId }));
  return registered;
}

async function mcpCall(
  server: NeuralMCPServer,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  return JSON.parse(result.content[0].text);
}

describe('WebSocket delivery authentication', () => {
  let server: NeuralMCPServer;
  let hub: any;
  let hubUrl: string;
  let previousApiKey: string | undefined;
  let previousHubPort: string | undefined;
  let previousAdvancedMemory: string | undefined;
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    previousApiKey = process.env.API_KEY;
    previousHubPort = process.env.MESSAGE_HUB_PORT;
    previousAdvancedMemory = process.env.ENABLE_ADVANCED_MEMORY;
    const hubPort = await getFreePort();
    process.env.API_KEY = TEST_API_KEY;
    process.env.MESSAGE_HUB_PORT = String(hubPort);
    process.env.ENABLE_ADVANCED_MEMORY = 'false';

    server = new NeuralMCPServer(0, ':memory:');
    hub = (server as any).messageHub;
    await hub.start();
    hubUrl = `ws://127.0.0.1:${hubPort}`;
  });

  afterAll(async () => {
    for (const client of clients) client.close();
    await hub.stop();
    server.close();
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    if (previousHubPort === undefined) delete process.env.MESSAGE_HUB_PORT;
    else process.env.MESSAGE_HUB_PORT = previousHubPort;
    if (previousAdvancedMemory === undefined) delete process.env.ENABLE_ADVANCED_MEMORY;
    else process.env.ENABLE_ADVANCED_MEMORY = previousAdvancedMemory;
  });

  it('rejects an unauthenticated WebSocket upgrade', async () => {
    await expect(openClient(hubUrl, {
      'X-Neural-Agent-Id': 'unauthenticated-recipient',
    })).rejects.toThrow(/401/);
  });

  it('rejects identity mismatch and cross-agent subscriptions without recording delivery', async () => {
    const suffix = Date.now();
    const attacker = `ws-attacker-${suffix}`;
    const recipient = `ws-recipient-${suffix}`;

    const mismatch = await openClient(hubUrl, {
      'X-API-Key': TEST_API_KEY,
      'X-Neural-Agent-Id': attacker,
    });
    clients.push(mismatch);
    const mismatchError = waitForMessage(mismatch, 'error');
    mismatch.send(JSON.stringify({ type: 'register', agentId: recipient }));
    await expect(mismatchError).resolves.toMatchObject({ code: 'AGENT_IDENTITY_MISMATCH' });

    const attackerClient = await openClient(hubUrl, {
      'X-API-Key': TEST_API_KEY,
      'X-Neural-Agent-Id': attacker,
    });
    clients.push(attackerClient);
    await registerClient(attackerClient, attacker);
    const denied = waitForMessage(attackerClient, 'subscription.denied');
    attackerClient.send(JSON.stringify({ type: 'subscribe', targetAgentId: recipient }));
    await expect(denied).resolves.toMatchObject({ targetAgentId: recipient });

    const sent = await mcpCall(server, 'send_ai_message', {
      from: `ws-sender-${suffix}`,
      to: recipient,
      content: 'must remain queued',
    });
    expect(sent.messageIds[0]).toMatchObject({ deliveryStatus: 'queued', clientsNotified: 0 });

    const row = server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at FROM ai_messages WHERE id = ?'
    ).get(sent.messageIds[0].messageId) as any;
    expect(row.delivered_at).toBeNull();
  });

  it('records delivery for an authenticated exact-recipient connection', async () => {
    const suffix = Date.now();
    const recipient = `ws-authenticated-recipient-${suffix}`;
    const recipientClient = await openClient(hubUrl, {
      'Authorization': `Bearer ${TEST_API_KEY}`,
      'X-Neural-Agent-Id': recipient,
    });
    clients.push(recipientClient);
    await registerClient(recipientClient, recipient);

    const sent = await mcpCall(server, 'send_ai_message', {
      from: `ws-authenticated-sender-${suffix}`,
      to: recipient,
      content: 'authenticated delivery',
    });
    expect(sent.messageIds[0]).toMatchObject({ deliveryStatus: 'delivered', clientsNotified: 1 });

    const row = server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at FROM ai_messages WHERE id = ?'
    ).get(sent.messageIds[0].messageId) as any;
    expect(row.delivered_at).toBeTruthy();
  });
});
