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

describe('Message alias resolution', () => {
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

  it('delivers cli-addressed messages to the registered canonical agent inbox', async () => {
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
    expect(sent.recipients).toContain(receiver);

    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });

    const found = inbox.messages.find((message: any) => message.content.content === `alias delivery ${ts}`);
    expect(found).toBeTruthy();
    expect(found.content.to).toBe(receiver);

    const detail = await mcpCall(server, 'get_message_detail', {
      agentId: receiver,
      messageId: found.id,
      markAsRead: false,
    });
    expect(detail.to).toBe(receiver);
    expect(detail.content).toBe(`alias delivery ${ts}`);
  });

  it('supports canonical sender filters and alias inbox reads for cli-suffixed senders', async () => {
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

    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: `${receiver}-cli`,
      from: sender,
      unreadOnly: false,
      compact: false,
      limit: 10,
    });

    const found = inbox.messages.find((message: any) => message.content.content === `alias sender filter ${ts}`);
    expect(found).toBeTruthy();
    expect(found.content.from).toBe(sender);
  });

  it('marks alias-addressed messages as read through the canonical inbox', async () => {
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
    expect(marked.markedAsRead).toBeGreaterThanOrEqual(1);

    const unread = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: true,
      compact: false,
      limit: 10,
    });
    expect(unread.messages.some((message: any) => message.content.content === `alias mark ${ts}`)).toBe(false);
  });
});
