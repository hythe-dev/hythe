import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}

describe('Honest message delivery lifecycle', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('keeps an offline message queued until the recipient fetches it', async () => {
    const suffix = Date.now();
    const receiver = `delivery-receiver-${suffix}`;
    const sent = await mcpCall(server, 'send_ai_message', {
      from: `delivery-sender-${suffix}`,
      to: receiver,
      content: 'queued until fetched',
    });
    const messageId = sent.messageIds[0].messageId;

    expect(sent.messageIds[0].deliveryStatus).toBe('queued');
    expect(sent.delivery).toEqual({ persisted: 1, delivered: 0, queued: 1, clientsNotified: 0 });
    expect(sent.deliveryTime).toBeUndefined();
    expect(sent.features).toBeUndefined();

    const before = server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at, read_at FROM ai_messages WHERE id = ?'
    ).get(messageId) as any;
    expect(before.delivered_at).toBeNull();
    expect(before.read_at).toBeNull();

    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
    });
    expect(inbox.messages[0].content.deliveryStatus).toBe('delivered');
    expect(inbox.metadata.searchPerformance).toBeUndefined();
    expect(inbox.metadata.crossPlatformAccess).toBeUndefined();

    const after = server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at, read_at FROM ai_messages WHERE id = ?'
    ).get(messageId) as any;
    expect(after.delivered_at).toBeTruthy();
    expect(after.read_at).toBeNull();
  });

  it('treats an explicit mark-read action as both delivered and read', async () => {
    const suffix = Date.now();
    const receiver = `read-receiver-${suffix}`;
    const sent = await mcpCall(server, 'send_ai_message', {
      from: `read-sender-${suffix}`,
      to: receiver,
      content: 'read without an inbox scan',
    });
    const messageId = sent.messageIds[0].messageId;

    const marked = await mcpCall(server, 'mark_messages_read', {
      agentId: receiver,
      messageIds: [messageId],
    });
    expect(marked.markedAsRead).toBe(1);

    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: receiver,
      unreadOnly: false,
      compact: false,
    });
    const message = inbox.messages.find((candidate: any) => candidate.id === messageId);
    expect(message.content.deliveryStatus).toBe('read');
  });
});
