/**
 * ENG-2: compact_memory contract tests (live-safe — dry-run only; the only
 * execute calls asserted here are the ones the server must REJECT).
 */
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

async function mcpCallRaw(toolName: string, args: Record<string, any> = {}): Promise<{ body: any; isError: boolean }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  const text = json.result?.content?.[0]?.text;
  return { body: text ? JSON.parse(text) : json.result, isError: !!json.result?.isError };
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

describe('compact_memory (ENG-2)', () => {
  it('is retired from DISCOVERY (Step-3 diet: admin op → operator runbook) with the schema still pinned at source', async () => {
    const tools = await toolsList();
    expect(tools.find((t: any) => t.name === 'compact_memory')).toBeUndefined();
    // The handler (exercised by every test below) still validates against
    // the unified schema — pin its shape at the source of truth.
    const { UnifiedToolSchemas } = await import('../src/shared/toolSchemas.js');
    const schema = UnifiedToolSchemas.compact_memory.inputSchema as any;
    expect(schema.properties.mode.enum).toEqual(['dry-run', 'execute']);
    expect(schema.properties.classes).toBeDefined();
    expect(schema.properties.confirm).toBeDefined();
  });

  it('dry-run (default mode) returns a full four-class report with executed:false everywhere', async () => {
    const { body, isError } = await mcpCallRaw('compact_memory', {
      spotCheckKeys: ['engram', 'engram-tool-audit'],
    });
    expect(isError).toBe(false);
    expect(body.mode).toBe('dry-run');
    expect(body.dbBefore.dbBytes).toBeGreaterThan(0);
    expect(body.dbBefore.quickCheck).toBe('ok');
    expect(body.dbAfter).toBeUndefined();

    expect(body.indexDiet.executed).toBe(false);
    expect(body.indexDiet.currentRows).toBeGreaterThan(0);
    expect(typeof body.indexDiet.prospectiveRows).toBe('number');
    for (const spot of body.indexDiet.spotCheck) {
      expect(spot.prospectiveRows).toBeGreaterThanOrEqual(0);
    }

    expect(body.superseded.executed).toBe(false);
    expect(typeof body.superseded.candidateRows).toBe('number');
    expect(Array.isArray(body.superseded.candidateSample)).toBe(true);
    expect(Array.isArray(body.superseded.malformedSupersedes)).toBe(true);

    expect(body.vecOrphans.executed).toBe(false);
    expect(typeof body.vecOrphans.orphanRows).toBe('number');

    expect(body.messageArchive.executed).toBe(false);
    expect(typeof body.messageArchive.candidates).toBe('number');

    expect(body.note).toContain('VACUUM');
  });

  it('classes selector limits the report', async () => {
    const { body } = await mcpCallRaw('compact_memory', { classes: ['vec-orphans'] });
    expect(body.vecOrphans).toBeDefined();
    expect(body.indexDiet).toBeUndefined();
    expect(body.superseded).toBeUndefined();
    expect(body.messageArchive).toBeUndefined();
  });

  it('execute without confirm:true is rejected', async () => {
    const { body, isError } = await mcpCallRaw('compact_memory', {
      mode: 'execute',
      classes: ['vec-orphans'],
    });
    // Either the key lacks admin scope (Unauthorized) or confirmation is
    // demanded — in NO case may the execute proceed.
    expect(isError).toBe(true);
    expect(body.error).toMatch(/Unauthorized|Confirmation required/);
  });

  it('rejects an empty/unknown classes list', async () => {
    const { body, isError } = await mcpCallRaw('compact_memory', { classes: ['nonsense'] });
    expect(isError).toBe(true);
    expect(body.error).toContain('classes');
  });
});
