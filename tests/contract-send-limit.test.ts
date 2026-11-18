/**
 * Field report 8aeaee56 M8 (Manus, 2026-10-14): send_ai_message rejected
 * content over 10,000 characters, but the schema declared no maxLength and the
 * rejection was a plain "flagged by sanitizer" error that also raised a
 * security alert. The REST route allowed 100,000.
 *
 * Now: the tool schema declares maxLength 10000 on content and its alias; the
 * handler returns a structured CONTENT_TOO_LONG validation error before the
 * sanitizer runs (no flagged audit row); the REST route enforces the same
 * limit; and every layer counts Unicode code points, the unit JSON Schema
 * maxLength uses.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';
import { MAX_CONTENT_CHARS, codePointLength } from '../src/shared/limits.js';
import { MemoryManager } from '../src/unified-server/memory/index.js';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY ?? 'test-placeholder-not-a-real-key';
const SENDER = `_send_limit_sender_${Date.now()}`;
const RECIPIENT = `_send_limit_recipient_${Date.now()}`;

async function mcpCall(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return { isError: json.result?.isError === true, text: json.result?.content?.[0]?.text ?? '' };
}

async function flaggedSendRows(agentId: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/admin/audit-log?agent_id=${encodeURIComponent(agentId)}&operation=send_ai_message&limit=50`, {
    headers: { 'X-API-Key': API_KEY },
  });
  const body = await res.json();
  return (body.entries ?? []).filter((e: any) => e.flagged === 1).length;
}

const send = (extra: Record<string, unknown>) =>
  mcpCall('send_ai_message', { from: SENDER, to: RECIPIENT, messageType: 'info', ...extra });

describe('send_ai_message declared content limit (field report 8aeaee56 M8)', () => {
  beforeAll(async () => {
    for (const agentId of [SENDER, RECIPIENT]) {
      await mcpCall('register_agent', { agentId, name: agentId, capabilities: ['testing'] });
    }
  });

  it('the schema declares the enforced limit on content and its alias', () => {
    const props = (UnifiedToolSchemas.send_ai_message.inputSchema as any).properties;
    expect(props.content.maxLength).toBe(MAX_CONTENT_CHARS);
    expect(props.message.maxLength).toBe(MAX_CONTENT_CHARS);
    expect(MAX_CONTENT_CHARS).toBe(10000);
  });

  it('content exactly at the limit is sent', async () => {
    const r = await send({ content: 'a'.repeat(MAX_CONTENT_CHARS) });
    expect(r.isError).toBe(false);
  });

  it('one character over returns a structured CONTENT_TOO_LONG error, not a sanitizer flag', async () => {
    const before = await flaggedSendRows(SENDER);
    const r = await send({ content: 'a'.repeat(MAX_CONTENT_CHARS + 1) });
    expect(r.isError).toBe(true);
    const err = JSON.parse(r.text);
    expect(err).toMatchObject({
      error: 'validation_error',
      code: 'CONTENT_TOO_LONG',
      field: 'content',
      limit: 10000,
      actual: 10001,
      unit: 'characters (Unicode code points)',
    });
    expect(err.message).toContain('Nothing was sent');
    expect(r.text).not.toMatch(/flagged/i);
    expect(await flaggedSendRows(SENDER)).toBe(before);
  });

  it('the deprecated message alias reports its own field name', async () => {
    const r = await send({ message: 'b'.repeat(MAX_CONTENT_CHARS + 5) });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ code: 'CONTENT_TOO_LONG', field: 'message', actual: 10005 });
  });

  it('emoji count as one character each, matching JSON Schema maxLength', async () => {
    const emoji = '\u{1F600}'; // two UTF-16 units, one code point
    const sixThousand = emoji.repeat(6000);
    expect(sixThousand.length).toBe(12000);
    expect(codePointLength(sixThousand)).toBe(6000);
    expect(MemoryManager.sanitizeContent(sixThousand).safe).toBe(true);
    expect((await send({ content: sixThousand })).isError).toBe(false);

    const over = await send({ content: emoji.repeat(MAX_CONTENT_CHARS + 1) });
    expect(JSON.parse(over.text)).toMatchObject({ code: 'CONTENT_TOO_LONG', actual: 10001 });
  });

  it('the REST /ai-message route enforces the same limit', async () => {
    const post = (content: string) => fetch(`${BASE_URL}/ai-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ from: SENDER, to: RECIPIENT, content, messageType: 'info' }),
    });
    const over = await post('c'.repeat(MAX_CONTENT_CHARS + 1));
    expect(over.status).toBe(400);
    expect(await over.text()).toMatch(/at most 10000 characters/);
    const ok = await post('c'.repeat(MAX_CONTENT_CHARS));
    expect(ok.status).toBeLessThan(400);
  });
});
