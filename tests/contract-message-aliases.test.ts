import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('Exact message handles', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
    const db = server.getMemoryManager().getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        legacy_shared_memory_id TEXT UNIQUE,
        from_agent TEXT NOT NULL,
        from_source TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'info',
        priority TEXT DEFAULT 'normal',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME,
        archived_at DATETIME,
        metadata TEXT,
        tenant_id TEXT DEFAULT 'default',
        from_actor_type TEXT,
        from_actor_id TEXT,
        summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ai_messages_to ON ai_messages(to_agent, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_from ON ai_messages(from_agent, created_at DESC);
    `);
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('does not deliver a cli-suffixed handle to the registered base inbox', async () => {
    const ts = Date.now();
    const receiver = `alias-rx-${ts}`;
    const sender = `alias-tx-${ts}`;

    await mcpCall(server, 'register_agent', {
      agentId: receiver,
      name: 'Alias Receiver',
      capabilities: ['testing'],
    });

    const sent = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: `${receiver}-cli`,
      content: `alias delivery ${ts}`,
      messageType: 'info',
    });

    expect(sent.sentCount).toBe(1);
    expect(sent.recipients).toContain(`${receiver}-cli`);

    const baseInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    expect(baseInbox.messages.some((message: any) => message.content.content === `alias delivery ${ts}`)).toBe(false);

    const cliInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: `${receiver}-cli`,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    const found = cliInbox.messages.find((message: any) => message.content.content === `alias delivery ${ts}`);
    expect(found).toBeTruthy();
    expect(found.content.to).toBe(`${receiver}-cli`);

    const detail = await mcpCall(server, 'get_message_detail', {
      agentId: `${receiver}-cli`,
      messageId: found.id,
      markAsRead: false,
    });
    expect(detail.to).toBe(`${receiver}-cli`);
    expect(detail.content).toBe(`alias delivery ${ts}`);
  });

  it('keeps sender filters and inbox reads exact for cli-suffixed handles', async () => {
    const ts = Date.now();
    const receiver = `alias-filter-rx-${ts}`;
    const sender = `alias-filter-tx-${ts}`;

    await mcpCall(server, 'register_agent', {
      agentId: receiver,
      name: 'Alias Filter Receiver',
      capabilities: ['testing'],
    });
    await mcpCall(server, 'register_agent', {
      agentId: sender,
      name: 'Alias Filter Sender',
      capabilities: ['testing'],
    });

    await mcpCall(server, 'send_ai_message', {
      from: `${sender}-cli`,
      to: receiver,
      content: `alias sender filter ${ts}`,
      messageType: 'info',
    });

    const baseSenderFilter = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      from: sender,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    expect(baseSenderFilter.messages.some((message: any) => message.content.content === `alias sender filter ${ts}`)).toBe(false);

    const exactSenderFilter = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      from: `${sender}-cli`,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    const found = exactSenderFilter.messages.find((message: any) => message.content.content === `alias sender filter ${ts}`);
    expect(found).toBeTruthy();
    expect(found.content.from).toBe(`${sender}-cli`);

    const cliInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: `${receiver}-cli`,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });
    expect(cliInbox.messages.some((message: any) => message.content.content === `alias sender filter ${ts}`)).toBe(false);
  });

  it('does not mark cli-addressed messages through the base inbox', async () => {
    const ts = Date.now();
    const receiver = `alias-mark-rx-${ts}`;

    await mcpCall(server, 'register_agent', {
      agentId: receiver,
      name: 'Alias Mark Receiver',
      capabilities: ['testing'],
    });

    await mcpCall(server, 'send_ai_message', {
      from: `alias-mark-tx-${ts}`,
      to: `${receiver}-cli`,
      content: `alias mark ${ts}`,
      messageType: 'info',
    });

    const marked = await mcpCall(server, 'mark_messages_read', {
      agentId: receiver,
    });
    expect(marked.markedAsRead).toBe(0);

    const unread = await mcpCall(server, 'get_ai_messages', {
      agentId: `${receiver}-cli`,
      unreadOnly: true,
      compact: false,
      limit: 10,
    });
    expect(unread.messages.some((message: any) => message.content.content === `alias mark ${ts}`)).toBe(true);

    const exactMarked = await mcpCall(server, 'mark_messages_read', {
      agentId: `${receiver}-cli`,
    });
    expect(exactMarked.markedAsRead).toBeGreaterThanOrEqual(1);
  });
});
