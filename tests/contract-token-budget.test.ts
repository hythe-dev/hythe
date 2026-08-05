/**
 * Task 1400: Token Budget Ceiling Upgrade Contract Tests
 *
 * Verifies maxTokens parameter on get_agent_context and begin_session,
 * priority-based truncation, and meta.truncated / meta.sectionsDropped.
 */
import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY || 'IzMklkUkoJv+Thkjp+4B9DVqYYkzHCKQCBJD5dzOW0g=';

async function mcpCall(toolName: string, args: Record<string, any> = {}): Promise<any> {
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
  if (!text) return json.result;
  if (json.result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('Token Budget Ceiling (Task 1400)', () => {
  const testAgent = `budget_test_${Date.now()}`;

  // Step-3 (D4): the budget ceiling now lives in resume's coverage
  // accounting — the adapter maps legacy maxTokens onto the hard budget.
  it('begin_session defaults to the 4000-token budget and never exceeds it', async () => {
    const bundle = await mcpCall('begin_session', { agentId: testAgent, projectId: `budget_proj_${Date.now()}` });
    expect(bundle.coverage.budget).toBe(4000);
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(4000);
  });

  it('begin_session respects an explicit maxTokens budget', async () => {
    const bundle = await mcpCall('begin_session', { agentId: testAgent, projectId: `budget_proj_${Date.now()}`, maxTokens: 8000 });
    expect(bundle.coverage.budget).toBe(8000);
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(8000);
  });

  it('a tiny explicit maxTokens clamps to the 256 wrapper floor, preserving intent', async () => {
    const bundle = await mcpCall('begin_session', { agentId: testAgent, projectId: `budget_proj_${Date.now()}`, maxTokens: 50 });
    expect(bundle.coverage.budget).toBe(256);
    expect(bundle.coverage.totalTokenEstimate).toBeLessThanOrEqual(256);
  });

  it('resume accepts the budget directly and its coverage is CLOSED over all seven sections', async () => {
    const bundle = await mcpCall('resume', { agentId: testAgent, scope: { project: 'anything' }, budget: 4000 });
    for (const section of ['working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers']) {
      expect(bundle.coverage[section]).toBeDefined();
      expect(bundle.coverage[section].includedCount).toBeLessThanOrEqual(bundle.coverage[section].totalCount);
    }
  });

  it('the get_agent_context migration error names the replacement', async () => {
    await expect(mcpCall('get_agent_context', { agentId: 'unified-neural-mcp-server' }))
      .rejects.toThrow(/replaced by 'resume'/);
  });
});
