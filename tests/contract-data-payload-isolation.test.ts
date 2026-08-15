import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import supertest from 'supertest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

function backupRow(id: string, content: Record<string, any>) {
  return {
    id,
    content: JSON.stringify(content),
    created_by: 'data-boundary-test',
    tags: '[]',
  };
}

describe('/api/data private-message payload boundary', () => {
  const apiKey = `data-payload-key-${'a'.repeat(32)}`;
  const originalEnv = { ...process.env };
  let tmpDir = '';
  let server: NeuralMCPServer;
  let app: any;

  function boot() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-data-payload-'));
    process.env.API_KEY = apiKey;
    process.env.ENABLE_DATA_MANAGEMENT = '1';
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    server = new NeuralMCPServer(0, path.join(tmpDir, 'test.db'));
    app = server.getExpressApp();
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    boot();
  });

  afterEach(() => {
    server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('excludes historical message details and child observations from data export', async () => {
    const suffix = Date.now();
    const prefix = `Boundary-${suffix}`;
    const publicName = `${prefix}-Public`;
    const privateName = `${prefix}-Private`;
    const privateAlias = `boundary-private-alias-${suffix}`;
    const privateSecret = `export-private-entity-${suffix}`;
    const childSecret = `export-private-child-${suffix}`;
    const manager = server.getMemoryManager();

    const privateId = await manager.store('legacy-sender', {
      name: privateName,
      aliases: [privateAlias],
      type: 'message_detail',
      observations: [privateSecret],
    }, 'shared', 'entity', 'default');
    await manager.store('legacy-sender', {
      entityName: privateAlias,
      contents: [childSecret],
      metadata: { entityId: privateId, source: 'legacy_materialized_observation' },
    }, 'shared', 'observation', 'default');
    await manager.store('public-agent', {
      name: publicName,
      type: 'project',
      observations: [],
    }, 'shared', 'entity', 'default');
    await manager.store('public-agent', {
      entityName: publicName,
      contents: [`public observation ${suffix}`],
    }, 'shared', 'observation', 'default');

    const prefixExport = await supertest(app)
      .get('/api/data/export')
      .query({ namePrefix: prefix })
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(prefixExport.body.counts).toEqual({ entities: 1, observations: 1, relations: 0 });
    expect(prefixExport.body.entities.map((row: any) => row.id)).not.toContain(privateId);
    expect(JSON.stringify(prefixExport.body)).not.toContain(privateSecret);
    expect(JSON.stringify(prefixExport.body)).not.toContain(childSecret);
    expect(JSON.stringify(prefixExport.body)).toContain(publicName);

    const explicitPrivateExport = await supertest(app)
      .get('/api/data/export')
      .query({ entityNames: privateName })
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(explicitPrivateExport.body.counts).toEqual({ entities: 0, observations: 0, relations: 0 });
    expect(JSON.stringify(explicitPrivateExport.body)).not.toContain(privateSecret);
    expect(JSON.stringify(explicitPrivateExport.body)).not.toContain(childSecret);
  });

  it('rejects private entities and imported/existing private child references before indexing', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const db = manager.getDb();
    const existingName = `existing-private-${suffix}`;
    const existingAlias = `existing-private-alias-${suffix}`;
    const existingId = await manager.store('legacy-sender', {
      name: existingName,
      aliases: [existingAlias],
      type: 'message_detail',
      observations: [`existing private ${suffix}`],
    }, 'shared', 'entity', 'default');
    const directExistingId = `direct-existing-private-${suffix}`;
    const directExistingAlias = `direct-existing-private-alias-${suffix}`;
    db.prepare(`
      INSERT INTO shared_memory
        (id, tenant_id, memory_type, content, created_by, tags)
      VALUES (?, 'default', 'message_detail', ?, 'legacy-sender', '[]')
    `).run(directExistingId, JSON.stringify({
      name: `direct-existing-private-name-${suffix}`,
      aliases: [directExistingAlias],
      observations: [`direct existing private ${suffix}`],
    }));

    // Prime the cache to prove import invalidates it before consulting the
    // database and again after committing accepted rows.
    expect(manager.isConfidentialEntityReference(existingAlias, 'default')).toBe(true);
    expect(manager.isConfidentialEntityReference(directExistingAlias, 'default')).toBe(true);
    expect((manager as any).confidentialEntityReferenceCache.has('default')).toBe(true);

    const importedPrivateId = `imported-private-id-${suffix}`;
    const importedPrivateName = `imported-private-${suffix}`;
    const importedPrivateAlias = `imported-private-alias-${suffix}`;
    const reservedCanonicalId = `imported-reserved-canonical-id-${suffix}`;
    const reservedCanonicalName = `msg-detail-imported-project-${suffix}`;
    const reservedAliasId = `imported-reserved-alias-id-${suffix}`;
    const reservedAliasCanonical = `imported-corrupt-alias-parent-${suffix}`;
    const reservedAlias = `msg-detail-imported-alias-${suffix}`;
    const publicEntityId = `imported-public-id-${suffix}`;
    const publicObservationId = `imported-public-observation-${suffix}`;
    const publicRelationId = `imported-public-relation-${suffix}`;
    const importSecret = `blocked-import-secret-${suffix}`;
    const blockedObservations = [
      backupRow(`blocked-import-id-${suffix}`, {
        entityName: `unrelated-${suffix}`,
        contents: [importSecret],
        metadata: { entityId: importedPrivateId },
      }),
      backupRow(`blocked-import-name-${suffix}`, {
        entityName: importedPrivateName,
        contents: [importSecret],
      }),
      backupRow(`blocked-import-alias-${suffix}`, {
        entityName: importedPrivateAlias,
        contents: [importSecret],
      }),
      backupRow(`blocked-existing-id-${suffix}`, {
        entityName: `unrelated-existing-${suffix}`,
        contents: [importSecret],
        metadata: { entityId: existingId },
      }),
      backupRow(`blocked-existing-name-${suffix}`, {
        entityName: existingName,
        contents: [importSecret],
      }),
      backupRow(`blocked-existing-alias-${suffix}`, {
        entityName: existingAlias,
        contents: [importSecret],
      }),
      backupRow(`blocked-direct-existing-alias-${suffix}`, {
        entityName: directExistingAlias,
        contents: [importSecret],
      }),
      backupRow(`blocked-orphan-prefix-${suffix}`, {
        entityName: `msg-detail-orphan-${suffix}`,
        contents: [importSecret],
      }),
      backupRow(`blocked-discriminator-${suffix}`, {
        entityName: `ordinary-${suffix}`,
        type: 'message_detail',
        contents: [importSecret],
      }),
      backupRow(`blocked-reserved-canonical-child-${suffix}`, {
        entityName: reservedCanonicalName,
        contents: [importSecret],
      }),
      backupRow(`blocked-reserved-alias-parent-child-${suffix}`, {
        entityName: reservedAliasCanonical,
        contents: [importSecret],
      }),
    ];
    const blockedRelations = [
      backupRow(`blocked-relation-imported-alias-${suffix}`, {
        from: importedPrivateAlias,
        to: `imported-public-${suffix}`,
        relationType: 'private_link',
        properties: { secret: importSecret },
      }),
      backupRow(`blocked-relation-existing-alias-${suffix}`, {
        from: `imported-public-${suffix}`,
        to: existingAlias,
        relationType: 'private_link',
        properties: { secret: importSecret },
      }),
      backupRow(`blocked-relation-orphan-prefix-${suffix}`, {
        from: `msg-detail-orphan-${suffix}`,
        to: `imported-public-${suffix}`,
        relationType: 'private_link',
        properties: { secret: importSecret },
      }),
    ];

    const imported = await supertest(app)
      .post('/api/data/import')
      .set('X-API-Key', apiKey)
      .send({
        schemaVersion: 1,
        entities: [
          backupRow(importedPrivateId, {
            name: importedPrivateName,
            aliases: [importedPrivateAlias],
            entityType: 'message_detail',
            observations: [importSecret],
          }),
          backupRow(reservedCanonicalId, {
            name: reservedCanonicalName,
            entityType: 'project',
            observations: [importSecret],
          }),
          backupRow(reservedAliasId, {
            name: reservedAliasCanonical,
            aliases: [reservedAlias],
            entityType: 'analysis',
            observations: [importSecret],
          }),
          backupRow(publicEntityId, {
            name: `imported-public-${suffix}`,
            entityType: 'project',
            observations: [],
          }),
        ],
        observations: [
          ...blockedObservations,
          backupRow(publicObservationId, {
            entityName: `imported-public-${suffix}`,
            contents: [`legitimate imported observation ${suffix}`],
          }),
        ],
        relations: [
          ...blockedRelations,
          backupRow(publicRelationId, {
            from: `imported-public-${suffix}`,
            to: `imported-public-target-${suffix}`,
            relationType: 'public_link',
            properties: {},
          }),
        ],
      })
      .expect(200);

    expect(imported.body.inserted).toEqual({ entities: 1, observations: 1, relations: 1 });
    expect(imported.body.errors).toHaveLength(
      3 + blockedObservations.length + blockedRelations.length
    );
    expect(imported.body.errors.filter((error: string) =>
      error.includes('message_detail is reserved')
    )).toHaveLength(3);
    expect(imported.body.errors.filter((error: string) =>
      error.includes('references a private message_detail entity')
    )).toHaveLength(blockedObservations.length + blockedRelations.length);

    const leakedRows = db.prepare(
      `SELECT id FROM shared_memory WHERE tenant_id = ? AND content LIKE ?`
    ).all('default', `%${importSecret}%`) as any[];
    expect(leakedRows).toEqual([]);
    expect(db.prepare(
      `SELECT id FROM shared_memory WHERE tenant_id = ? AND id = ?`
    ).get('default', importedPrivateId)).toBeUndefined();
    expect(db.prepare(
      `SELECT id FROM shared_memory WHERE tenant_id = ? AND id IN (?, ?)`
    ).all('default', reservedCanonicalId, reservedAliasId)).toEqual([]);

    const indexedIds = db.prepare(
      `SELECT DISTINCT memory_id FROM graph_lookup_keys
       WHERE tenant_id = ? AND memory_id IN (?, ?, ?)`
    ).all('default', publicEntityId, publicObservationId, publicRelationId) as Array<{ memory_id: string }>;
    expect(new Set(indexedIds.map((row) => row.memory_id)))
      .toEqual(new Set([publicEntityId, publicObservationId, publicRelationId]));
    expect((manager as any).confidentialEntityReferenceCache.has('default')).toBe(false);
    expect(manager.isConfidentialEntityReference(existingAlias, 'default')).toBe(true);
  });

  it('invalidates private references around graph-index rebuilds', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const db = manager.getDb();
    const oldAlias = `rebuild-private-old-${suffix}`;
    const newAlias = `rebuild-private-new-${suffix}`;
    await manager.store('legacy-sender', {
      name: `rebuild-private-name-${suffix}`,
      aliases: [oldAlias],
      type: 'message_detail',
      observations: [`rebuild private ${suffix}`],
    }, 'shared', 'entity', 'default');
    const stored = db.prepare(
      `SELECT id, content FROM shared_memory
       WHERE tenant_id = ? AND memory_type = 'entity'
       ORDER BY created_at DESC LIMIT 1`
    ).get('default') as { id: string; content: string };
    expect(manager.isConfidentialEntityReference(oldAlias, 'default')).toBe(true);

    const content = JSON.parse(stored.content);
    content.aliases = [newAlias];
    db.prepare(
      `UPDATE shared_memory SET content = ? WHERE tenant_id = ? AND id = ?`
    ).run(JSON.stringify(content), 'default', stored.id);
    manager.rebuildGraphLookupIndex('default');

    expect((manager as any).confidentialEntityReferenceCache.has('default')).toBe(false);
    expect(manager.isConfidentialEntityReference(oldAlias, 'default')).toBe(false);
    expect(manager.isConfidentialEntityReference(newAlias, 'default')).toBe(true);
  });

  it('rebuilds private references from the restored snapshot, not the replaced database', async () => {
    const suffix = Date.now();
    const manager = server.getMemoryManager();
    const snapshotName = `snapshot-private-${suffix}`;
    const snapshotAlias = `snapshot-private-alias-${suffix}`;
    const snapshotId = await manager.store('legacy-sender', {
      name: snapshotName,
      aliases: [snapshotAlias],
      type: 'message_detail',
      observations: [`snapshot private ${suffix}`],
    }, 'shared', 'entity', 'default');
    const snapshot = await manager.createSnapshot(`payload-boundary-${suffix}`);

    // All of these values exist only after the snapshot. They exercise every
    // directly served cache branch, including branches that do not have a
    // public persistence helper of their own.
    const staleAgent = `post-snapshot-agent-${suffix}`;
    await manager.recordLearning(
      staleAgent,
      'created after snapshot',
      `post-snapshot-learning-${suffix}`,
      0.9,
      'default',
    );
    const staleTaskId = `post-snapshot-task-${suffix}`;
    await manager.store('post-snapshot-writer', {
      id: staleTaskId,
      title: 'post snapshot task',
      description: 'must disappear after restore',
    }, 'shared', 'task', 'default');
    const staleKnowledge = { id: `post-snapshot-knowledge-${suffix}`, title: 'stale', content: 'stale' };
    const staleArtifact = { id: `post-snapshot-artifact-${suffix}`, name: 'stale-artifact' };
    await manager.store('post-snapshot-writer', staleKnowledge, 'shared', 'knowledge', 'default');
    await manager.store('post-snapshot-writer', staleArtifact, 'shared', 'artifact', 'default');

    const staleShared = manager.getSharedMemory();
    staleShared.project = { id: `post-snapshot-project-${suffix}` } as any;
    staleShared.tasks.dependencies.set(staleTaskId, ['stale-dependency']);
    staleShared.tasks.assignments.set(staleTaskId, staleAgent);
    staleShared.decisions.push({ id: `post-snapshot-decision-${suffix}` } as any);

    expect(manager.getAgentMemory(staleAgent, 'default')?.learnings).toHaveLength(1);
    expect(staleShared.tasks.tasks.has(staleTaskId)).toBe(true);
    expect(staleShared.knowledge).toContain(staleKnowledge);
    expect(staleShared.artifacts).toContain(staleArtifact);

    const db = manager.getDb();
    db.prepare('DELETE FROM graph_lookup_keys WHERE tenant_id = ? AND memory_id = ?')
      .run('default', snapshotId);
    db.prepare('DELETE FROM shared_memory WHERE tenant_id = ? AND id = ?')
      .run('default', snapshotId);
    const replacementAlias = `replacement-private-alias-${suffix}`;
    await manager.store('legacy-sender', {
      name: `replacement-private-${suffix}`,
      aliases: [replacementAlias],
      type: 'message_detail',
      observations: [`replacement private ${suffix}`],
    }, 'shared', 'entity', 'default');

    (manager as any).confidentialEntityReferenceCache.clear();
    expect(manager.isConfidentialEntityReference(replacementAlias, 'default')).toBe(true);
    expect(manager.isConfidentialEntityReference(snapshotAlias, 'default')).toBe(false);
    await manager.restoreSnapshot(snapshot.snapshotId);

    expect((manager as any).confidentialEntityReferenceCache.size).toBe(0);
    expect(manager.isConfidentialEntityReference(snapshotAlias, 'default')).toBe(true);
    expect(manager.isConfidentialEntityReference(replacementAlias, 'default')).toBe(false);

    const restoredShared = manager.getSharedMemory();
    expect(restoredShared).not.toBe(staleShared);
    expect(manager.getAgentMemory(staleAgent, 'default')).toBeUndefined();
    expect(restoredShared.project).toEqual({});
    expect(restoredShared.tasks.tasks.has(staleTaskId)).toBe(false);
    expect(restoredShared.tasks.dependencies.size).toBe(0);
    expect(restoredShared.tasks.assignments.size).toBe(0);
    expect(restoredShared.decisions).toEqual([]);
    expect(restoredShared.knowledge.some((item: any) => item.id === staleKnowledge.id)).toBe(false);
    expect(restoredShared.artifacts.some((item: any) => item.id === staleArtifact.id)).toBe(false);
  });
});
