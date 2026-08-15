import { createConnection, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MESSAGE_HUB_PORT, resolveMessageHubPort } from '../src/message-hub/config.js';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

const API_KEY = `test-message-hub-port-${'a'.repeat(32)}`;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function expectListening(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

describe.sequential('message hub port contract', () => {
  const originalEnv = { ...process.env };
  let server: NeuralMCPServer | undefined;
  let hub: any;
  let hubStarted = false;

  afterEach(async () => {
    if (hubStarted) await hub.stop();
    server?.close();
    server = undefined;
    hub = undefined;
    hubStarted = false;
    process.env = { ...originalEnv };
  });

  it('uses the canonical port 3004 when MESSAGE_HUB_PORT is unset', () => {
    process.env = { ...originalEnv, API_KEY, ENABLE_ADVANCED_MEMORY: 'false' };
    delete process.env.MESSAGE_HUB_PORT;

    expect(DEFAULT_MESSAGE_HUB_PORT).toBe(3004);
    expect(resolveMessageHubPort()).toBe(DEFAULT_MESSAGE_HUB_PORT);

    server = new NeuralMCPServer(0, ':memory:');
    hub = (server as any).messageHub;
    expect(hub.getPort()).toBe(DEFAULT_MESSAGE_HUB_PORT);
  });

  it('listens on and reports the explicitly configured port', async () => {
    const configuredPort = await getFreePort();
    process.env = {
      ...originalEnv,
      API_KEY,
      ENABLE_ADVANCED_MEMORY: 'false',
      MESSAGE_HUB_PORT: String(configuredPort),
    };

    server = new NeuralMCPServer(0, ':memory:');
    hub = (server as any).messageHub;
    await hub.start();
    hubStarted = true;

    await expectListening(configuredPort);
    const status = await supertest(server.getExpressApp())
      .get('/system/status')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(status.body.messageHub).toEqual({
      enabled: true,
      port: configuredPort,
      status: 'active',
    });
  });
});
