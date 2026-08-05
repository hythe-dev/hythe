#!/usr/bin/env tsx
import fs from 'fs';

const checks: { file: string; requiredSnippets: string[] }[] = [
  {
    file: 'src/unified-neural-mcp-server.ts',
    // Step-3 tool diet: tools/list is built from the single-source registry
    // (eng4/register.ts) mapping over UnifiedToolSchemas — verify THAT
    // pattern instead of per-tool literals, so retired tools can never be
    // re-added by hand without touching the registry.
    requiredSnippets: [
      'import { UnifiedToolSchemas } from',
      "from './unified-server/eng4/register.js'",
      'RETAINED_LEGACY_TOOLS.map',
      'inputSchema: UnifiedToolSchemas[name].inputSchema',
      '...ENG4_TOOLS.map',
    ],
  },
  // NOTE: src/mcp-http-server.ts was consolidated into the unified server
  // (commit 1d5f38c, "Server consolidation"); the unified server above is now
  // the sole HTTP MCP entrypoint, so there is no separate file to check here.
];

let ok = true;
for (const c of checks) {
  if (!fs.existsSync(c.file)) {
    console.error(`Missing file: ${c.file}`);
    ok = false;
    continue;
  }
  const text = fs.readFileSync(c.file, 'utf8');
  for (const snip of c.requiredSnippets) {
    if (!text.includes(snip)) {
      console.error(`Schema unification check failed: '${snip}' not found in ${c.file}`);
      ok = false;
    }
  }
}

if (!ok) process.exit(1);
console.log('Servers use unified tool schemas.');

