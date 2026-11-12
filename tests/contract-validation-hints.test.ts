/**
 * Field report dc041e5c (kimi-desktop-ws01, 2026-10-13):
 *   K1: enum errors must list the allowed values.
 *   K2: wrong field names (toAgentId/fromAgentId) must name to/from.
 *
 * Found while reproducing K2: `{to, fromAgentId, content}` was SENT and
 * attributed to the server's own identity, because `from` falls back to it.
 * A misnamed field is now rejected before that fallback runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { closest, enumError, formatSchemaErrors, misnamedSendField } from '../src/shared/validation-hints.js';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';
const A = `_hints_a_${Date.now()}`;
const B = `_hints_b_${Date.now()}`;

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return { isError: json.result?.isError === true, text: json.result?.content?.[0]?.text ?? '' };
}

async function inboxOf(agentId: string): Promise<any[]> {
  const r = await call('get_ai_messages', { agentId, compact: false, unreadOnly: false, limit: 20 });
  return JSON.parse(r.text).messages ?? [];
}

const validState = { objective: 'o', status: 's', owner: A, nextActions: [], blockers: [], guardrails: [] };

describe('validation hints (field report dc041e5c K1/K2)', () => {
  beforeAll(async () => {
    for (const agentId of [A, B]) await call('register_agent', { agentId, name: agentId, capabilities: ['testing'] });
  });

  describe('K1: enum errors list the allowed values', () => {
    it("send_ai_message messageType 'inform' names the set and suggests 'info'", async () => {
      const r = await call('send_ai_message', { from: A, to: B, content: 'x', messageType: 'inform' });
      expect(r.isError).toBe(true);
      const err = JSON.parse(r.text);
      expect(err).toMatchObject({
        error: 'validation_error', code: 'INVALID_ENUM', field: 'messageType', value: 'inform',
        allowed: ['info', 'task', 'query', 'response', 'collaboration'],
      });
      expect(err.message).toBe('messageType "inform" is not allowed. Allowed values: info, task, query, response, collaboration. Did you mean "info"?');
    });

    it('send_ai_message priority lists low/normal/high/urgent', async () => {
      const r = await call('send_ai_message', { from: A, to: B, content: 'x', priority: 'medium' });
      const err = JSON.parse(r.text);
      expect(err).toMatchObject({ code: 'INVALID_ENUM', field: 'priority', allowed: ['low', 'normal', 'high', 'urgent'] });
    });

    it('resume sections: the schema error lists the allowed section names', async () => {
      const r = await call('resume', { agentId: A, scope: { project: 'p' }, budget: 4000, sections: ['workings'] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('data.sections[0] must be one of: "working", "openLoops"');
      expect(r.text).not.toContain('should be equal to one of the allowed values');
    });

    it('checkpoint fact status: the schema error lists asserted/verified/disputed/superseded', async () => {
      const r = await call('checkpoint', {
        agentId: A, scope: { project: 'p' }, expectedRevision: null, idempotencyKey: 'k-hints-0001', state: validState,
        factChanges: [{ assertion: { subject: 's', predicate: 'p', object: 'o' }, status: 'confirmed', evidenceRefs: [], sourceRefs: [] }],
      });
      expect(r.text).toContain('data.factChanges[0].status must be one of: "asserted", "verified", "disputed", "superseded"');
    });

    it('checkpoint unknown top-level field is named', async () => {
      const r = await call('checkpoint', { agentId: A, scope: { project: 'p' }, expectedRevision: null, idempotencyKey: 'k-hints-0002', state: validState, project: 'p' });
      expect(r.text).toContain('has unknown field "project"');
    });
  });

  describe('K2: misnamed send fields name the expected field and send nothing', () => {
    it('toAgentId/fromAgentId: names "to" or "from" instead of "Missing recipient"', async () => {
      const r = await call('send_ai_message', { fromAgentId: A, toAgentId: B, content: 'x' });
      expect(r.isError).toBe(true);
      const err = JSON.parse(r.text);
      expect(err.code).toBe('UNKNOWN_FIELD');
      expect(['to', 'from']).toContain(err.expected);
      expect(r.text).not.toContain('Missing recipient');
    });

    it('to + fromAgentId is rejected, not sent as the server identity', async () => {
      const before = (await inboxOf(B)).length;
      const r = await call('send_ai_message', { to: B, fromAgentId: A, content: 'should not arrive' });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.text)).toMatchObject({ code: 'UNKNOWN_FIELD', field: 'fromAgentId', expected: 'from' });
      const after = await inboxOf(B);
      expect(after.length).toBe(before);
      expect(JSON.stringify(after)).not.toContain('should not arrive');
    });

    it('a misnamed field that repeats the real one with the same value is accepted', async () => {
      const r = await call('send_ai_message', { from: A, fromAgentId: A, to: B, content: 'duplicate-but-consistent' });
      expect(r.isError).toBe(false);
    });

    it('documented aliases (agentId for to, message for content) still work', async () => {
      const r = await call('send_ai_message', { from: A, agentId: B, message: 'via documented aliases' });
      expect(r.isError).toBe(false);
    });
  });

  describe('helpers', () => {
    it('closest suggests only plausible typos', () => {
      expect(closest('inform', ['info', 'task'])).toBe('info');
      expect(closest('Taks', ['info', 'task'])).toBe('task');
      expect(closest('banana', ['info', 'task'])).toBeNull();
    });

    it('enumError without a close match gives no suggestion', () => {
      expect(enumError('priority', 'banana', ['low', 'high']).message).toBe('priority "banana" is not allowed. Allowed values: low, high.');
    });

    it('misnamedSendField flags conflicting values even when the real field is present', () => {
      expect(misnamedSendField({ from: 'a', fromAgentId: 'b' })).toMatchObject({ field: 'fromAgentId', expected: 'from' });
      expect(misnamedSendField({ from: 'a', to: 'b', content: 'c' })).toBeNull();
    });

    it('formatSchemaErrors handles empty input and unknown keywords', () => {
      expect(formatSchemaErrors(null)).toBe('no errors');
      expect(formatSchemaErrors([{ keyword: 'type', dataPath: '.budget', message: 'should be integer' }])).toBe('data.budget should be integer');
    });
  });
});
