/**
 * ENG-3 batch 1: direct entity-name detail lookup, one-call read+archive,
 * and response token accounting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

async function mcpRaw(toolName: string, args: Record<string, any> = {}): Promise<{
  parsed: any;
  text: string;
}> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  const text = json.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`Missing tool text: ${JSON.stringify(json.result)}`);
  if (json.result?.isError) throw new Error(`Tool error: ${text}`);
  return { parsed: JSON.parse(text), text };
}

async function toolsList(): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const json = await res.json();
  return json.result?.tools || [];
}

function expectExactTokenMeta(parsed: any, text: string): void {
  expect(parsed.meta).toEqual(expect.objectContaining({
    responseCharacters: text.length,
    tokenEstimate: Math.ceil(text.length / 4),
    tokenEstimator: 'json_chars_div_4',
  }));
}

describe('ENG-3 batch 1', () => {
  const tag = Date.now();
  const entityName = `test_eng3_detail_${tag}`;
  const entityAlias = `test-eng3-alias-${tag}`;
  const largeEntityName = `test_eng3_large_${tag}`;
  let entityId = '';
  let largeEntityId = '';

  beforeAll(async () => {
    const normal = await mcpRaw('create_entities', {
      entities: [{
        name: entityName,
        entityType: 'eng3-contract',
        aliases: [entityAlias],
        observations: ['ENG-3 direct detail lookup contract fact'],
      }],
    });
    entityId = normal.parsed.entities[0].id;

    const large = await mcpRaw('create_entities', {
      entities: [{
        name: largeEntityName,
        entityType: 'eng3-contract',
        observations: [`large detail payload ${'x'.repeat(8000)}`],
      }],
    });
    largeEntityId = large.parsed.entities[0].id;
  });

  afterAll(async () => {
    for (const name of [entityName, largeEntityName]) {
      try {
        await mcpRaw('delete_entity', { entityName: name, reason: 'ENG-3 contract cleanup' });
      } catch { /* best-effort scratch-DB cleanup */ }
    }
  });

  it('advertises name inputs, a hard detail bound, and atomic archive acknowledgement', async () => {
    const tools = await toolsList();
    const detail = tools.find((tool: any) => tool.name === 'get_entity_detail');
    expect(detail.inputSchema.properties.names).toBeDefined();
    expect(detail.inputSchema.properties.entity).toBeDefined();
    expect(detail.inputSchema.properties.maxTotalSize.minimum).toBe(256);

    const archive = tools.find((tool: any) => tool.name === 'archive_messages');
    expect(archive.inputSchema.properties.markAsRead).toBeDefined();
  });

  it('resolves canonical names and aliases while preserving ID lookup', async () => {
    const canonical = await mcpRaw('get_entity_detail', { names: [entityName] });
    expect(canonical.parsed.retrieved).toBe(1);
    expect(canonical.parsed.entities[0].id).toBe(entityId);
    expect(canonical.parsed.resolution.entries[0]).toEqual(expect.objectContaining({
      input: entityName,
      inputType: 'name',
      status: 'resolved',
      id: entityId,
      matchedBy: 'canonical_name',
      retrieved: true,
    }));
    expectExactTokenMeta(canonical.parsed, canonical.text);

    const alias = await mcpRaw('get_entity_detail', { entity: entityAlias });
    expect(alias.parsed.entities[0].id).toBe(entityId);
    expect(alias.parsed.resolution.entries[0].matchedBy).toBe('alias');
    expectExactTokenMeta(alias.parsed, alias.text);

    const byId = await mcpRaw('get_entity_detail', { ids: [entityId] });
    expect(byId.parsed.entities[0].id).toBe(entityId);
    expect(byId.parsed.resolution.entries[0].matchedBy).toBe('id');
    expectExactTokenMeta(byId.parsed, byId.text);
  });

  it('enforces maxTotalSize and truncates an oversized first result when the envelope fits', async () => {
    const tooSmall = await mcpRaw('get_entity_detail', { ids: [largeEntityId], maxTotalSize: 100 });
    expect(tooSmall.text.length).toBeLessThanOrEqual(100);
    expect(tooSmall.parsed.error).toBe('maxTotalSize_too_small');

    const bounded = await mcpRaw('get_entity_detail', { ids: [largeEntityId], maxTotalSize: 1800 });
    expect(bounded.text.length).toBeLessThanOrEqual(1800);
    expect(bounded.parsed.entities).toHaveLength(1);
    expect(bounded.parsed.entities[0]).toEqual(expect.objectContaining({
      id: largeEntityId,
      _truncated: true,
    }));
    expect(bounded.parsed.truncatedEntities).toBe(1);
    expectExactTokenMeta(bounded.parsed, bounded.text);
  });

  it('reports exact serialized-output token metadata on current, neighborhood, and search reads', async () => {
    const current = await mcpRaw('get_current_observation', { entity: entityName });
    expect(current.parsed.current).toBeTruthy();
    expectExactTokenMeta(current.parsed, current.text);

    const neighborhood = await mcpRaw('get_entity_neighborhood', {
      entity: entityName,
      includeObservations: true,
      limit: 5,
    });
    expect(neighborhood.parsed.found).toBe(true);
    expectExactTokenMeta(neighborhood.parsed, neighborhood.text);

    const search = await mcpRaw('search_entities', {
      query: entityName,
      searchType: 'exact',
      limit: 5,
    });
    expect(search.parsed.returnedResults).toBeGreaterThan(0);
    expectExactTokenMeta(search.parsed, search.text);
  });

  it('marks the archived message read in the same operation and reports remaining inbox counts', async () => {
    const recipient = `test_eng3_archive_recipient_${tag}`;
    const sender = `test_eng3_archive_sender_${tag}`;
    const sent = await mcpRaw('send_ai_message', {
      from: sender,
      to: recipient,
      content: 'ENG-3 transactional archive message',
      messageType: 'info',
    });
    const messageId = sent.parsed.messageIds[0].messageId;

    const wrongInbox = await mcpRaw('archive_messages', {
      agentId: `${recipient}_wrong`,
      messageIds: [messageId],
      markAsRead: true,
    });
    expect(wrongInbox.parsed.archived).toBe(0);
    expect(wrongInbox.parsed.markedAsRead).toBe(0);

    const stillUnread = await mcpRaw('get_message_detail', {
      agentId: recipient,
      messageId,
      markAsRead: false,
    });
    expect(stillUnread.parsed.readAt).toBeNull();

    const archived = await mcpRaw('archive_messages', {
      agentId: recipient,
      messageIds: [messageId],
      markAsRead: true,
    });
    expect(archived.parsed).toEqual(expect.objectContaining({
      archived: 1,
      markedAsRead: 1,
      remainingUnarchived: 0,
      remainingUnread: 0,
      markAsRead: true,
      scope: 'specific',
    }));

    const detail = await mcpRaw('get_message_detail', {
      agentId: recipient,
      messageId,
      markAsRead: false,
    });
    expect(detail.parsed.readAt).toBeTruthy();
  });
});
