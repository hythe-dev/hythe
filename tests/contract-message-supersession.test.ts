import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { UnifiedToolSchemas } from '../src/shared/toolSchemas.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

function sentId(result: any): string {
  return result.messageIds[0].messageId;
}

describe('Message supersession', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('advertises supersession inputs on send and inbox reads', async () => {
    const send = UnifiedToolSchemas.send_ai_message;
    const inbox = UnifiedToolSchemas.get_ai_messages;
    expect(send.inputSchema.properties.supersedes).toBeDefined();
    expect(inbox.inputSchema.properties.includeSuperseded).toBeDefined();
  });

  it('hides a replaced message by default and exposes its replacement on demand', async () => {
    const suffix = Date.now();
    const sender = `supersede-sender-${suffix}`;
    const receiver = `supersede-receiver-${suffix}`;

    const first = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: receiver,
      content: 'checkpoint v1',
    });
    const firstId = sentId(first);
    const second = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: receiver,
      content: 'checkpoint v2',
      supersedes: [firstId],
    });
    const secondId = sentId(second);

    const current = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    expect(current.messages.map((message: any) => message.id)).toEqual([secondId]);

    const history = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
      includeSuperseded: true,
      limit: 10,
    });
    const replaced = history.messages.find((message: any) => message.id === firstId);
    expect(replaced.content.supersededBy).toBe(secondId);
    expect(replaced.content.supersededAt).toBeTruthy();

    // Step-3: get_agent_context is retired (D4) — the unread view above via
    // get_ai_messages already proves the superseded message stays hidden.
  });

  it('does not let a different sender supersede another sender message', async () => {
    const suffix = Date.now();
    const receiver = `supersede-guard-receiver-${suffix}`;
    const first = await mcpCall(server, 'send_ai_message', {
      from: `supersede-owner-${suffix}`,
      to: receiver,
      content: 'owner checkpoint',
    });
    const firstId = sentId(first);
    const attacker = await mcpCall(server, 'send_ai_message', {
      from: `supersede-other-${suffix}`,
      to: receiver,
      content: 'unrelated checkpoint',
      supersedes: [firstId],
    });

    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    expect(inbox.messages.map((message: any) => message.id)).toEqual(
      expect.arrayContaining([firstId, sentId(attacker)])
    );
  });
});
