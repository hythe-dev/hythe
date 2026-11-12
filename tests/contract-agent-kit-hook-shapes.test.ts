/**
 * Agent-kit hook text must match the live resume/checkpoint input schemas.
 *
 * Field report 524c52cb (2026-10-20): after a compaction the post-compaction
 * hook told agents to call checkpoint(agentId, content, project hint) and
 * resume(agentId); the server rejected both because checkpoint needs scope,
 * expectedRevision, idempotencyKey and state, and resume needs scope and
 * budget. The hooks now print their worked examples as strict single-line
 * JSON, and this test validates each one against the schemas the server
 * enforces, so a schema change fails here until the hook text follows it.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RESUME_INPUT_SCHEMA,
  CHECKPOINT_INPUT_SCHEMA,
} from '../src/unified-server/eng4/schemas.js';

const ROOT = join(__dirname, '..');
const SCRIPTS = join(ROOT, 'clients/agent-kit/claude-code/plugin/scripts');
const CODEX = join(ROOT, 'clients/agent-kit/codex');

const ajv = new Ajv({ allErrors: true, $data: true });
const validators = {
  resume: ajv.compile(RESUME_INPUT_SCHEMA as any),
  checkpoint: ajv.compile(CHECKPOINT_INPUT_SCHEMA as any),
};
type Tool = keyof typeof validators;

function runHook(hook: string, cwd: string): string {
  const env = { ...process.env, HYTHE_AGENT_ID: 'claude-shape-test' };
  delete env.ENGRAM_AGENT_ID;
  const result = spawnSync('bash', [join(SCRIPTS, hook)], {
    input: JSON.stringify({ cwd }),
    env,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** Every `<prefix>resume {json}` / `<prefix>checkpoint {json}` example line. */
function examples(text: string, prefix: string): { tool: Tool; args: any; line: number }[] {
  const pattern = new RegExp(`^\\s*${prefix}(resume|checkpoint) (\\{.*\\})\\s*$`);
  const found: { tool: Tool; args: any; line: number }[] = [];
  text.split('\n').forEach((raw, index) => {
    const match = pattern.exec(raw);
    if (match) found.push({ tool: match[1] as Tool, args: JSON.parse(match[2]), line: index });
  });
  return found;
}

function expectValid(tool: Tool, args: unknown): void {
  const validate = validators[tool];
  const ok = validate(args);
  expect(ok, `${tool}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe('agent-kit hook shapes (field report 524c52cb)', () => {
  it('the schema validators reject the legacy shapes the old hook text produced', () => {
    expect(validators.resume({ agentId: 'claude-shape-test' })).toBe(false);
    expect(validators.checkpoint({
      agentId: 'claude-shape-test',
      content: 'compacted summary',
      project: 'hythe-client',
    })).toBe(false);
  });

  it('post-compaction: resume then checkpoint, both schema-valid', () => {
    const out = runHook('post-compaction.sh', '/home/u/hythe-client');
    const found = examples(out, 'mcp__hythe__');
    expect(found.map((e) => e.tool)).toEqual(['resume', 'checkpoint']);
    for (const e of found) expectValid(e.tool, e.args);

    const [resume, checkpoint] = found;
    expect(resume.args.agentId).toBe('claude-shape-test');
    expect(checkpoint.args.agentId).toBe('claude-shape-test');
    expect(checkpoint.args.scope).toEqual(resume.args.scope);
    expect(checkpoint.args.scope).toEqual({ project: 'hythe-client' });
    expect(checkpoint.args.idempotencyKey).toMatch(/^claude-shape-test-compact-\d{8}T\d{6}Z$/);
    expect(out).not.toMatch(/project hint/);
  });

  it('session-start: resume and session-close checkpoint are schema-valid', () => {
    const out = runHook('session-start.sh', '/home/u/hythe-client');
    const found = examples(out, 'mcp__hythe__');
    expect(found.map((e) => e.tool)).toEqual(['resume', 'checkpoint']);
    for (const e of found) expectValid(e.tool, e.args);
    expect(out).not.toMatch(/goal, discoveries, accomplished/);
  });

  it('a hostile directory name cannot break the JSON examples', () => {
    const out = runHook('post-compaction.sh', '/tmp/My "Proj"\\x');
    const found = examples(out, 'mcp__hythe__');
    expect(found).toHaveLength(2);
    for (const e of found) {
      expectValid(e.tool, e.args);
      expect(e.args.scope.project).toMatch(/^[a-z0-9._-]+$/);
    }
  });

  it('codex compact prompt: resume then checkpoint, both schema-valid', () => {
    // The Codex prompt is static text: substitute its <agentId> placeholder
    // the way the agent must, then validate what it would send.
    const text = readFileSync(join(CODEX, 'compact-prompt.md'), 'utf8')
      .replaceAll('<agentId>', 'codex-shape-test');
    const found = examples(text, '');
    expect(found.map((e) => e.tool)).toEqual(['resume', 'checkpoint']);
    for (const e of found) expectValid(e.tool, e.args);
  });
});
