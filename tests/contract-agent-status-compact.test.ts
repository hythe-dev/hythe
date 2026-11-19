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
    expect(json).not.toHaveProperty('compact');
    expect(json).not.toHaveProperty('matchedRegistrations');
    expect(json.agents[0]).toHaveProperty('registeredAt');
    expect(json.canonicalAgents[0]).toHaveProperty('capabilities');
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
    expect(json).toMatchObject({ agentId: ids[1], status: 'active', recipient: { deliversTo: ids[1], status: 'registered' } });
    expect(json).not.toHaveProperty('capabilities');
    expect(json).not.toHaveProperty('aliases');
    expect(Object.keys(json.recipient).sort()).toEqual(['deliversTo', 'status']);
  });

  it('name also filters unregisteredAddressable', async () => {
    const { json } = await call('get_agent_status', { name: prefix, includeAddressable: true, compact: true });
    expect(json.unregisteredAddressable.map((a: any) => a.agentId)).toEqual([unregistered]);
    expect(json.totalUnregisteredAddressable).toBe(1);
  });

  it('a name that matches nothing returns empty lists, not everything', async () => {
    const { json } = await call('get_agent_status', { name: `${prefix}-zzz-none` });
    expect(json.matchedRegistrations).toBe(0);
    expect(json.agents).toEqual([]);
  });

  it('invalid compact or name is a validation error', async () => {
    for (const [args, field] of [[{ compact: 'yes' }, 'compact'], [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 5 }, 'name']] as const) {
      const { isError, json } = await call('get_agent_status', args as any);
      expect(isError).toBe(true);
      expect(json).toMatchObject({ error: 'validation_error', field });
    }
  });
});
