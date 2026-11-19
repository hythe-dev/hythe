/**
 * Field feedback P1 item 6: get_agent_status was ~19k tokens at limit 100.
 * Opt-in compact rows and a name-prefix filter; the default is unchanged.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY ?? 'test-placeholder-not-a-real-key';

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
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
  return { isError: body.result?.isError === true, text, json };
}

describe('get_agent_status compact mode and name filter (hermetic server)', () => {
  const prefix = `_cs_${Date.now()}`;
  const ids = [`${prefix}-alpha`, `${prefix}-beta`, `${prefix}-gamma`];
  const unregistered = `${prefix}-mailbox-only`;

  beforeAll(async () => {
    for (const agentId of ids) {
      const r = await call('register_agent', { agentId, name: `Compact ${agentId}`, capabilities: ['testing', 'compact-status'] });
      expect(r.isError).toBe(false);
    }
    await call('send_ai_message', { from: unregistered, to: ids[0], content: 'ping' });
  });

  it('default listing keeps the full rows and pretty-printed JSON', async () => {
    const { json, text } = await call('get_agent_status', { limit: 5 });
    expect(text).toContain('\n  ');
    expect(Object.keys(json)).toEqual([
      'totalRegistrations', 'totalCanonicalAgents', 'returnedRegistrations', 'returnedCanonicalAgents',
      'offset', 'nextOffset', 'agents', 'canonicalAgents',
    ]);
    expect(Object.keys(json.agents[0])).toEqual(expect.arrayContaining(['agentId', 'name', 'registeredAt', 'storedStatus']));
    expect(json.canonicalAgents[0]).toHaveProperty('capabilities');
    // compact:false is the default, byte for byte.
    const explicit = await call('get_agent_status', { limit: 5, compact: false });
    expect(explicit.text).toBe(text);
  });

  it('name also matches the display name', async () => {
    const { json } = await call('get_agent_status', { name: `compact ${prefix}-be` });
    expect(json.agents.map((a: any) => a.agentId)).toEqual([`${prefix}-beta`]);
    expect(json.nameFilter).toBe(`compact ${prefix}-be`);
  });

  it('compact listing without a name filter is compact too', async () => {
    const { json, text } = await call('get_agent_status', { compact: true, limit: 3 });
    expect(text).not.toContain('\n');
    expect(json.compact).toBe(true);
    for (const a of json.agents) expect(Object.keys(a).sort()).toEqual(['agentId', 'canonicalAgentId', 'lastSeen', 'status']);
  });

  it('name filters by case-insensitive prefix before paging and the rollup', async () => {
    const { json } = await call('get_agent_status', { name: prefix.toUpperCase(), limit: 2 });
    expect(json.matchedRegistrations).toBe(3);
    expect(json.agents).toHaveLength(2);
    expect(json.nextOffset).toBe(2);
    expect(json.agents.every((a: any) => a.agentId.startsWith(prefix))).toBe(true);
    expect(json.canonicalAgents.every((c: any) => c.agentId.startsWith(prefix))).toBe(true);
    expect(json.totalRegistrations).toBeGreaterThanOrEqual(3); // unfiltered total, unchanged meaning
  });

  it('compact rows keep four fields; canonical rows add sessionCount; JSON is not pretty-printed', async () => {
    const { json, text } = await call('get_agent_status', { name: prefix, compact: true, limit: 50 });
    expect(text).not.toContain('\n');
    expect(json.compact).toBe(true);
    expect(json.agents).toHaveLength(3);
    for (const a of json.agents) {
      expect(Object.keys(a).sort()).toEqual(['agentId', 'canonicalAgentId', 'lastSeen', 'status']);
    }
    for (const c of json.canonicalAgents) {
      expect(Object.keys(c).sort()).toEqual(['agentId', 'lastSeen', 'sessionCount', 'status']);
    }
  });

  it('compact is smaller than the full response for the same rows', async () => {
    const full = await call('get_agent_status', { name: prefix, limit: 50 });
    const compact = await call('get_agent_status', { name: prefix, compact: true, limit: 50 });
    expect(compact.text.length * 2).toBeLessThan(full.text.length);
  });

  it('compact single-agent status keeps the key fields and the recipient summary', async () => {
    const { json } = await call('get_agent_status', { agentId: ids[1], compact: true });
    expect(json).toMatchObject({ agentId: ids[1], status: 'active', compact: true, recipient: { deliversTo: ids[1], status: 'registered' } });
    expect(Object.keys(json).sort()).toEqual(['agentId', 'canonicalAgentId', 'compact', 'lastSeen', 'recipient', 'status']);
    expect(json).not.toHaveProperty('capabilities');
    expect(json).not.toHaveProperty('aliases');
    expect(Object.keys(json.recipient).sort()).toEqual(['deliversTo', 'status']);
  });

  it('name also filters unregisteredAddressable', async () => {
    const { json } = await call('get_agent_status', { name: prefix, includeAddressable: true, compact: true });
    expect(json.unregisteredAddressable.map((a: any) => a.agentId)).toEqual([unregistered]);
    expect(json.totalUnregisteredAddressable).toBe(1);
  });

  it('a name that matches nothing returns empty lists and zero totals, not everything', async () => {
    const { json } = await call('get_agent_status', { name: `${prefix}-zzz-none` });
    expect(json.matchedRegistrations).toBe(0);
    expect(json.totalCanonicalAgents).toBe(0);
    expect(json.agents).toEqual([]);
    expect(json.canonicalAgents).toEqual([]);
  });

  it('compact with resolve keeps the recipient fields and only drops pretty-printing', async () => {
    const full = await call('get_agent_status', { resolve: ids[0] });
    const compact = await call('get_agent_status', { resolve: ids[0], compact: true });
    expect(compact.text).not.toContain('\n');
    expect(compact.json).toEqual(full.json);
  });

  it('invalid compact or name is a validation error in every mode, including resolve and agentId', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ compact: 'yes' }, 'compact'], [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 5 }, 'name'],
      [{ resolve: ids[0], compact: 'yes' }, 'compact'], [{ resolve: ids[0], name: '' }, 'name'], [{ resolve: ids[0], name: 42 }, 'name'],
      [{ agentId: ids[0], compact: 1 }, 'compact'],
      // name is a listing filter only.
      [{ resolve: ids[0], name: prefix }, 'name'], [{ agentId: ids[0], name: prefix }, 'name'],
    ];
    for (const [args, field] of cases) {
      const { isError, json } = await call('get_agent_status', args as any);
      expect(isError).toBe(true);
      expect(json).toMatchObject({ error: 'validation_error', field });
    }
  });
});
