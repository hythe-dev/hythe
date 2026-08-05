/**
 * ENG-2: compact_memory unit tests against a scratch DB.
 *
 * Covers the four reclaim classes at the MemoryManager level:
 *  A index-diet — handle extraction no longer fabricates company-suffix
 *    variants for content handles, per-memory key cap holds, analyze reports
 *    the reduction, rebuild applies it, and known-good keys survive.
 *  B superseded — marked-only candidates, never-reclaim-current guard,
 *    malformed non-array supersedes reported not reclaimed, trash restore
 *    round-trip.
 *  C vec-orphans — orphaned vector rows counted and deleted.
 *  D message-archive — read+old messages flagged, unread/new left alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

process.env.ENABLE_ADVANCED_MEMORY = 'false';

const { MemoryManager } = await import('../src/unified-server/memory/index.js');

let workDir: string;
let manager: any;

function db(): any { return (manager as any).db; }

async function storeObservation(entityName: string, body: string, metadata: Record<string, any> = {}): Promise<string> {
  return manager.store('unit-test', {
    entityName,
    contents: [body],
    addedBy: 'unit-test',
    timestamp: new Date().toISOString(),
    metadata: { ...metadata, canonicalEntityKey: manager.canonicalEntityKey(entityName) },
  }, 'shared', 'observation');
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng2-unit-'));
  manager = new MemoryManager(path.join(workDir, 'test.db'));
});

afterAll(() => {
  try { db().close(); } catch { /* ignore */ }
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('Class A — index diet', () => {
  it('content handles are indexed plain: no fabricated company-suffix variants', async () => {
    await storeObservation('diet_entity', 'we fixed the emulator-dev pipeline in a multi-step rollout');
    const suffixJunk = db().prepare(`
      SELECT COUNT(*) AS c FROM graph_lookup_keys
      WHERE lookup_key IN ('emulator-dev-llc','emulator-dev-inc','emulator-dev-corp','emulator-dev-co','emulator-dev-company',
                           'multi-step-llc','multi-step-inc','multi-step-corp','multi-step-co','multi-step-company')
    `).get().c;
    expect(suffixJunk).toBe(0);
    // The plain handles themselves are still indexed
    const plain = db().prepare(
      "SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE lookup_key IN ('emulator-dev','multi-step')"
    ).get().c;
    expect(plain).toBeGreaterThanOrEqual(2);
  });

  it('entity names and aliases keep their variants', async () => {
    await manager.store('unit-test', {
      name: 'Acme Blenders',
      type: 'company',
      aliases: ['acme-mix'],
      observations: [],
    }, 'shared', 'entity');
    const nameVariants = db().prepare(
      "SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE lookup_key IN ('acme-blenders-llc','acme-blenders-inc')"
    ).get().c;
    expect(nameVariants).toBe(2);
  });

  it('caps lookup keys per memory at MAX_LOOKUP_KEYS_PER_MEMORY, keeping highest weight', async () => {
    const manyHandles = Array.from({ length: 200 }, (_, i) => `handle-token-${i}-part`).join(' ');
    const obsId = await storeObservation('cap_entity', manyHandles);
    const keyCount = db().prepare(
      'SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE memory_id = ?'
    ).get(obsId).c;
    expect(keyCount).toBeLessThanOrEqual(MemoryManager.MAX_LOOKUP_KEYS_PER_MEMORY);
    // entity_name (weight 95) must survive the cap
    const entityKey = db().prepare(
      "SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE memory_id = ? AND key_kind = 'entity_name'"
    ).get(obsId).c;
    expect(entityKey).toBeGreaterThanOrEqual(1);
  });

  it('analyze + rebuild: junk rows counted, removed, spot-check keys survive', async () => {
    // Simulate legacy bloat: hand-insert fabricated variant rows as if written
    // by the old policy.
    const legacyId = await storeObservation('legacy_entity', 'legacy content mentioning acme-widget here');
    const ins = db().prepare(`
      INSERT OR IGNORE INTO graph_lookup_keys (tenant_id, lookup_key, memory_type, memory_id, key_kind, weight)
      VALUES ('default', ?, 'observation', ?, 'observation_handle', 75)
    `);
    for (const junk of ['acme-widget-llc', 'acme-widget-inc', 'acme-widget-corp', 'acme-widget-co', 'acme-widget-company']) {
      ins.run(junk, legacyId);
    }

    const analysis = manager.compactAnalyzeIndexDiet(['legacy_entity', 'diet_entity']);
    expect(analysis.currentRows).toBeGreaterThan(analysis.prospectiveRows);
    expect(analysis.reductionRows).toBeGreaterThanOrEqual(5);
    for (const spot of analysis.spotCheck) {
      expect(spot.prospectiveRows).toBeGreaterThanOrEqual(1); // real keys survive
    }

    const rebuilt = manager.rebuildGraphLookupIndex();
    expect(rebuilt.rowsIndexed).toBeGreaterThan(0);
    const junkLeft = db().prepare(
      "SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE lookup_key LIKE 'acme-widget-%'"
    ).get().c;
    expect(junkLeft).toBe(0);
    expect(manager.countLookupKeyRows('legacy_entity')).toBeGreaterThanOrEqual(1);
  });
});

