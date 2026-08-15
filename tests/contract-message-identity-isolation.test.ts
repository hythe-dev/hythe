import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { DEFAULT_REQUEST_CONTEXT, type RequestContext } from '../src/middleware/auth/types.js';

function requestContext(tenantId: string): RequestContext {
  return { ...DEFAULT_REQUEST_CONTEXT, tenantId };
}

async function mcpRaw(
  server: NeuralMCPServer,
  toolName: string,
  args: Record<string, any> = {},
  context: RequestContext = DEFAULT_REQUEST_CONTEXT,
): Promise<{ result: any; parsed: any }> {
  const result = await (server as any)._handleToolCall(toolName, args, context);
  const text = result?.content?.[0]?.text;
  let parsed: any = text;
  if (typeof text === 'string') {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Error responses are intentionally plain text.
    }
  }
  return { result, parsed };
}

async function mcpCall(
  server: NeuralMCPServer,
  toolName: string,
  args: Record<string, any> = {},
  context: RequestContext = DEFAULT_REQUEST_CONTEXT,
): Promise<any> {
  const response = await mcpRaw(server, toolName, args, context);
  if (response.result?.isError) {
    throw new Error(`Tool error: ${String(response.parsed)}`);
  }
  return response.parsed;
}

function sentId(result: any): string {
  return result.messageIds[0].messageId;
}

