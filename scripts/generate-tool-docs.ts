#!/usr/bin/env tsx
import { UnifiedToolSchemas, ToolDefinition } from '../src/shared/toolSchemas.js';
import fs from 'fs';
import path from 'path';

const outPath = path.resolve(process.cwd(), 'docs', 'TOOLS_SCHEMA.md');

function schemaToMarkdown(def: ToolDefinition): string {
  const lines: string[] = [];
  lines.push(`### ${def.name}`);
  lines.push(def.description);
  lines.push('');
  lines.push('Parameters');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(def.inputSchema, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const all = Object.values(UnifiedToolSchemas);
  const header = [
    '# Unified MCP Tool Schemas',
    '',
    '> Generated from src/shared/toolSchemas.ts (single source of truth).',
    '',
  ].join('\n');
  const body = all.map(schemaToMarkdown).join('\n');
  const content = header + '\n' + body + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
}

main();

