/**
 * Copy-paste examples in the docs must be valid requests. A review of the
 * open-loops quickstart found idempotency keys shorter than the schema's
 * minimum (8), so the walkthrough failed at its first checkpoint. This test
 * extracts every checkpoint({...}) call from fenced code blocks and validates
 * it against CHECKPOINT_INPUT_SCHEMA.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { CHECKPOINT_INPUT_SCHEMA } from '../src/unified-server/eng4/schemas.js';

const validate = new Ajv({ allErrors: true, $data: true }).compile(CHECKPOINT_INPUT_SCHEMA as any);

/** The argument text of each `checkpoint(` call inside ``` blocks, by balanced parentheses. */
function checkpointCalls(markdown: string): string[] {
  const calls: string[] = [];
  for (const block of markdown.match(/```[^\n]*\n[\s\S]*?```/g) ?? []) {
    let from = 0;
    for (;;) {
      const start = block.indexOf('checkpoint(', from);
      if (start < 0) break;
      let depth = 0;
      let inString = false;
      let i = start + 'checkpoint'.length;
      for (; i < block.length; i++) {
        const ch = block[i];
        if (inString) { if (ch === '"' && block[i - 1] !== '\\') inString = false; continue; }
        if (ch === '"') inString = true;
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) break;
      }
      calls.push(block.slice(start + 'checkpoint('.length, i));
      from = i;
    }
  }
  return calls;
}

describe('docs: checkpoint examples are valid requests', () => {
  const doc = 'docs/QUICKSTART.md';
  const calls = checkpointCalls(readFileSync(doc, 'utf8'));

  it(`${doc} has checkpoint examples`, () => {
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  calls.forEach((text, n) => {
    it(`${doc} checkpoint example #${n + 1} validates against CHECKPOINT_INPUT_SCHEMA`, () => {
      // The examples are JavaScript object literals (unquoted keys, // comments).
      const args = new Function(`return (${text});`)();
      const ok = validate(args);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    });
  });
});
