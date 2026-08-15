import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

async function mcpCall(server: NeuralMCPServer, toolName: string, args: Record<string, any> = {}): Promise<any> {
  const result = await (server as any)._handleToolCall(toolName, args);
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  if (result?.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text);
}


// Step-3 (D4): the get_agent_context TOOL is retired; the internal budget
// engine remains a documented compat surface until physical removal at
// cutover, so these trimming invariants pin the ENGINE directly.
function engineContext(server: NeuralMCPServer, args: { agentId: string; projectId?: string; depth?: string; maxTokens?: number; userId?: string }): any {
  return (server as any).getMemoryManager().getAgentContext(args.agentId, args.projectId, args.depth, 'default', args.maxTokens, args.userId ?? null);
}

describe('P0 message paging and context budgets', () => {
  let server: NeuralMCPServer;

  beforeAll(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('pages every matching message exactly once and reports the true total', async () => {
    const stamp = Date.now();
    const recipient = `paging-rx-${stamp}`;
    const sender = `paging-tx-${stamp}`;

    for (let index = 0; index < 7; index += 1) {
      await mcpCall(server, 'send_ai_message', {
        from: sender,
        to: recipient,
        content: `paging message ${index}`,
        messageType: 'info',
      });
    }

    const first = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: false,
      limit: 3,
    });
    const second = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: false,
      limit: 3,
      offset: first.nextOffset,
    });
    const third = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: false,
      limit: 3,
      offset: second.nextOffset,
    });
    const beyondEnd = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: false,
      limit: 3,
      offset: 99,
    });

    expect(first).toMatchObject({ totalMessages: 7, returnedMessages: 3, hasMore: true, nextOffset: 3 });
    expect(second).toMatchObject({ totalMessages: 7, returnedMessages: 3, hasMore: true, nextOffset: 6 });
    expect(third).toMatchObject({ totalMessages: 7, returnedMessages: 1, hasMore: false, nextOffset: null });
    expect(beyondEnd).toMatchObject({ totalMessages: 7, returnedMessages: 0, hasMore: false, nextOffset: null });

    const ids = [...first.messages, ...second.messages, ...third.messages].map((message: any) => message.id);
    expect(new Set(ids).size).toBe(7);
  });

  it('counts the same exact recipient, sender, type, and archive filters used by the page query', async () => {
    const stamp = Date.now();
    const recipient = `paging-filter-rx-${stamp}`;
    const sender = `paging-filter-tx-${stamp}`;
    const otherSender = `paging-filter-other-${stamp}`;

    await mcpCall(server, 'register_agent', {
      agentId: recipient,
      name: recipient,
      capabilities: ['paging-test'],
    });
    await mcpCall(server, 'register_agent', {
      agentId: sender,
      name: sender,
      capabilities: ['paging-test'],
    });

    for (let index = 0; index < 3; index += 1) {
      await mcpCall(server, 'send_ai_message', {
        from: `${sender}-cli`,
        to: `${recipient}-cli`,
        content: `matching task ${index}`,
        messageType: 'task',
      });
    }
    await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: recipient,
      content: 'wrong type',
      messageType: 'info',
    });
    await mcpCall(server, 'send_ai_message', {
      from: otherSender,
      to: recipient,
      content: 'wrong sender',
      messageType: 'task',
    });

    const first = await mcpCall(server, 'get_ai_messages', {
      agentId: `${recipient}-cli`,
      from: `${sender}-cli`,
      messageType: 'task',
      unreadOnly: false,
      limit: 2,
    });
    expect(first).toMatchObject({ totalMessages: 3, returnedMessages: 2, hasMore: true, nextOffset: 2 });

    await mcpCall(server, 'archive_messages', {
      agentId: `${recipient}-cli`,
      messageIds: [first.messages[0].id],
    });

    const unarchived = await mcpCall(server, 'get_ai_messages', {
      agentId: `${recipient}-cli`,
      from: `${sender}-cli`,
      messageType: 'task',
      unreadOnly: false,
      limit: 20,
    });
    const withArchived = await mcpCall(server, 'get_ai_messages', {
      agentId: `${recipient}-cli`,
      from: `${sender}-cli`,
      messageType: 'task',
      unreadOnly: false,
      includeArchived: true,
      limit: 20,
    });

    expect(unarchived.totalMessages).toBe(2);
    expect(withArchived.totalMessages).toBe(3);

    const baseHandle = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      from: sender,
      messageType: 'task',
      unreadOnly: false,
      includeArchived: true,
      limit: 20,
    });
    expect(baseHandle.totalMessages).toBe(0);
  });

  it('keeps unread pagination stable when each returned page is marked read', async () => {
    const stamp = Date.now();
    const recipient = `paging-mark-rx-${stamp}`;

    for (let index = 0; index < 5; index += 1) {
      await mcpCall(server, 'send_ai_message', {
        from: `paging-mark-tx-${stamp}`,
        to: recipient,
        content: `mark page ${index}`,
      });
    }

    const first = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
    });
    const second = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
      offset: first.nextOffset,
    });
    const third = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
      offset: second.nextOffset,
    });

    expect(first).toMatchObject({ totalMessages: 5, returnedMessages: 2, hasMore: true, nextOffset: 0 });
    expect(second).toMatchObject({ totalMessages: 3, returnedMessages: 2, hasMore: true, nextOffset: 0 });
    expect(third).toMatchObject({ totalMessages: 1, returnedMessages: 1, hasMore: false, nextOffset: null });

    const ids = [...first.messages, ...second.messages, ...third.messages].map((message: any) => message.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('resets mutating unread pagination after a nonzero initial offset', async () => {
    const stamp = Date.now();
    const recipient = `paging-mark-offset-rx-${stamp}`;

    for (let index = 0; index < 5; index += 1) {
      await mcpCall(server, 'send_ai_message', {
        from: `paging-mark-offset-tx-${stamp}`,
        to: recipient,
        content: `mark offset page ${index}`,
      });
    }

    const first = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
      offset: 2,
    });
    const second = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
      offset: first.nextOffset,
    });
    const third = await mcpCall(server, 'get_ai_messages', {
      agentId: recipient,
      unreadOnly: true,
      markAsRead: true,
      limit: 2,
      offset: second.nextOffset,
    });

    expect(first).toMatchObject({ totalMessages: 5, returnedMessages: 2, hasMore: true, nextOffset: 0 });
    expect(second).toMatchObject({ totalMessages: 3, returnedMessages: 2, hasMore: true, nextOffset: 0 });
    expect(third).toMatchObject({ totalMessages: 1, returnedMessages: 1, hasMore: false, nextOffset: null });

    const ids = [...first.messages, ...second.messages, ...third.messages].map((message: any) => message.id);
    expect(new Set(ids).size).toBe(5);
    const unread = await mcpCall(server, 'get_ai_messages', { agentId: recipient, unreadOnly: true });
    expect(unread).toMatchObject({ totalMessages: 0, returnedMessages: 0, hasMore: false, nextOffset: null });
  });

  it('keeps the legacy shared-memory fallback bounded and pageable', async () => {
    const legacyServer = new NeuralMCPServer(0, ':memory:');
    try {
      const db = legacyServer.getMemoryManager().getDb();
      db.exec('DROP TABLE ai_messages');
      const insert = db.prepare(`
        INSERT INTO shared_memory
          (id, tenant_id, memory_type, content, created_by, tags, created_at)
        VALUES (?, 'default', 'ai_message', ?, ?, '[]', ?)
      `);
      const stamp = Date.now();
      const recipient = `Legacy-Page-Rx-${stamp}`;
      const sender = `Legacy-Page-Tx-${stamp}`;
      await mcpCall(legacyServer, 'register_agent', {
        agentId: recipient,
        name: recipient,
        capabilities: ['legacy-paging-test'],
      });
      await mcpCall(legacyServer, 'register_agent', {
        agentId: sender,
        name: sender,
        capabilities: ['legacy-paging-test'],
      });
      for (let index = 0; index < 7; index += 1) {
        insert.run(
          `legacy-page-${stamp}-${index}`,
          JSON.stringify({
            to: `${recipient}-cli`,
            from: `${sender}-cli`,
            content: `legacy page ${index}`,
            messageType: 'task',
          }),
          sender,
          `2026-07-12 12:00:${String(index).padStart(2, '0')}`,
        );
      }
      insert.run(`legacy-malformed-${stamp}`, '{not-json', sender, '2026-07-12 12:01:00');

      const page = await mcpCall(legacyServer, 'get_ai_messages', {
        agentId: `${recipient}-cli`,
        from: `${sender}-cli`,
        messageType: 'task',
        unreadOnly: false,
        compact: false,
        limit: 3,
        offset: 3,
      });

      expect(page).toMatchObject({
        totalMessages: 7,
        returnedMessages: 3,
        hasMore: true,
        nextOffset: 6,
      });
      expect(page.messages.map((message: any) => message.content.content)).toEqual([
        'legacy page 3',
        'legacy page 2',
        'legacy page 1',
      ]);

      const wrongCase = await mcpCall(legacyServer, 'get_ai_messages', {
        agentId: `${recipient.toLowerCase()}-cli`,
        from: `${sender.toLowerCase()}-cli`,
        messageType: 'task',
        unreadOnly: false,
        compact: false,
        limit: 20,
      });
      expect(wrongCase.totalMessages).toBe(0);
      expect(legacyServer.getMemoryManager().countUnreadMessages(`${recipient.toLowerCase()}-cli`)).toBe(0);
      expect(legacyServer.getMemoryManager().countUnreadMessages(`${recipient}-cli`)).toBe(7);

      const wrongDetail = await (legacyServer as any)._handleToolCall('get_message_detail', {
        agentId: `${recipient.toLowerCase()}-cli`,
        messageId: `legacy-page-${stamp}-0`,
        markAsRead: true,
      });
      expect(wrongDetail.isError).toBe(true);
      const exactDetail = await mcpCall(legacyServer, 'get_message_detail', {
        agentId: `${recipient}-cli`,
        messageId: `legacy-page-${stamp}-0`,
        markAsRead: false,
      });
      expect(exactDetail.content).toBe('legacy page 0');
    } finally {
      legacyServer.close();
    }
  });

  it('enforces an unadjusted hard context ceiling after trimming identity payloads', async () => {
    const agentId = `budget-agent-${Date.now()}`;
    for (let index = 0; index < 8; index += 1) {
      await mcpCall(server, 'record_learning', {
        agentId,
        context: `budget context ${index} ${'x'.repeat(300)}`,
        lesson: `budget lesson ${index} ${'y'.repeat(300)}`,
      });
    }
    await mcpCall(server, 'set_preferences', {
      agentId,
      preferences: { notes: 'z'.repeat(1200) },
    });

    const bundle = engineContext(server, { agentId, maxTokens: 160 });

    expect(bundle.identity).toBeDefined();
    expect(bundle.meta).toMatchObject({
      requestedMaxTokens: 160,
      effectiveMaxTokens: 160,
      budgetFloorApplied: false,
      truncated: true,
    });
    expect(bundle.meta.tokenEstimate).toBeLessThanOrEqual(160);
    expect(bundle.meta.tokenEstimate).toBe(Math.ceil(JSON.stringify(bundle).length / 4));
  });

  it('drops oversized project, handoff, and user context before identity', async () => {
    const stamp = Date.now();
    const agentId = `budget-priority-agent-${stamp}`;
    const projectId = `budget-priority-project-${stamp}`;

    await mcpCall(server, 'record_learning', {
      agentId,
      context: 'identity context',
      lesson: 'retain this high-priority identity learning',
    });
    await mcpCall(server, 'create_entities', {
      entities: [{
        name: projectId,
        entityType: 'project',
        observations: [`oversized project ${'p'.repeat(3000)}`],
      }],
    });
    await mcpCall(server, 'update_user_profile', {
      userId: 'tommy',
      displayName: `Oversized User ${'u'.repeat(1200)}`,
    });
    // Legacy handoff write goes straight to the engine (the end_session
    // TOOL is now the checkpoint wrapper).
    server.getMemoryManager().writeHandoff(projectId, agentId, `oversized handoff ${'h'.repeat(3000)}`, [`oversized open item ${'o'.repeat(1200)}`], 'default', null);

    const bundle = engineContext(server, { agentId, projectId, userId: 'tommy', depth: 'warm', maxTokens: 350 });

    expect(bundle.meta.tokenEstimate).toBeLessThanOrEqual(350);
    expect(bundle.meta.tokenEstimate).toBe(Math.ceil(JSON.stringify(bundle).length / 4));
    expect(bundle.identity.learnings).toHaveLength(1);
    expect(bundle.meta.sectionsDropped).toEqual(expect.arrayContaining([
      'projectSummary',
      'projectEntity',
      'handoff',
      'user',
    ]));
    expect(bundle.meta.sectionsDropped).not.toContain('learnings(trimmed)');
  });

  it('raises an impossible tiny request to an explicit minimal identity budget', async () => {
    const bundle = engineContext(server, { agentId: `tiny-budget-agent-${Date.now()}`, maxTokens: 1 });

    expect(bundle.identity).toEqual({ learnings: [] });
    expect(Object.keys(bundle).sort()).toEqual(['identity', 'meta']);
    expect(bundle.meta.requestedMaxTokens).toBe(1);
    expect(bundle.meta.effectiveMaxTokens).toBe(bundle.meta.minimumTokenBudget);
    expect(bundle.meta.effectiveMaxTokens).toBeGreaterThan(1);
    expect(bundle.meta.budgetFloorApplied).toBe(true);
    expect(bundle.meta.truncationReason).toBe('minimum_identity_envelope');
    expect(bundle.meta.sectionsDropped).toEqual(['contextBeyondIdentityEnvelope']);
    expect(bundle.meta.truncated).toBe(true);
    expect(bundle.meta.tokenEstimate).toBeLessThanOrEqual(bundle.meta.effectiveMaxTokens);
    expect(bundle.meta.tokenEstimate).toBe(Math.ceil(JSON.stringify(bundle).length / 4));
  });

  it('does not mark message previews delivered when token trimming removes them', async () => {
    const stamp = Date.now();
    const agentId = `budget-preview-agent-${stamp}`;
    const sent = await mcpCall(server, 'send_ai_message', {
      from: `budget-preview-sender-${stamp}`,
      to: agentId,
      content: `oversized preview ${'p'.repeat(1000)}`,
    });
    const messageId = sent.messageIds[0].messageId;

    const bundle = engineContext(server, { agentId, maxTokens: 160 });

    expect(bundle.unreadMessages?.messages).toBeUndefined();
    const row = server.getMemoryManager().getDb().prepare(
      'SELECT delivered_at, read_at FROM ai_messages WHERE id = ?'
    ).get(messageId) as any;
    expect(row.delivered_at).toBeNull();
    expect(row.read_at).toBeNull();
  });
});