describe('Mailbox identity containment', () => {
  let server: NeuralMCPServer;
  let previousApiKey: string | undefined;

  beforeAll(() => {
    previousApiKey = process.env.API_KEY;
    process.env.API_KEY = 'identity-isolation-contract-key-with-sufficient-length';
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, ':memory:');
  });

  afterAll(() => {
    server.close();
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    delete process.env.ENABLE_ADVANCED_MEMORY;
  });

  it('keeps Houston and Hythe isolated across list, detail, read, archive, count, and supersession', async () => {
    const suffix = Date.now();
    const houston = 'codex-houston';
    const hythe = 'codex-hythe';
    const sender = `mailbox-sender-${suffix}`;
    const sharedRecipient = `mailbox-shared-rx-${suffix}`;
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', {
      agentId: houston,
      name: hythe,
      capabilities: ['testing'],
      metadata: { aliases: [hythe], canonicalAgentId: hythe },
    });
    await mcpCall(server, 'register_agent', {
      agentId: hythe,
      name: hythe,
      capabilities: ['testing'],
    });

    // Reproduce the installed-data defect: a historical identity event joined
    // two handles that are now separately active identities.
    db.prepare(`
      INSERT INTO agent_identity_changes
        (id, previous_agent_id, updated_agent_id, updated_name, capabilities_json, metadata_json, updated_by, created_at)
      VALUES (?, ?, ?, ?, '[]', '{}', 'contract-test', ?)
    `).run(`identity-${suffix}`, houston, hythe, hythe, new Date().toISOString());

    const projectName = `mailbox-identity-project-${suffix}`;
    await mcpCall(server, 'create_entities', {
      entities: [{
        name: projectName,
        entityType: 'project',
        observations: ['Identity containment checkpoint fixture'],
      }],
    });
    const houstonCheckpoint = await mcpCall(server, 'checkpoint', {
      agentId: houston,
      scope: { project: projectName },
      expectedRevision: null,
      idempotencyKey: `houston-checkpoint-${suffix}`,
      state: {
        objective: 'Prove exact ENG-4 authorship',
        status: 'houston-state',
        owner: houston,
        nextActions: [],
        blockers: [],
        guardrails: [],
      },
    });
    expect((db.prepare(
      'SELECT author, asserted_agent_id FROM eng4_state_snapshots WHERE state_id = ?'
    ).get(houstonCheckpoint.stateId) as any)).toEqual({
      author: houston,
      asserted_agent_id: houston,
    });

    const hytheCheckpoint = await mcpCall(server, 'checkpoint', {
      agentId: hythe,
      scope: { project: projectName },
      expectedRevision: houstonCheckpoint.revision,
      idempotencyKey: `hythe-checkpoint-${suffix}`,
      state: {
        objective: 'Prove distinct ENG-4 authorship',
        status: 'hythe-state',
        owner: hythe,
        nextActions: [],
        blockers: [],
        guardrails: [],
      },
    });
    expect((db.prepare(
      'SELECT author, asserted_agent_id FROM eng4_state_snapshots WHERE state_id = ?'
    ).get(hytheCheckpoint.stateId) as any)).toEqual({
      author: hythe,
      asserted_agent_id: hythe,
    });

    const direct = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: houston,
      content: `Houston-only payload ${suffix}`,
    });
    const directId = sentId(direct);

    const wrongInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: hythe,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(wrongInbox.messages.map((message: any) => message.id)).not.toContain(directId);

    const wrongDetail = await mcpRaw(server, 'get_message_detail', {
      agentId: hythe,
      messageId: directId,
      markAsRead: true,
    });
    expect(wrongDetail.result.isError).toBe(true);

    const wrongRead = await mcpCall(server, 'mark_messages_read', {
      agentId: hythe,
      messageIds: [directId],
    });
    expect(wrongRead.markedAsRead).toBe(0);

    const wrongArchive = await mcpCall(server, 'archive_messages', {
      agentId: hythe,
      messageIds: [directId],
      markAsRead: true,
    });
    expect(wrongArchive).toEqual(expect.objectContaining({ archived: 0, markedAsRead: 0 }));
    expect(server.getMemoryManager().countUnreadMessages(hythe)).toBe(0);
    expect(server.getMemoryManager().countUnreadMessages(houston)).toBe(1);

    const untouched = db.prepare(
      'SELECT delivered_at, read_at, archived_at FROM ai_messages WHERE id = ?'
    ).get(directId) as any;
    expect(untouched).toEqual(expect.objectContaining({
      delivered_at: null,
      read_at: null,
      archived_at: null,
    }));

    const exactDetail = await mcpCall(server, 'get_message_detail', {
      agentId: houston,
      messageId: directId,
      markAsRead: false,
    });
    expect(exactDetail.content).toBe(`Houston-only payload ${suffix}`);

    const exactRead = await mcpCall(server, 'mark_messages_read', {
      agentId: houston,
      messageIds: [directId],
    });
    expect(exactRead.markedAsRead).toBe(1);
    const exactArchive = await mcpCall(server, 'archive_messages', {
      agentId: houston,
      messageIds: [directId],
    });
    expect(exactArchive.archived).toBe(1);

    const senderOwned = await mcpCall(server, 'send_ai_message', {
      from: houston,
      to: sharedRecipient,
      content: `sender-owned ${suffix}`,
    });
    const senderOwnedId = sentId(senderOwned);
    await mcpCall(server, 'send_ai_message', {
      from: hythe,
      to: sharedRecipient,
      content: `different sender ${suffix}`,
      supersedes: [senderOwnedId],
    });
    expect((db.prepare('SELECT superseded_at FROM ai_messages WHERE id = ?').get(senderOwnedId) as any).superseded_at).toBeNull();

    const recipientOwned = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: houston,
      content: `recipient-owned ${suffix}`,
    });
    const recipientOwnedId = sentId(recipientOwned);
    await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: hythe,
      content: `different recipient ${suffix}`,
      supersedes: [recipientOwnedId],
    });
    expect((db.prepare('SELECT superseded_at FROM ai_messages WHERE id = ?').get(recipientOwnedId) as any).superseded_at).toBeNull();

    const exactReplacement = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: houston,
      content: `exact replacement ${suffix}`,
      supersedes: [recipientOwnedId],
    });
    expect((db.prepare('SELECT superseded_by FROM ai_messages WHERE id = ?').get(recipientOwnedId) as any).superseded_by)
      .toBe(sentId(exactReplacement));
  });

  it('ignores display names, metadata aliases, and identity events for mailbox authorization', async () => {
    const suffix = Date.now();
    const victim = `alias-victim-${suffix}`;
    const attacker = `alias-attacker-${suffix}`;
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', {
      agentId: victim,
      name: 'Victim',
      capabilities: ['testing'],
    });
    await mcpCall(server, 'register_agent', {
      agentId: attacker,
      name: victim,
      capabilities: ['testing'],
      metadata: { aliases: [victim], canonicalAgentId: victim },
    });
    db.prepare(`
      INSERT INTO agent_identity_changes
        (id, previous_agent_id, updated_agent_id, updated_name, capabilities_json, metadata_json, updated_by, created_at)
      VALUES (?, ?, ?, ?, '[]', '{}', 'contract-test', ?)
    `).run(`poison-${suffix}`, attacker, victim, victim, new Date().toISOString());

    const sent = await mcpCall(server, 'send_ai_message', {
      from: `alias-sender-${suffix}`,
      to: victim,
      content: `private victim payload ${suffix}`,
    });
    const inbox = await mcpCall(server, 'get_ai_messages', {
      agentId: attacker,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(inbox.messages.map((message: any) => message.id)).not.toContain(sentId(sent));
  });

  it('does not let tenant-B registrations poison tenant-A mailbox resolution', async () => {
    const suffix = Date.now();
    const victim = `tenant-victim-${suffix}`;
    const attacker = `tenant-attacker-${suffix}`;
    const transportBase = `tenant-transport-${suffix}`;
    const tenantA = requestContext(`tenant-a-${suffix}`);
    const tenantB = requestContext(`tenant-b-${suffix}`);
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', {
      agentId: victim,
      name: 'Tenant A Victim',
      capabilities: ['testing'],
    }, tenantA);
    await mcpCall(server, 'register_agent', {
      agentId: transportBase,
      name: 'Tenant A Transport',
      capabilities: ['testing'],
    }, tenantA);
    await mcpCall(server, 'register_agent', {
      agentId: attacker,
      name: victim,
      capabilities: ['testing'],
      metadata: { aliases: [victim], canonicalAgentId: victim },
    }, tenantB);
    await mcpCall(server, 'register_agent', {
      agentId: `${transportBase}-cli`,
      name: 'Tenant B Exact CLI',
      capabilities: ['testing'],
    }, tenantB);
    // The legacy table has no tenant column. Such a row must no longer affect
    // either tenant's mailbox resolution.
    db.prepare(`
      INSERT INTO agent_identity_changes
        (id, previous_agent_id, updated_agent_id, updated_name, capabilities_json, metadata_json, updated_by, created_at)
      VALUES (?, ?, ?, ?, '[]', '{}', 'tenant-b-contract-test', ?)
    `).run(`tenant-poison-${suffix}`, attacker, victim, victim, new Date().toISOString());

    const victimMessage = await mcpCall(server, 'send_ai_message', {
      from: `tenant-sender-${suffix}`,
      to: victim,
      content: `tenant A private payload ${suffix}`,
    }, tenantA);
    const poisonedInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: attacker,
      unreadOnly: false,
      compact: false,
      limit: 20,
    }, tenantA);
    expect(poisonedInbox.messages.map((message: any) => message.id)).not.toContain(sentId(victimMessage));

    const crossTenantInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: victim,
      unreadOnly: false,
      compact: false,
      limit: 20,
    }, tenantB);
    expect(crossTenantInbox.messages.map((message: any) => message.id)).not.toContain(sentId(victimMessage));

    const crossTenantDetail = await mcpRaw(server, 'get_message_detail', {
      agentId: victim,
      messageId: sentId(victimMessage),
      markAsRead: true,
    }, tenantB);
    expect(crossTenantDetail.result.isError).toBe(true);
    expect((await mcpCall(server, 'mark_messages_read', {
      agentId: victim,
      messageIds: [sentId(victimMessage)],
    }, tenantB)).markedAsRead).toBe(0);
    expect(await mcpCall(server, 'archive_messages', {
      agentId: victim,
      messageIds: [sentId(victimMessage)],
      markAsRead: true,
    }, tenantB)).toEqual(expect.objectContaining({ archived: 0, markedAsRead: 0 }));
    expect(server.getMemoryManager().countUnreadMessages(victim, tenantB.tenantId)).toBe(0);
    expect(server.getMemoryManager().countUnreadMessages(victim, tenantA.tenantId)).toBe(1);
    expect(db.prepare(
      'SELECT delivered_at, read_at, archived_at FROM ai_messages WHERE id = ?'
    ).get(sentId(victimMessage))).toEqual(expect.objectContaining({
      delivered_at: null,
      read_at: null,
      archived_at: null,
    }));

    const transportMessage = await mcpCall(server, 'send_ai_message', {
      from: `tenant-sender-${suffix}`,
      to: `${transportBase}-cli`,
      content: `tenant-scoped transport ${suffix}`,
    }, tenantA);
    expect(transportMessage.recipients).toContain(`${transportBase}-cli`);
    expect((db.prepare(
      'SELECT to_agent FROM ai_messages WHERE id = ?'
    ).get(sentId(transportMessage)) as any).to_agent).toBe(`${transportBase}-cli`);
  });

  it('treats transport-looking suffixes as exact handles even after registration deletion', async () => {
    const suffix = Date.now();
    const base = `transport-base-${suffix}`;
    const exactCli = `${base}-cli`;
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', {
      agentId: base,
      name: 'Transport Base',
      capabilities: ['testing'],
    });

    const beforeRegistration = await mcpCall(server, 'send_ai_message', {
      from: `transport-sender-${suffix}`,
      to: exactCli,
      content: `unregistered exact CLI identity ${suffix}`,
    });
    expect(beforeRegistration.recipients).toContain(exactCli);
    expect((db.prepare(
      'SELECT to_agent FROM ai_messages WHERE id = ?'
    ).get(sentId(beforeRegistration)) as any).to_agent).toBe(exactCli);

    await mcpCall(server, 'register_agent', {
      agentId: exactCli,
      name: 'Separately Registered CLI',
      capabilities: ['testing'],
    });
    const exact = await mcpCall(server, 'send_ai_message', {
      from: `transport-sender-${suffix}`,
      to: exactCli,
      content: `exact CLI identity ${suffix}`,
    });
    expect(exact.recipients).toContain(exactCli);

    const baseInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: base,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(baseInbox.messages.map((message: any) => message.id)).not.toContain(sentId(beforeRegistration));
    expect(baseInbox.messages.map((message: any) => message.id)).not.toContain(sentId(exact));

    await mcpCall(server, 'unregister_agent', {
      agentId: exactCli,
      reason: 'exact-handle deletion regression fixture',
    });
    const gc = await mcpCall(server, 'gc_agent_registrations', {
      dryRun: false,
      deleteExpired: false,
      inactiveOlderThanSeconds: 0,
      limit: 20,
    });
    expect(gc.deleted).toBe(1);
    expect(db.prepare(
      `SELECT agent_id FROM agent_registrations WHERE tenant_id = 'default' AND agent_id = ?`
    ).get(exactCli)).toBeUndefined();

    const afterDeletion = await mcpCall(server, 'send_ai_message', {
      from: `transport-sender-${suffix}`,
      to: exactCli,
      content: `deleted-registration exact CLI identity ${suffix}`,
    });
    expect(afterDeletion.recipients).toContain(exactCli);

    const baseAfterDeletion = await mcpCall(server, 'get_ai_messages', {
      agentId: base,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(baseAfterDeletion.messages.map((message: any) => message.id)).not.toContain(sentId(afterDeletion));

    const exactInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: exactCli,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(exactInbox.messages.map((message: any) => message.id)).toEqual(expect.arrayContaining([
      sentId(beforeRegistration),
      sentId(exact),
      sentId(afterDeletion),
    ]));
  });

  it('keeps case-distinct opaque handles isolated for mailboxes and ENG-4 authorship', async () => {
    const suffix = Date.now();
    const upper = `ReviewCase${suffix}`;
    const lower = `reviewcase${suffix}`;
    const sender = `case-sender-${suffix}`;
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', {
      agentId: upper,
      name: 'Upper Case Principal',
      capabilities: ['testing'],
    });
    await mcpCall(server, 'register_agent', {
      agentId: lower,
      name: 'Lower Case Principal',
      capabilities: ['testing'],
    });

    const upperMessage = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: upper,
      content: `upper-case private payload ${suffix}`,
    });
    const lowerMessage = await mcpCall(server, 'send_ai_message', {
      from: sender,
      to: lower,
      content: `lower-case private payload ${suffix}`,
    });

    expect((db.prepare('SELECT to_agent FROM ai_messages WHERE id = ?').get(sentId(upperMessage)) as any).to_agent).toBe(upper);
    expect((db.prepare('SELECT to_agent FROM ai_messages WHERE id = ?').get(sentId(lowerMessage)) as any).to_agent).toBe(lower);

    const upperInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: upper,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    const lowerInbox = await mcpCall(server, 'get_ai_messages', {
      agentId: lower,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(upperInbox.messages.map((message: any) => message.id)).toContain(sentId(upperMessage));
    expect(upperInbox.messages.map((message: any) => message.id)).not.toContain(sentId(lowerMessage));
    expect(lowerInbox.messages.map((message: any) => message.id)).toContain(sentId(lowerMessage));
    expect(lowerInbox.messages.map((message: any) => message.id)).not.toContain(sentId(upperMessage));

    const beforeWrongCaseDetail = db.prepare(
      'SELECT delivered_at, read_at, archived_at FROM ai_messages WHERE id = ?'
    ).get(sentId(upperMessage));
    const wrongCaseDetail = await mcpRaw(server, 'get_message_detail', {
      agentId: lower,
      messageId: sentId(upperMessage),
      markAsRead: true,
    });
    expect(wrongCaseDetail.result.isError).toBe(true);
    expect(db.prepare(
      'SELECT delivered_at, read_at, archived_at FROM ai_messages WHERE id = ?'
    ).get(sentId(upperMessage))).toEqual(beforeWrongCaseDetail);

    const project = `case-principal-project-${suffix}`;
    await mcpCall(server, 'create_entities', {
      entities: [{ name: project, entityType: 'project', observations: ['Case-sensitive author fixture'] }],
    });
    const upperCheckpoint = await mcpCall(server, 'checkpoint', {
      agentId: upper,
      scope: { project },
      expectedRevision: null,
      idempotencyKey: `case-upper-${suffix}`,
      state: {
        objective: 'Keep exact author case',
        status: 'upper',
        owner: upper,
        nextActions: [],
        blockers: [],
        guardrails: [],
      },
    });
    const lowerCheckpoint = await mcpCall(server, 'checkpoint', {
      agentId: lower,
      scope: { project },
      expectedRevision: upperCheckpoint.revision,
      idempotencyKey: `case-lower-${suffix}`,
      state: {
        objective: 'Keep distinct lower-case author',
        status: 'lower',
        owner: lower,
        nextActions: [],
        blockers: [],
        guardrails: [],
      },
    });
    expect(db.prepare(
      'SELECT author FROM eng4_state_snapshots WHERE state_id = ?'
    ).get(upperCheckpoint.stateId)).toEqual({ author: upper });
    expect(db.prepare(
      'SELECT author FROM eng4_state_snapshots WHERE state_id = ?'
    ).get(lowerCheckpoint.stateId)).toEqual({ author: lower });
    expect(server.getMemoryManager().resolveCanonicalAgent(upper).canonical).toBe(upper);
    expect(server.getMemoryManager().resolveCanonicalAgent(lower).canonical).toBe(lower);
  });

  it('preserves exact principals through capability and broadcast recipient routing', async () => {
    const suffix = Date.now();
    const capabilityTenant = requestContext(`route-cap-tenant-${suffix}`);
    const routeBase = `RouteBase${suffix}`;
    const routeCli = `${routeBase}-cli`;
    const routeLower = routeBase.toLowerCase();
    const capability = `exact-route-${suffix}`;

    for (const agentId of [routeBase, routeCli, routeLower]) {
      await mcpCall(server, 'register_agent', {
        agentId,
        name: agentId,
        capabilities: [capability],
      }, capabilityTenant);
    }

    const capabilitySend = await mcpCall(server, 'send_ai_message', {
      from: routeBase,
      toCapabilities: [capability],
      content: `capability exact routing ${suffix}`,
      excludeSelf: true,
    }, capabilityTenant);
    expect(capabilitySend.recipients.sort()).toEqual([routeCli, routeLower].sort());
    const capabilityRows = server.getMemoryManager().getDb().prepare(
      `SELECT to_agent FROM ai_messages WHERE tenant_id = ? AND content = ? ORDER BY to_agent`
    ).all(capabilityTenant.tenantId, `capability exact routing ${suffix}`) as Array<{ to_agent: string }>;
    expect(capabilityRows.map((row) => row.to_agent).sort()).toEqual([routeCli, routeLower].sort());

    const broadcastTenant = requestContext(`route-broadcast-tenant-${suffix}`);
    const broadcastBase = `broadcast-base-${suffix}`;
    const broadcastCli = `${broadcastBase}-cli`;
    for (const agentId of [broadcastBase, broadcastCli]) {
      await mcpCall(server, 'register_agent', {
        agentId,
        name: agentId,
        capabilities: ['broadcast-fixture'],
      }, broadcastTenant);
    }
    const broadcastSend = await mcpCall(server, 'send_ai_message', {
      from: broadcastBase,
      broadcast: true,
      content: `broadcast exact routing ${suffix}`,
      excludeSelf: true,
    }, broadcastTenant);
    expect(broadcastSend.recipients).toEqual([broadcastCli]);
    expect((server.getMemoryManager().getDb().prepare(
      `SELECT to_agent FROM ai_messages WHERE tenant_id = ? AND content = ?`
    ).get(broadcastTenant.tenantId, `broadcast exact routing ${suffix}`) as any).to_agent).toBe(broadcastCli);
  });

  it('rejects invalid exact handles without storing or reflecting their values', async () => {
    const suffix = Date.now();
    const valid = `valid-handle-${suffix}`;
    const invalid = `invalid identity ${suffix}`;
    const db = server.getMemoryManager().getDb();
    await mcpCall(server, 'register_agent', {
      agentId: valid,
      name: 'Valid Handle',
      capabilities: ['testing'],
    });
    const registrationsBefore = (db.prepare(
      `SELECT COUNT(*) AS count FROM agent_registrations WHERE tenant_id = 'default'`
    ).get() as any).count;
    const messagesBefore = (db.prepare(
      `SELECT COUNT(*) AS count FROM ai_messages WHERE tenant_id = 'default'`
    ).get() as any).count;

    const invalidRegistration = await mcpRaw(server, 'register_agent', {
      agentId: invalid,
      name: 'Invalid Handle',
      capabilities: ['testing'],
    });
    expect(invalidRegistration.result.isError).toBe(true);
    expect(String(invalidRegistration.parsed)).not.toContain(invalid);

    for (const args of [
      { from: invalid, to: valid, content: `invalid sender ${suffix}` },
      { from: valid, to: invalid, content: `invalid recipient ${suffix}` },
    ]) {
      const rejected = await mcpRaw(server, 'send_ai_message', args);
      expect(rejected.result.isError).toBe(true);
      expect(String(rejected.parsed)).not.toContain(invalid);
    }

    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM agent_registrations WHERE tenant_id = 'default'`
    ).get() as any).count).toBe(registrationsBefore);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM ai_messages WHERE tenant_id = 'default'`
    ).get() as any).count).toBe(messagesBefore);
    const invalidInbox = await mcpRaw(server, 'get_ai_messages', {
      agentId: invalid,
      unreadOnly: false,
      compact: false,
      limit: 20,
    });
    expect(invalidInbox.result.isError).toBe(true);
    expect(String(invalidInbox.parsed)).not.toContain(invalid);
    for (const toolName of ['mark_messages_read', 'archive_messages']) {
      const rejected = await mcpRaw(server, toolName, { agentId: invalid });
      expect(rejected.result.isError).toBe(true);
      expect(String(rejected.parsed)).not.toContain(invalid);
    }
  });

  it('rejects untrusted message type and priority values before logging or storage', async () => {
    const suffix = Date.now();
    const secret = `private-message-metadata-${suffix}`;
    const db = server.getMemoryManager().getDb();
    const before = (db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of [
      { messageType: `info]\n${secret}`, priority: 'normal' },
      { messageType: 'info', priority: `urgent]\n${secret}` },
    ]) {
      const rejected = await mcpRaw(server, 'send_ai_message', {
        from: `metadata-sender-${suffix}`,
        to: `metadata-recipient-${suffix}`,
        content: 'non-secret body',
        ...args,
      });
      expect(rejected.result.isError).toBe(true);
      expect(String(rejected.parsed)).not.toContain(secret);
    }
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret);
    logSpy.mockRestore();
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count).toBe(before);
  });

  it('freezes legacy identity mutation without inserting another authorization edge', async () => {
    const db = server.getMemoryManager().getDb();
    const before = (db.prepare('SELECT COUNT(*) AS count FROM agent_identity_changes').get() as any).count;
    const response = await mcpRaw(server, 'set_agent_identity', {
      currentAgentId: 'legacy-a',
      newAgentId: 'legacy-b',
    });
    expect(response.result.isError).toBe(true);
    expect(String(response.parsed)).toMatch(/temporarily disabled|principal/i);
    const after = (db.prepare('SELECT COUNT(*) AS count FROM agent_identity_changes').get() as any).count;
    expect(after).toBe(before);
  });

  it('applies the same exact mailbox routing to the HTTP send/read surface', async () => {
    const suffix = Date.now();
    const houston = `http-houston-${suffix}`;
    const hythe = `http-hythe-${suffix}`;
    const app = (server as any).app;
    const db = server.getMemoryManager().getDb();

    await mcpCall(server, 'register_agent', { agentId: houston, name: 'HTTP Houston', capabilities: ['testing'] });
    await mcpCall(server, 'register_agent', { agentId: hythe, name: 'HTTP Hythe', capabilities: ['testing'] });
    db.prepare(`
      INSERT INTO agent_identity_changes
        (id, previous_agent_id, updated_agent_id, updated_name, capabilities_json, metadata_json, updated_by, created_at)
      VALUES (?, ?, ?, ?, '[]', '{}', 'contract-test', ?)
    `).run(`http-identity-${suffix}`, houston, hythe, hythe, new Date().toISOString());

    const status = await mcpCall(server, 'get_agent_status', { agentId: hythe });
    expect(status.aliases).not.toContain(houston);

    const maliciousType = `info]\nprivate-type-${suffix}`;
    const messagesBeforeInvalidType = (db.prepare(
      'SELECT COUNT(*) AS count FROM ai_messages'
    ).get() as any).count;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const invalidType = await supertest(app)
      .post('/ai-message')
      .set('X-API-Key', process.env.API_KEY!)
      .set('Content-Type', 'application/json')
      .send({ from: `http-sender-${suffix}`, to: houston, content: 'body', type: maliciousType })
      .expect(400);
    expect(invalidType.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(invalidType.body)).not.toContain(maliciousType);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(maliciousType);
    logSpy.mockRestore();
    expect((db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get() as any).count)
      .toBe(messagesBeforeInvalidType);

    const sent = await supertest(app)
      .post('/ai-message')
      .set('X-API-Key', process.env.API_KEY!)
      .set('Content-Type', 'application/json')
      .send({ from: `http-sender-${suffix}`, to: houston, content: `HTTP private ${suffix}` })
      .expect(200);

    expect((db.prepare('SELECT to_agent FROM ai_messages WHERE id = ?').get(sent.body.messageId) as any).to_agent).toBe(houston);

    const invalidHttpIdentity = `invalid identity ${suffix}`;
    for (const path of [
      `/ai-messages/${encodeURIComponent(invalidHttpIdentity)}?unreadOnly=false&limit=20`,
      `/ai-messages/${encodeURIComponent(houston)}?unreadOnly=false&limit=20&from=${encodeURIComponent(invalidHttpIdentity)}`,
    ]) {
      const rejected = await supertest(app)
        .get(path)
        .set('X-API-Key', process.env.API_KEY!)
        .expect(400);
      expect(JSON.stringify(rejected.body)).not.toContain(invalidHttpIdentity);
    }
    expect(db.prepare(
      'SELECT delivered_at, read_at, archived_at FROM ai_messages WHERE id = ?'
    ).get(sent.body.messageId)).toEqual(expect.objectContaining({
      delivered_at: null,
      read_at: null,
      archived_at: null,
    }));

    const wrong = await supertest(app)
      .get(`/ai-messages/${encodeURIComponent(hythe)}?unreadOnly=false&limit=20`)
      .set('X-API-Key', process.env.API_KEY!)
      .expect(200);
    expect(wrong.body.messages.map((message: any) => message.id)).not.toContain(sent.body.messageId);

    const exact = await supertest(app)
      .get(`/ai-messages/${encodeURIComponent(houston)}?unreadOnly=false&limit=20`)
      .set('X-API-Key', process.env.API_KEY!)
      .expect(200);
    expect(exact.body.messages.map((message: any) => message.id)).toContain(sent.body.messageId);
  });
});
