#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';

function render(): string {
  const header = [
    '# Unified MCP Tool Schemas',
    '',
    '> Generated from src/shared/toolSchemas.ts (single source of truth).',
    '',
  ].join('\n');
  const sections = Object.values(UnifiedToolSchemas).map((def) => {
    return [
      `### ${def.name}`,
      def.description,
      '',
      'Parameters',
      '',
      '```json',
      JSON.stringify(def.inputSchema, null, 2),
      '```',
      '',
    ].join('\n');
  }).join('\n');
  return header + '\n' + sections + '\n';
}

const outPath = path.resolve(process.cwd(), 'docs', 'TOOLS_SCHEMA.md');
const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
const expected = render();
if (current.trim() !== expected.trim()) {
  console.error('docs/TOOLS_SCHEMA.md is out of date. Run: npm run docs:tools');
  process.exit(1);
}
console.log('Schema docs up to date.');

