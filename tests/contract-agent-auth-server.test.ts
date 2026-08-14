import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import supertest from 'supertest';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import type { AgentCredentialStore } from '../src/agent-auth/index.js';
import { MessageHubWebSocketServer } from '../src/message-hub/websocket-server.js';
import type { RequestContext } from '../src/middleware/auth/types.js';
import { getTenantManager } from '../src/tenant/index.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createNetServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('failed to allocate port'));
        return;
      }
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function connectWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForWebSocketMessage(
  socket: WebSocket,
  predicate: (value: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for WebSocket message'));
    }, 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (!predicate(parsed)) return;
        cleanup();
        resolve(parsed);
      } catch {
        // Ignore unrelated/non-JSON frames in this focused helper.
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

describe('server-authoritative agent identity', () => {
  const apiKey = `agent-auth-contract-${'a'.repeat(40)}`;
  const directory = mkdtempSync(join(tmpdir(), 'hythe-agent-auth-server-'));
  const previous = {
    apiKey: process.env.API_KEY,
    mode: process.env.HYTHE_AGENT_AUTH_MODE,
    advanced: process.env.ENABLE_ADVANCED_MEMORY,
  };
  let server: NeuralMCPServer;
  let app: any;
  let store: AgentCredentialStore;
  let houstonToken: string;
  let hytheToken: string;

  beforeAll(() => {
    process.env.API_KEY = apiKey;
    process.env.HYTHE_AGENT_AUTH_MODE = 'required';
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, join(directory, 'agent-auth.db'));
    app = (server as any).app;
    store = (server as any).agentCredentialStore;

    for (const agentId of ['codex-houston', 'codex-hythe']) {
      store.ensurePrincipal({
        tenantId: 'default',
        agentId,
        enforcementState: 'enforced',
        createdBy: 'contract-operator',
      });
      const issued = store.issueCredential({
        tenantId: 'default',
        agentId,
        scopes: ['agent:self', 'message:read', 'message:send', 'state:read', 'state:write'],
        createdBy: 'contract-operator',
      });
      if (agentId === 'codex-houston') houstonToken = issued.token;
      else hytheToken = issued.token;
    }
  });

  afterAll(async () => {
    await server.close();
    if (previous.apiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous.apiKey;
    if (previous.mode === undefined) delete process.env.HYTHE_AGENT_AUTH_MODE;
    else process.env.HYTHE_AGENT_AUTH_MODE = previous.mode;
    if (previous.advanced === undefined) delete process.env.ENABLE_ADVANCED_MEMORY;
    else process.env.ENABLE_ADVANCED_MEMORY = previous.advanced;
    rmSync(directory, { recursive: true, force: true });
  });

  const base = (request: supertest.Test, token?: string) => {
    request.set('X-API-Key', apiKey);
    if (token) request.set('X-Hythe-Agent-Key', token);
    return request;
  };

  it('requires both credentials and injects the database-derived sender', async () => {
    const db = server.getMemoryManager().getDb();
    const before = (db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count;

    await base(supertest(app)
      .post('/ai-message')
      .set('Content-Type', 'application/json')
      .send({ from: 'codex-houston', to: 'codex-hythe', content: 'missing proof' }))
      .expect(401);
    await supertest(app)
      .post('/ai-message')
      .set('X-Hythe-Agent-Key', houstonToken)
      .set('Content-Type', 'application/json')
      .send({ to: 'codex-hythe', content: 'missing base proof' })
      .expect(401);
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count).toBe(before);

    const sent = await base(supertest(app)
      .post('/ai-message')
      .set('Content-Type', 'application/json')
      .send({ to: 'codex-hythe', content: 'bound sender' }), houstonToken)
      .expect(200);
    expect(db.prepare(
      'SELECT from_agent, to_agent, content FROM ai_messages WHERE id = ?',
    ).get(sent.body.messageId)).toEqual(expect.objectContaining({
      from_agent: 'codex-houston',
      to_agent: 'codex-hythe',
      content: 'bound sender',
    }));
  });

  it('provides a secret-free server-derived whoami attestation', async () => {
    await base(supertest(app).get('/agent/whoami')).expect(401);
    const response = await base(
      supertest(app).get('/agent/whoami'),
      houstonToken,
    ).expect(200);
    expect(response.body).toMatchObject({
      tenantId: 'default',
      agentId: 'codex-houston',
      credentialId: expect.any(String),
      enforcementState: 'enforced',
      authMode: 'required',
    });
    expect(response.body.scopes).toContain('agent:self');
    expect(JSON.stringify(response.body)).not.toContain(houstonToken);
    expect(store.getCredential(response.body.credentialId)?.lastUsedAt).not.toBeNull();
    expect(server.getMemoryManager().getDb().prepare(
      `SELECT tenant_id, agent_id, auth_mode, attested_at
       FROM agent_credential_attestations WHERE credential_id = ?`,
    ).get(response.body.credentialId)).toMatchObject({
      tenant_id: 'default',
      agent_id: 'codex-houston',
      auth_mode: 'required',
      attested_at: expect.any(String),
    });
  });

  it('rejects cross-agent HTTP send/read before a mailbox side effect', async () => {
    const db = server.getMemoryManager().getDb();
    const before = (db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count;
    const rejectedSend = await base(supertest(app)
      .post('/ai-message')
      .set('Content-Type', 'application/json')
      .send({ from: 'codex-hythe', to: 'codex-houston', content: 'must not store' }), houstonToken)
      .expect(403);
    expect(rejectedSend.body.code).toBe('AGENT_CLAIMED_IDENTITY_MISMATCH');
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count).toBe(before);

    const rejectedRead = await base(
      supertest(app).get('/ai-messages/codex-hythe?markAsRead=true'),
      houstonToken,
    ).expect(403);
    expect(rejectedRead.body.code).toBe('AGENT_CLAIMED_IDENTITY_MISMATCH');
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM ai_messages
       WHERE to_agent = 'codex-hythe' AND read_at IS NOT NULL`,
    ).get() as any).count).toBe(0);
  });

  it('binds MCP acting fields and message resources, with invalid proof never falling back', async () => {
    const mcp = (name: string, args: Record<string, unknown>, token: string) => base(
      supertest(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      token,
    );

    const own = await mcp('get_ai_messages', {}, hytheToken).expect(200);
    expect(own.body.result?.isError).not.toBe(true);
    const foreign = await mcp(
      'get_ai_messages',
      { agentId: 'codex-houston', markAsRead: true },
      hytheToken,
    ).expect(200);
    expect(foreign.body.result.isError).toBe(true);
    expect(foreign.body.result.structuredContent).toMatchObject({
      error: 'Agent authorization failed',
      code: 'AGENT_CLAIMED_IDENTITY_MISMATCH',
    });

    const resource = await base(supertest(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'engram://message/p%3Aproject/codex-houston/not-a-real-message' },
      }), hytheToken)
      .expect(200);
    expect(resource.body.error).toBeTruthy();
    expect(resource.body.error).toMatchObject({
      code: -32003,
      data: { code: 'AGENT_CLAIMED_IDENTITY_MISMATCH' },
    });

    const invalid = `${hytheToken.slice(0, -1)}x`;
    const invalidResponse = await base(
      supertest(app).post('/mcp').send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      invalid,
    ).expect(401);
    expect(invalidResponse.body.code).toBe('AGENT_CREDENTIAL_INVALID');
  });

  it('intersects a presented agent credential with privileged tool and HTTP scopes', async () => {
    const mcp = (name: string, args: Record<string, unknown>) => base(
      supertest(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name, arguments: args } }),
      houstonToken,
    );

    for (const [name, args] of [
      ['gc_agent_registrations', {}],
      ['get_user_profile', { userId: 'operator-user' }],
    ] as const) {
      const response = await mcp(name, args).expect(200);
      expect(response.body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: 'Agent authorization failed',
          code: 'AGENT_SCOPE_REQUIRED',
        },
      });
    }

    const strippedProof = await base(
      supertest(app).post('/mcp').send({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'gc_agent_registrations', arguments: {} },
      }),
    ).expect(200);
    expect(strippedProof.body.result).toMatchObject({
      isError: true,
      structuredContent: { code: 'AGENT_CREDENTIAL_REQUIRED' },
    });

    const previousDataManagement = process.env.ENABLE_DATA_MANAGEMENT;
    process.env.ENABLE_DATA_MANAGEMENT = '1';
    try {
      const strippedData = await base(
        supertest(app).get('/api/data/entity-prefixes'),
      ).expect(401);
      expect(strippedData.body.code).toBe('AGENT_CREDENTIAL_REQUIRED');
      const deniedData = await base(
        supertest(app).get('/api/data/entity-prefixes'),
        houstonToken,
      ).expect(403);
      expect(deniedData.body.code).toBe('AGENT_SCOPE_REQUIRED');

      const dataReader = store.issueCredential({
        tenantId: 'default',
        agentId: 'codex-houston',
        scopes: ['data:read'],
        createdBy: 'contract-operator',
      });
      await base(
        supertest(app).get('/api/data/entity-prefixes'),
        dataReader.token,
      ).expect(200);

      const deniedGraph = await base(
        supertest(app).get('/api/graph-export'),
        houstonToken,
      ).expect(403);
      expect(deniedGraph.body.code).toBe('AGENT_SCOPE_REQUIRED');
    } finally {
      if (previousDataManagement === undefined) delete process.env.ENABLE_DATA_MANAGEMENT;
      else process.env.ENABLE_DATA_MANAGEMENT = previousDataManagement;
    }
  });

  it('denies a restricted tenant base before an MCP mailbox body or read side effect', async () => {
    const validation = store.validateCredential({
      token: houstonToken,
      tenantId: 'default',
      updateLastUsed: false,
    });
    expect(validation.valid).toBe(true);
    if (!validation.valid) throw new Error('test agent credential did not validate');

    const secretBody = 'restricted-base-must-not-read-this-body';
    const messageId = await server.getMemoryManager().storeMessage(
      'codex-hythe',
      'codex-houston',
      secretBody,
      'direct',
      'normal',
      {},
      'default',
    );
    const context: RequestContext = {
      tenantId: 'default',
      userId: null,
      authType: 'api_key',
      apiKeyId: 'restricted-tenant-key',
      idpSub: null,
      roles: [],
      scopes: ['profile:read'],
      mfaLevel: null,
      timezoneHint: null,
      agentPrincipal: {
        agentId: validation.principal.agentId,
        credentialId: validation.credential.credentialId,
        scopes: [...validation.credential.scopes],
        enforcementState: validation.principal.enforcementState,
      },
      agentCredentialPresented: true,
      agentAuthMode: 'required',
    };

    const denied = await (server as any)._handleToolCall('get_ai_messages', {
      agentId: 'codex-houston',
      compact: false,
      unreadOnly: true,
      markAsRead: true,
    }, context);
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'Agent authorization failed',
        code: 'BASE_SCOPE_REQUIRED',
      },
    });
    expect(JSON.stringify(denied)).not.toContain(secretBody);
    expect(server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at, read_at FROM ai_messages WHERE id = ?',
    ).get(messageId)).toEqual({ delivered_at: null, read_at: null });

    const allowed = await (server as any)._handleToolCall('get_ai_messages', {
      agentId: 'codex-houston',
      compact: false,
      unreadOnly: true,
      markAsRead: true,
    }, { ...context, apiKeyId: 'full-tenant-key', scopes: ['*'] });
    expect(allowed.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain(secretBody);
    expect(server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at, read_at FROM ai_messages WHERE id = ?',
    ).get(messageId)).toEqual({
      delivered_at: expect.any(String),
      read_at: expect.any(String),
    });
  });

  it('narrows dashboard and operator routes and reserves destructive compaction for memory administrators', async () => {
    const strippedMetrics = await base(supertest(app).get('/metrics')).expect(401);
    expect(strippedMetrics.body.code).toBe('AGENT_CREDENTIAL_REQUIRED');
    const opsReader = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['ops:read'],
      createdBy: 'contract-operator',
    });
    await base(supertest(app).get('/metrics'), opsReader.token).expect(200);
    for (const path of [
      '/api/recent-events',
      '/api/agent-status',
      '/api/analytics',
      '/metrics',
      '/metrics.json',
      '/metrics/events',
      '/metrics/retention',
      '/slo/status',
      '/slo/alerts',
      '/logs/config',
      '/system/status',
    ]) {
      const denied = await base(supertest(app).get(path), houstonToken).expect(403);
      expect(denied.body.code, path).toBe('AGENT_SCOPE_REQUIRED');
      expect(JSON.stringify(denied.body), path).not.toContain('bound sender');
    }
    await base(supertest(app).post('/metrics/compact'), houstonToken).expect(403);
    await base(supertest(app).post('/logs/config').send({}), houstonToken).expect(403);

    const previousAdmin = process.env.ENABLE_ADMIN_ENDPOINTS;
    const auditReader = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['audit:read'],
      createdBy: 'contract-operator',
    });
    try {
      delete process.env.ENABLE_ADMIN_ENDPOINTS;
      await base(supertest(app).get('/admin/audit-log'), auditReader.token).expect(403);
      for (const disabledValue of ['0', 'false', 'no']) {
        process.env.ENABLE_ADMIN_ENDPOINTS = disabledValue;
        await base(supertest(app).get('/admin/audit-log'), auditReader.token).expect(403);
      }
      process.env.ENABLE_ADMIN_ENDPOINTS = '1';
      await base(supertest(app).get('/admin/audit-log'), auditReader.token).expect(200);
      await base(supertest(app).get('/admin/audit-log'), houstonToken).expect(403);
    } finally {
      if (previousAdmin === undefined) delete process.env.ENABLE_ADMIN_ENDPOINTS;
      else process.env.ENABLE_ADMIN_ENDPOINTS = previousAdmin;
    }

    const ordinaryMemory = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['memory:read', 'memory:write'],
      createdBy: 'contract-operator',
    });
    const response = await base(
      supertest(app).post('/mcp').send({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: {
          name: 'compact_memory',
          arguments: { mode: 'execute', confirm: true, classes: ['vec-orphans'] },
        },
      }),
      ordinaryMemory.token,
    ).expect(200);
    expect(response.body.result).toMatchObject({
      isError: true,
      structuredContent: {
        error: 'Agent authorization failed',
        code: 'AGENT_SCOPE_REQUIRED',
      },
    });
    expect(response.body.result.content[0].text).toContain('AGENT_SCOPE_REQUIRED');

    const destructiveCases = [
      ['delete_entity', { entityName: 'absent-entity', dryRun: true }],
      ['remove_observations', { entityName: 'absent-entity', observationIds: ['absent-observation'], dryRun: true }],
      ['update_observation', { observationId: 'absent-observation', contentIndex: 0, newContent: 'no mutation' }],
      ['delete_observations_by_entity', { entityName: 'absent-entity', dryRun: true }],
    ] as const;
    for (const [name, arguments_] of destructiveCases) {
      const denied = await base(
        supertest(app).post('/mcp').send({
          jsonrpc: '2.0',
          id: 92,
          method: 'tools/call',
          params: { name, arguments: arguments_ },
        }),
        ordinaryMemory.token,
      ).expect(200);
      expect(denied.body.result, name).toMatchObject({
        isError: true,
        structuredContent: { code: 'AGENT_SCOPE_REQUIRED' },
      });
    }

    const memoryAdmin = store.issueCredential({
      tenantId: 'default',
      agentId: 'codex-houston',
      scopes: ['memory:admin'],
      createdBy: 'contract-operator',
    });
    for (const [name, arguments_] of destructiveCases) {
      const allowedToHandler = await base(
        supertest(app).post('/mcp').send({
          jsonrpc: '2.0',
          id: 93,
          method: 'tools/call',
          params: { name, arguments: arguments_ },
        }),
        memoryAdmin.token,
      ).expect(200);
      expect(
        allowedToHandler.body.result?.structuredContent?.code,
        name,
      ).not.toBe('AGENT_SCOPE_REQUIRED');
    }
  });

  it('never accepts agent credentials in query strings', async () => {
    const response = await base(
      supertest(app).get(`/api/tools?hythe_agent_key=${encodeURIComponent(houstonToken)}`),
    ).expect(400);
    expect(response.body.code).toBe('AGENT_CREDENTIAL_IN_URL');
    expect(JSON.stringify(response.body)).not.toContain(houstonToken);
  });

  it('derives the WebSocket identity from dual proof and rejects asserted/query downgrades', async () => {
    const port = await freePort();
    const hub = new MessageHubWebSocketServer(port, store, 'required');
    await hub.start();
    const url = `ws://127.0.0.1:${port}`;
    try {
      await expect(connectWebSocket(url, {
        'X-API-Key': apiKey,
        'X-Neural-Agent-Id': 'codex-houston',
      })).rejects.toThrow(/401/);
      await expect(connectWebSocket(url, {
        'X-Hythe-Agent-Key': houstonToken,
      })).rejects.toThrow(/401/);
      await expect(connectWebSocket(url, {
        'X-API-Key': apiKey,
        'X-Hythe-Agent-Key': houstonToken,
        'X-Neural-Agent-Id': 'codex-hythe',
      })).rejects.toThrow(/401/);
      await expect(connectWebSocket(
        `${url}?hythe_agent_key=${encodeURIComponent(houstonToken)}`,
        { 'X-API-Key': apiKey, 'X-Neural-Agent-Id': 'codex-houston' },
      )).rejects.toThrow(/401/);

      const accepted = await connectWebSocket(url, {
        'X-API-Key': apiKey,
        'X-Hythe-Agent-Key': houstonToken,
      });
      accepted.close();
    } finally {
      await hub.stop();
    }
  });

  it('evicts an authenticated WebSocket before delivery after credential revocation', async () => {
    const agentId = 'codex-ws-revoked';
    store.ensurePrincipal({
      tenantId: 'default',
      agentId,
      enforcementState: 'enforced',
      createdBy: 'contract-operator',
    });
    const issued = store.issueCredential({
      tenantId: 'default',
      agentId,
      scopes: ['message:read'],
      createdBy: 'contract-operator',
    });
    const port = await freePort();
    const hub = new MessageHubWebSocketServer(port, store, 'required');
    await hub.start();
    try {
      const socket = await connectWebSocket(`ws://127.0.0.1:${port}`, {
        'X-API-Key': apiKey,
        'X-Hythe-Agent-Key': issued.token,
      });
      const registered = waitForWebSocketMessage(
        socket,
        (message) => message.type === 'registration.success',
      );
      socket.send(JSON.stringify({ type: 'register', agentId }));
      await registered;

      store.revokeCredential({
        credentialId: issued.credential.credentialId,
        actor: 'contract-operator',
      });
      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code) => resolve(code));
      });
      expect(hub.notifyNewMessage(
        'message-after-revocation',
        'codex-houston',
        agentId,
        'must not be delivered',
        'default',
      )).toBe(0);
      expect(await closed).toBe(1008);
    } finally {
      await hub.stop();
    }
  });

  it('never crosses tenant boundaries for any Message Hub event type', () => {
    const hub = new MessageHubWebSocketServer(0, undefined, 'observe');
    const sentA = vi.fn();
    const sentB = vi.fn();
    const client = (tenantId: string, send: ReturnType<typeof vi.fn>) => ({
      ws: {
        readyState: WebSocket.OPEN,
        send,
        close: vi.fn(),
      },
      agentId: 'same-agent',
      tenantId,
      credentialId: null,
      baseAuth: { kind: 'deployment_key' as const },
      lastHeartbeat: new Date(),
      subscriptions: new Set(['same-agent']),
    });
    (hub as any).clients.set('tenant-a-client', client('tenant-a', sentA));
    (hub as any).clients.set('tenant-b-client', client('tenant-b', sentB));

    const events = [
      { type: 'message.new', agentId: 'sender', targetAgentId: 'same-agent', messageId: 'm1' },
      { type: 'message.read', agentId: 'sender', targetAgentId: 'same-agent', messageId: 'm1' },
      { type: 'agent.online', agentId: 'same-agent' },
      { type: 'agent.offline', agentId: 'same-agent' },
      { type: 'heartbeat', agentId: 'same-agent' },
    ] as const;
    for (const event of events) {
      sentA.mockClear();
      sentB.mockClear();
      expect(hub.broadcastEvent({
        ...event,
        tenantId: 'tenant-a',
        timestamp: new Date().toISOString(),
      })).toBe(1);
      expect(sentA).toHaveBeenCalledTimes(1);
      expect(sentB).not.toHaveBeenCalled();
    }
    expect(() => hub.broadcastEvent({
      type: 'message.new',
      targetAgentId: 'same-agent',
      tenantId: '',
      timestamp: new Date().toISOString(),
    })).toThrow(/exact tenant identity/);
  });

  it('evicts a tenant WebSocket when its base key is revoked without disturbing another tenant', async () => {
    const previousMultiTenant = process.env.MULTI_TENANT_ENABLED;
    process.env.MULTI_TENANT_ENABLED = 'true';
    const tenantManager = getTenantManager(join(directory, 'tenant-keys.db'));
    const tenants = ['tenant-ws-a', 'tenant-ws-b'] as const;
    const credentials: Array<{ tenantId: string; baseKey: string; baseKeyId: string; agentToken: string }> = [];
    for (const tenantId of tenants) {
      if (!tenantManager.getTenant(tenantId)) {
        tenantManager.createTenant({ id: tenantId, name: tenantId, tier: 'enterprise' });
      }
      const baseCredential = tenantManager.generateApiKey({
        tenantId,
        name: `${tenantId}-websocket`,
        permissions: ['*'],
      });
      store.ensurePrincipal({
        tenantId,
        agentId: 'same-agent',
        enforcementState: 'enforced',
        createdBy: 'contract-operator',
      });
      const agentCredential = store.issueCredential({
        tenantId,
        agentId: 'same-agent',
        scopes: ['message:read'],
        createdBy: 'contract-operator',
      });
      credentials.push({
        tenantId,
        baseKey: baseCredential.key,
        baseKeyId: baseCredential.record.id,
        agentToken: agentCredential.token,
      });
    }

    const port = await freePort();
    const hub = new MessageHubWebSocketServer(port, store, 'required');
    await hub.start();
    const sockets: WebSocket[] = [];
    try {
      for (const credential of credentials) {
        const socket = await connectWebSocket(`ws://127.0.0.1:${port}`, {
          'X-API-Key': credential.baseKey,
          'X-Hythe-Agent-Key': credential.agentToken,
        });
        sockets.push(socket);
        const registered = waitForWebSocketMessage(
          socket,
          (message) => message.type === 'registration.success',
        );
        socket.send(JSON.stringify({ type: 'register', agentId: 'same-agent' }));
        await registered;
      }

      const revokedClosed = new Promise<number>((resolve) => {
        sockets[0].once('close', (code) => resolve(code));
      });
      expect(tenantManager.revokeApiKey(credentials[0].baseKeyId)).toBe(true);
      expect(hub.notifyNewMessage(
        'tenant-a-after-revoke',
        'sender',
        'same-agent',
        'must not deliver',
        credentials[0].tenantId,
      )).toBe(0);
      expect(await revokedClosed).toBe(1008);

      const liveDelivery = waitForWebSocketMessage(
        sockets[1],
        (message) => message.type === 'message.new',
      );
      expect(hub.notifyNewMessage(
        'tenant-b-still-live',
        'sender',
        'same-agent',
        'allowed delivery',
        credentials[1].tenantId,
      )).toBe(1);
      await expect(liveDelivery).resolves.toMatchObject({
        messageId: 'tenant-b-still-live',
        tenantId: credentials[1].tenantId,
      });
    } finally {
      for (const socket of sockets) socket.close();
      await hub.stop();
      if (previousMultiTenant === undefined) delete process.env.MULTI_TENANT_ENABLED;
      else process.env.MULTI_TENANT_ENABLED = previousMultiTenant;
    }
  });

  it('requires message-read authority from the tenant base before a WebSocket can receive previews', async () => {
    const previousMultiTenant = process.env.MULTI_TENANT_ENABLED;
    process.env.MULTI_TENANT_ENABLED = 'true';
    const tenantManager = getTenantManager(join(directory, 'tenant-keys.db'));
    const tenantId = 'tenant-ws-scope';
    if (!tenantManager.getTenant(tenantId)) {
      tenantManager.createTenant({ id: tenantId, name: tenantId, tier: 'enterprise' });
    }
    const restrictedBase = tenantManager.generateApiKey({
      tenantId,
      name: 'restricted-websocket',
      permissions: ['profile:read'],
    });
    const fullBase = tenantManager.generateApiKey({
      tenantId,
      name: 'full-websocket',
      permissions: ['*'],
    });
    store.ensurePrincipal({
      tenantId,
      agentId: 'scoped-agent',
      enforcementState: 'enforced',
      createdBy: 'contract-operator',
    });
    const agentCredential = store.issueCredential({
      tenantId,
      agentId: 'scoped-agent',
      scopes: ['*'],
      createdBy: 'contract-operator',
    });

    const port = await freePort();
    const hub = new MessageHubWebSocketServer(port, store, 'required');
    await hub.start();
    let accepted: WebSocket | null = null;
    try {
      await expect(connectWebSocket(`ws://127.0.0.1:${port}`, {
        'X-API-Key': restrictedBase.key,
        'X-Hythe-Agent-Key': agentCredential.token,
      })).rejects.toThrow(/401/);
      expect(hub.notifyNewMessage(
        'restricted-preview',
        'sender',
        'scoped-agent',
        'must not be previewed',
        tenantId,
      )).toBe(0);

      accepted = await connectWebSocket(`ws://127.0.0.1:${port}`, {
        'X-API-Key': fullBase.key,
        'X-Hythe-Agent-Key': agentCredential.token,
      });
      const registered = waitForWebSocketMessage(
        accepted,
        (message) => message.type === 'registration.success',
      );
      accepted.send(JSON.stringify({ type: 'register', agentId: 'scoped-agent' }));
      await registered;
      const delivered = waitForWebSocketMessage(
        accepted,
        (message) => message.type === 'message.new',
      );
      expect(hub.notifyNewMessage(
        'full-base-preview',
        'sender',
        'scoped-agent',
        'positive control preview',
        tenantId,
      )).toBe(1);
      await expect(delivered).resolves.toMatchObject({
        messageId: 'full-base-preview',
        content: { preview: 'positive control preview' },
      });

      const closed = new Promise<number>((resolve) => {
        accepted!.once('close', (code) => resolve(code));
      });
      (tenantManager as any).db.prepare(
        'UPDATE api_keys SET permissions = ? WHERE id = ?',
      ).run(JSON.stringify(['profile:read']), fullBase.record.id);
      expect(hub.notifyNewMessage(
        'after-base-scope-downgrade',
        'sender',
        'scoped-agent',
        'must not survive revalidation',
        tenantId,
      )).toBe(0);
      expect(await closed).toBe(1008);
    } finally {
      accepted?.close();
      await hub.stop();
      if (previousMultiTenant === undefined) delete process.env.MULTI_TENANT_ENABLED;
      else process.env.MULTI_TENANT_ENABLED = previousMultiTenant;
    }
  });
});
