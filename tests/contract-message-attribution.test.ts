/**
 * Field feedback P1 item 6: message attribution labels. Labelling only — no
 * lockdown, no auth-mode change. Every stored message records how the server
 * knew the sender, and every read surface exposes it at the top level of the
 * message item:
 *   attributionSource: credential | asserted | server-default | unknown
 *   authoredBy:        the stored sender id
 * credentialId and apiKeyId are never exposed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import type { AgentCredentialStore } from '../src/agent-auth/index.js';
import type { RequestContext } from '../src/middleware/auth/types.js';
import { DEFAULT_REQUEST_CONTEXT } from '../src/middleware/auth/types.js';
import { messageAttribution, readMessageAttribution } from '../src/agent-auth/attribution.js';

describe('message attribution labels (authoredBy, attributionSource)', () => {
  const apiKey = `attribution-contract-${'b'.repeat(40)}`;
  const directory = mkdtempSync(join(tmpdir(), 'hythe-attribution-'));
  const previous = {
    apiKey: process.env.API_KEY,
    mode: process.env.HYTHE_AGENT_AUTH_MODE,
    advanced: process.env.ENABLE_ADVANCED_MEMORY,
  };
  const reader = 'attr-reader';
  const credentialed = 'attr-cred';
  let server: NeuralMCPServer;
  let app: any;
  let store: AgentCredentialStore;
  let token = '';
  let credentialId = '';

  const credentialContext = (): RequestContext => ({
    ...DEFAULT_REQUEST_CONTEXT,
    agentCredentialPresented: true,
    agentPrincipal: {
      agentId: credentialed,
      credentialId,
      scopes: ['agent:self', 'message:read', 'message:send'],
      enforcementState: 'enforced',
    },
  });

  async function mcp(name: string, args: Record<string, any>, context: RequestContext = DEFAULT_REQUEST_CONTEXT): Promise<any> {
    const result = await (server as any)._handleToolCall(name, args, context);
    const text = result?.content?.[0]?.text;
    if (result?.isError) throw new Error(`Tool error: ${text}`);
    return JSON.parse(text);
  }

  const inbox = async (agentId: string) =>
    (await mcp('get_ai_messages', { agentId, unreadOnly: false, limit: 20, compact: true })).messages;
  const byContent = async (agentId: string, needle: string) => {
    const page = await mcp('get_ai_messages', { agentId, unreadOnly: false, limit: 20, compact: false });
    return page.messages.find((m: any) => m.content.content === needle);
  };

  beforeAll(() => {
    process.env.API_KEY = apiKey;
    process.env.HYTHE_AGENT_AUTH_MODE = 'observe';
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, join(directory, 'attribution.db'));
    app = (server as any).app;
    store = (server as any).agentCredentialStore;
    store.ensurePrincipal({ tenantId: 'default', agentId: credentialed, enforcementState: 'enforced', createdBy: 'contract-operator' });
    const issued = store.issueCredential({
      tenantId: 'default',
      agentId: credentialed,
      scopes: ['agent:self', 'message:read', 'message:send'],
      createdBy: 'contract-operator',
    });
    token = issued.token;
    credentialId = (issued as any).credential?.credentialId ?? (issued as any).credentialId ?? '';
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

  it('MCP send with a per-agent credential is labelled credential', async () => {
    await mcp('send_ai_message', { to: reader, content: 'mcp credential' }, credentialContext());
    const item = await byContent(reader, 'mcp credential');
    expect(item).toMatchObject({ authoredBy: credentialed, attributionSource: 'credential' });
  });

  it('MCP send with an explicit from and no credential is asserted; two agents on one shared connection read the same', async () => {
    await mcp('send_ai_message', { from: 'attr-shared-a', to: reader, content: 'shared a' });
    await mcp('send_ai_message', { from: 'attr-shared-b', to: reader, content: 'shared b' });
    expect(await byContent(reader, 'shared a')).toMatchObject({ authoredBy: 'attr-shared-a', attributionSource: 'asserted' });
    expect(await byContent(reader, 'shared b')).toMatchObject({ authoredBy: 'attr-shared-b', attributionSource: 'asserted' });
  });

  it('MCP send without from falls back to the server id: server-default', async () => {
    await mcp('send_ai_message', { to: reader, content: 'no from' });
    const item = await byContent(reader, 'no from');
    expect(item.attributionSource).toBe('server-default');
    expect(item.authoredBy).toBe(item.content.from);
  });

  it('broadcast and capability sends label every row', async () => {
    for (const [agentId, capabilities] of [['attr-bc-1', ['attr-cap']], ['attr-bc-2', ['attr-cap']]] as const) {
      await mcp('register_agent', { agentId, name: agentId, capabilities: [...capabilities] });
    }
    await mcp('send_ai_message', { from: 'attr-shared-a', broadcast: true, content: 'broadcast row' });
    await mcp('send_ai_message', { toCapabilities: ['attr-cap'], content: 'capability row' }, credentialContext());
    for (const agentId of ['attr-bc-1', 'attr-bc-2']) {
      expect(await byContent(agentId, 'broadcast row')).toMatchObject({ authoredBy: 'attr-shared-a', attributionSource: 'asserted' });
      expect(await byContent(agentId, 'capability row')).toMatchObject({ authoredBy: credentialed, attributionSource: 'credential' });
    }
  });

  it('REST POST: agent key -> credential; base key with from only -> asserted', async () => {
    await supertest(app).post('/ai-message').set('X-API-Key', apiKey).set('X-Hythe-Agent-Key', token)
      .set('Content-Type', 'application/json').send({ to: reader, content: 'rest credential' }).expect(200);
    await supertest(app).post('/ai-message').set('X-API-Key', apiKey)
      .set('Content-Type', 'application/json').send({ from: 'attr-rest-pinned', to: reader, content: 'rest asserted' }).expect(200);
    expect(await byContent(reader, 'rest credential')).toMatchObject({ authoredBy: credentialed, attributionSource: 'credential' });
    expect(await byContent(reader, 'rest asserted')).toMatchObject({ authoredBy: 'attr-rest-pinned', attributionSource: 'asserted' });
  });

  it('a message stored before attribution existed reads unknown, authoredBy the stored sender', async () => {
    const db = server.getMemoryManager().getDb();
    db.prepare(`INSERT INTO ai_messages (id, from_agent, from_source, to_agent, content, message_type, priority, created_at, tenant_id, metadata)
      VALUES (?, ?, 'mcp', ?, ?, 'info', 'normal', ?, 'default', ?)`)
      .run('attr-legacy-1', 'attr-old-sender', reader, 'legacy row', new Date().toISOString(), JSON.stringify({ original: { requestedFrom: 'attr-old-sender' } }));
    expect(await byContent(reader, 'legacy row')).toMatchObject({ authoredBy: 'attr-old-sender', attributionSource: 'unknown' });
    const detail = await mcp('get_message_detail', { messageId: 'attr-legacy-1', agentId: reader, markAsRead: false });
    expect(detail).toMatchObject({ authoredBy: 'attr-old-sender', attributionSource: 'unknown' });
  });

  it('compact list, get_message_detail and the REST mailbox all expose the labels at the top level', async () => {
    const compact = (await inbox(reader)).find((m: any) => m.authoredBy === credentialed);
    expect(compact).toMatchObject({ attributionSource: 'credential' });
    const detail = await mcp('get_message_detail', { messageId: compact.id, agentId: reader, markAsRead: false });
    expect(detail).toMatchObject({ authoredBy: credentialed, attributionSource: 'credential' });
    const rest = await supertest(app).get(`/ai-messages/${reader}?unreadOnly=false&limit=20`).set('X-API-Key', apiKey).expect(200);
    const restItem = rest.body.messages.find((m: any) => m.id === compact.id);
    expect(restItem).toMatchObject({ authoredBy: credentialed, attributionSource: 'credential' });
  });

  it('never exposes credentialId or apiKeyId', async () => {
    expect(credentialId).not.toBe('');
    const surfaces = [
      await mcp('get_ai_messages', { agentId: reader, unreadOnly: false, limit: 20, compact: false }),
      await mcp('get_ai_messages', { agentId: reader, unreadOnly: false, limit: 20, compact: true }),
      ...(await Promise.all((await inbox(reader)).map((m: any) =>
        mcp('get_message_detail', { messageId: m.id, agentId: reader, markAsRead: false })))),
      (await supertest(app).get(`/ai-messages/${reader}?unreadOnly=false&limit=20`).set('X-API-Key', apiKey)).body,
    ];
    const text = JSON.stringify(surfaces);
    expect(text).not.toContain(credentialId);
    expect(text).not.toMatch(/credentialId|apiKeyId/);
    const stored = server.getMemoryManager().getDb().prepare('SELECT metadata FROM ai_messages').all() as any[];
    expect(JSON.stringify(stored)).not.toMatch(/credentialId|apiKeyId/);
  });

  it('unit: the helper labels by the bound principal, never by the claim alone', () => {
    const ctx = { ...DEFAULT_REQUEST_CONTEXT };
    expect(messageAttribution(ctx, undefined, 'srv')).toEqual({ authoredBy: 'srv', attributionSource: 'server-default' });
    expect(messageAttribution(ctx, 'x', 'x')).toEqual({ authoredBy: 'x', attributionSource: 'asserted' });
    const withPrincipal = { ...ctx, agentPrincipal: { agentId: 'x', credentialId: 'c', scopes: [], enforcementState: 'enforced' as const } };
    expect(messageAttribution(withPrincipal, 'x', 'x').attributionSource).toBe('credential');
    expect(messageAttribution(withPrincipal, 'y', 'y').attributionSource).toBe('asserted');
    expect(readMessageAttribution({ attribution: { authoredBy: 'a', attributionSource: 'bogus' } }, 'f'))
      .toEqual({ authoredBy: 'f', attributionSource: 'unknown' });
  });
});