describe('Class B — superseded reclaim', () => {
  it('marked-only candidates; current observation and unmarked history are never candidates', async () => {
    const entity = 'reclaim_entity';
    const v1 = await storeObservation(entity, 'v1');
    const v2 = await storeObservation(entity, 'v2', { supersedes: [v1] });
    await storeObservation(entity, 'unmarked history note'); // newest → current, no supersedes

    const analysis = manager.compactAnalyzeSuperseded('default');
    const ids = analysis.candidates.map((c: any) => c.id);
    expect(ids).toContain(v1);
    expect(ids).not.toContain(v2); // v2 is not marked superseded by anyone
  });

  it('never-reclaim-current guard: a marked row that IS current gets skipped', async () => {
    const entity = 'guard_entity';
    const a = await storeObservation(entity, 'a');
    const b = await storeObservation(entity, 'b', { supersedes: [a] });
    // Pin both rows to one timestamp so SQLite's rowid tie-break makes b the
    // current row deterministically. Without this, crossing a CURRENT_TIMESTAMP
    // boundary makes the anti-anomaly guard reject a's forward marker before
    // this test can exercise the independent never-reclaim-current guard.
    db().prepare('UPDATE shared_memory SET created_at = ? WHERE id IN (?, ?)')
      .run('2026-07-06 18:00:00', a, b);

    // Corrupt a to claim it supersedes b — the anomaly. b is still resolved as
    // current and must not be reclaimable.
    const row = db().prepare('SELECT content FROM shared_memory WHERE id = ?').get(a);
    const content = JSON.parse(row.content);
    content.metadata = { ...(content.metadata || {}), supersedes: [b] };
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run(JSON.stringify(content), a);

    const analysis = manager.compactAnalyzeSuperseded('default');
    const ids = analysis.candidates.map((c: any) => c.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b); // guard: b is the entity's current observation
    expect(analysis.guardSkippedCurrent).toContain(b);
  });

  it('malformed non-array supersedes is reported, never reclaimed', async () => {
    const entity = 'malformed_entity';
    const target = await storeObservation(entity, 'victim');
    const bad = await storeObservation(entity, 'bad metadata');
    const row = db().prepare('SELECT content FROM shared_memory WHERE id = ?').get(bad);
    const content = JSON.parse(row.content);
    content.metadata = { ...(content.metadata || {}), supersedes: target }; // string, not array
    db().prepare('UPDATE shared_memory SET content = ? WHERE id = ?').run(JSON.stringify(content), bad);

    const analysis = manager.compactAnalyzeSuperseded('default');
    expect(analysis.malformedSupersedes.map((m: any) => m.id)).toContain(bad);
    expect(analysis.candidates.map((c: any) => c.id)).not.toContain(target); // string ref ≠ marked
  });

  it('execute retires to data_trash and restore brings the rows back', async () => {
    const before = manager.compactAnalyzeSuperseded('default');
    expect(before.candidates.length).toBeGreaterThan(0);
    const reclaimedIds = before.candidates.map((c: any) => c.id);

    const result = await manager.compactExecuteSuperseded('default', 'unit-test reclaim');
    expect(result.trashId).toBeTruthy();
    expect(result.reclaimedRows).toBe(before.candidates.length);

    // Rows gone, lookup keys gone
    for (const id of reclaimedIds) {
      expect(db().prepare('SELECT 1 FROM shared_memory WHERE id = ?').get(id)).toBeUndefined();
      expect(db().prepare('SELECT COUNT(*) AS c FROM graph_lookup_keys WHERE memory_id = ?').get(id).c).toBe(0);
    }
    // Nothing left to reclaim
    expect(manager.compactAnalyzeSuperseded('default').candidates.length).toBe(0);

    // Restorable
    const restored = await manager.restoreFromTrash(result.trashId, 'default');
    expect(restored.restored.inserted.observations).toBe(reclaimedIds.length);
    for (const id of reclaimedIds) {
      expect(db().prepare('SELECT 1 FROM shared_memory WHERE id = ?').get(id)).toBeDefined();
    }
  });
});

