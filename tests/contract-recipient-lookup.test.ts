/**
 * Field feedback P1 item 1: one supported recipient lookup.
 *
 * An agent can be fully addressable (send_ai_message to it is delivered, it
 * replies) without ever registering, so get_agent_status alone made it look
 * absent. get_agent_status({resolve}) now reports the exact mailbox a send
 * lands in and a status: registered | registered-inactive | addressable |
 * alias | unknown | invalid.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listUnregisteredAddressable, resolveRecipient, type RecipientLookupDeps } from '../src/unified-server/recipient-lookup.js';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY ?? 'test-placeholder-not-a-real-key';

describe('resolveRecipient (storage)', () => {
  let manager: any;
  let deps: RecipientLookupDeps;
  const tenantId = 'default';

  const register = (agentId: string, name: string, status = 'active', metadata: Record<string, unknown> = {}) =>
    manager.getDb().prepare(
      `INSERT INTO agent_registrations (agent_id, tenant_id, name, metadata_json, status)
       VALUES (?, 'default', ?, ?, ?)`,
    ).run(agentId, name, JSON.stringify(metadata), status);

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    deps = {
      db: manager.getDb(),
      tenantId,
      mailboxAddress: (n) => manager.resolveMailboxAddress(n, tenantId),
      presentationAliases: (n) => manager.getAgentAliases(n, tenantId),
      preferredAgentId: (n) => manager.resolvePreferredAgentId(n, tenantId),
      inferCanonicalAgentId: (id, n, m) => manager.inferCanonicalAgentId(id, n, m),
      effectiveStatus: (st, m) => {
        const exp = m?.expiresAt;
        return st === 'active' && typeof exp === 'string' && Date.parse(exp) <= Date.now() ? 'expired' : (st || 'unknown');
      },
      expiresAt: (m) => (typeof m?.expiresAt === 'string' ? m.expiresAt : undefined),
    };

    register('rl-registered', 'Registered Agent');
    register('rl-stale', 'Stale Agent', 'active', { expiresAt: '2020-01-01T00:00:00.000Z' });
    register('rl-codex', 'RL Codex');
    // rl-grok never registers but talks over the mailbox, like grok in the field report.
    await manager.storeMessage('rl-grok', 'rl-registered', 'hello from an unregistered agent');
    await manager.storeMessage('rl-registered', 'rl-grok', 'reply');
    await manager.storeMessage('rl-registered', 'rl-grok', 'second reply');
  });

  afterAll(async () => { await manager.close(); });

  it('an unregistered agent that sends and receives is "addressable", not unknown (field report: grok)', () => {
    const r = resolveRecipient(deps, 'rl-grok');
    expect(r.status).toBe('addressable');
    expect(r.deliversTo).toBe('rl-grok');
    expect(r.registered).toBe(false);
    expect(r.hasMailboxHistory).toBe(true);
    expect(r.mailbox).toMatchObject({ received: 2, sent: 1 });
    expect(r.mailbox.lastActivityAt).toEqual(expect.any(String));
    expect(r.explanation).toMatch(/not listed by get_agent_status/);
  });

  it('a live registration is "registered"', () => {
    const r = resolveRecipient(deps, 'rl-registered');
    expect(r.status).toBe('registered');
    expect(r.registrationActive).toBe(true);
    expect(r.registration).toMatchObject({ agentId: 'rl-registered', status: 'active' });
    expect(r.mailbox).toMatchObject({ received: 1, sent: 2 });
  });

  it('an expired registration is "registered-inactive" and still delivered', () => {
    const r = resolveRecipient(deps, 'rl-stale');
    expect(r.status).toBe('registered-inactive');
    expect(r.deliversTo).toBe('rl-stale');
    expect(r.registration).toMatchObject({ status: 'expired', storedStatus: 'active' });
    expect(r.explanation).toMatch(/still delivered/);
  });

  it('a name that only matches a registered agent is "alias": mail would NOT reach that agent', () => {
    for (const name of ['rl-codex-cli', 'RL-Codex']) {
      const r = resolveRecipient(deps, name);
      expect(r.status).toBe('alias');
      expect(r.deliversTo).toBe(name);
      expect(r.relatedRegistrations.map((x) => x.agentId)).toEqual(['rl-codex']);
      expect(r.explanation).toMatch(/Send to the registered address instead: rl-codex/);
    }
  });

  it('the exact registered address does not list itself as related', () => {
    expect(resolveRecipient(deps, 'rl-codex').relatedRegistrations).toEqual([]);
  });

  it('a valid but unused address is "unknown"; a malformed one is "invalid"', () => {
    expect(resolveRecipient(deps, 'rl-nobody-xyz')).toMatchObject({ status: 'unknown', deliversTo: 'rl-nobody-xyz' });
    for (const bad of ['has space', '', 'x'.repeat(101), 'bad/slash', 42 as unknown as string]) {
      expect(resolveRecipient(deps, bad)).toMatchObject({ status: 'invalid', deliversTo: null });
    }
  });

  it('listUnregisteredAddressable lists mailboxes without registrations only', () => {
    const { total, addresses } = listUnregisteredAddressable(manager.getDb(), tenantId, 10);
    expect(addresses.map((a) => a.agentId)).toEqual(['rl-grok']);
    expect(total).toBe(1);
    expect(addresses[0]).toMatchObject({ registered: false, lastActivityAt: expect.any(String) });
  });

  it('listUnregisteredAddressable respects limit and reports the true total', async () => {
    await manager.storeMessage('rl-registered', 'rl-extra-a', 'x');
    await manager.storeMessage('rl-registered', 'rl-extra-b', 'x');
    const { total, addresses } = listUnregisteredAddressable(manager.getDb(), tenantId, 1);
    expect(total).toBe(3);
    expect(addresses).toHaveLength(1);
  });
});

describe('get_agent_status recipient lookup over MCP (hermetic server)', () => {
  const stamp = Date.now();
  const unregistered = `_rl_unreg_${stamp}`;
  const registered = `_rl_reg_${stamp}`;

  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: any }> {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP error: ${JSON.stringify(body.error)}`);
    const text = body.result?.content?.[0]?.text ?? '';
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { isError: body.result?.isError === true, json };
  }

  beforeAll(async () => {
    await call('register_agent', { agentId: registered, name: 'Recipient Lookup Test', capabilities: ['testing'] });
    const sent = await call('send_ai_message', { from: unregistered, to: registered, content: 'ping from an unregistered sender' });
    expect(sent.isError).toBe(false);
  });

  it('resolve: an unregistered sender is addressable, with the exact delivery address', async () => {
    const { isError, json } = await call('get_agent_status', { resolve: unregistered });
    expect(isError).toBe(false);
    expect(json.recipient).toMatchObject({ status: 'addressable', deliversTo: unregistered, registered: false });
    expect(json.recipient.mailbox.sent).toBeGreaterThanOrEqual(1);
    // resolve answers the lookup only; no registry listing.
    expect(json.agents).toBeUndefined();
  });

  it('resolve: a registered agent is "registered"', async () => {
    const { json } = await call('get_agent_status', { resolve: registered });
    expect(json.recipient).toMatchObject({ status: 'registered', registrationActive: true });
  });

  it('resolve: an empty or non-string value is a validation error', async () => {
    for (const bad of ['', 7]) {
      const { isError, json } = await call('get_agent_status', { resolve: bad });
      expect(isError).toBe(true);
      expect(json).toMatchObject({ error: 'validation_error', field: 'resolve' });
    }
  });

  it('single-agent status keeps its fields and adds the recipient block', async () => {
    const { json } = await call('get_agent_status', { agentId: unregistered });
    expect(json.status).toBe('unknown'); // registration status: unchanged
    expect(json).toHaveProperty('aliases');
    expect(json.recipient).toMatchObject({ status: 'addressable', deliversTo: unregistered });
  });

  it('listing is unchanged by default; includeAddressable adds unregistered mailboxes', async () => {
    const plain = await call('get_agent_status', { limit: 5 });
    expect(plain.json).not.toHaveProperty('unregisteredAddressable');
    expect(plain.json).toHaveProperty('agents');

    const withAddr = await call('get_agent_status', { limit: 200, includeAddressable: true });
    expect(withAddr.json.totalUnregisteredAddressable).toBeGreaterThanOrEqual(1);
    const ids = withAddr.json.unregisteredAddressable.map((a: any) => a.agentId);
    expect(ids).toContain(unregistered);
    expect(ids).not.toContain(registered);
  });
});
