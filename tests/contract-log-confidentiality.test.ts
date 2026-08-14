import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('Confidential request logging', () => {
  it('does not serialize MCP bodies or direct-message content', () => {
    const server = source('../src/unified-neural-mcp-server.ts');

    expect(server).not.toMatch(/console\.(?:log|warn|error)\([^\n]*req\.body/);
    expect(server).not.toMatch(/console\.(?:log|warn|error)\([^\n]*actualMessage/);
    expect(server).not.toContain('message: actualMessage');
    expect(server).toContain('Unified Neural MCP request received');
    expect(server).toContain('${actualMessage.length} chars');
    expect(server).toContain('contentLength: actualMessage.length');
  });

  it('does not serialize semantic search terms', () => {
    const memory = source('../src/unified-server/memory/index.ts');

    expect(memory).not.toContain('sqlite-vec: "${query}"');
    expect(memory).toContain('queryLength: ${query.length}');
  });
});