describe('Class C — vec orphans', () => {
  it('counts and deletes orphaned vector rows only', async () => {
    db().exec(`
      CREATE TABLE IF NOT EXISTS neural_vec_index (
        memory_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        vector_rowid INTEGER
      )
    `);
    const liveId = await storeObservation('vec_entity', 'has a live source row');
    db().prepare(`
      INSERT INTO neural_vec_index (memory_id, agent_id, memory_type, content, timestamp_ms)
      VALUES (?, 'unit-test', 'observation', 'live', 1), ('orphan-1', 'unit-test', 'observation', 'orphan', 1), ('orphan-2', 'unit-test', 'observation', 'orphan', 1)
    `).run(liveId);

    expect(manager.compactAnalyzeVecOrphans().orphanRows).toBe(2);
    const result = await manager.compactExecuteVecOrphans();
    expect(result.reclaimedRows).toBe(2);
    expect(result.errors).toBe(0);
    expect(manager.compactAnalyzeVecOrphans().orphanRows).toBe(0);
    expect(db().prepare('SELECT 1 FROM neural_vec_index WHERE memory_id = ?').get(liveId)).toBeDefined();
  });
});

describe('Class D — message archive', () => {
  it('archives read+old messages, leaves unread and recent alone', () => {
    const ins = db().prepare(`
      INSERT INTO ai_messages (id, from_agent, from_source, to_agent, content, created_at, read_at)
      VALUES (?, 'a', 'unit', 'b', 'x', ?, ?)
    `);
    ins.run('old-read', '2026-01-01 00:00:00', '2026-01-02 00:00:00');
    ins.run('old-unread', '2026-01-01 00:00:00', null);
    ins.run('new-read', new Date().toISOString(), new Date().toISOString());

    expect(manager.compactAnalyzeMessageArchive('default', 14).candidates).toBe(1);
    const result = manager.compactExecuteMessageArchive('default', 14);
    expect(result.archivedRows).toBe(1);
    expect(db().prepare("SELECT archived_at FROM ai_messages WHERE id = 'old-read'").get().archived_at).toBeTruthy();
    expect(db().prepare("SELECT archived_at FROM ai_messages WHERE id = 'old-unread'").get().archived_at).toBeNull();
    expect(db().prepare("SELECT archived_at FROM ai_messages WHERE id = 'new-read'").get().archived_at).toBeNull();
    expect(manager.compactAnalyzeMessageArchive('default', 14).candidates).toBe(0);
  });
});

describe('db stats', () => {
  it('reports size, freelist, and quick_check ok', () => {
    const stats = manager.compactDbStats();
    expect(stats.dbBytes).toBeGreaterThan(0);
    expect(stats.quickCheck).toBe('ok');
  });
});
