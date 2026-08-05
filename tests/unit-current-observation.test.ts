/**
 * ENG-1 addendum: degenerate-case guarantees for getCurrentObservation.
 *
 * The PM-required correctness edge: get_current_observation must NEVER report
 * "no current observation" while the entity has observations — even when
 * anomalous data (mutual / forward-pointing supersedes, clock skew) marks
 * every row in the resolution window as superseded. These anomalies cannot be
 * produced through the MCP write path (server-generated ids make supersedes
 * point backward in time), so this suite drives MemoryManager directly
 * against a scratch DB and corrupts rows by SQL to construct them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

process.env.ENABLE_ADVANCED_MEMORY = 'false';

const { MemoryManager } = await import('../src/unified-server/memory/index.js');

let workDir: string;
let manager: any;

function updateSupersedes(observationId: string, supersedes: string[]): void {
  const db = (manager as any).db;
  const row = db.prepare('SELECT content FROM shared_memory WHERE id = ?').get(observationId);
  const content = JSON.parse(row.content);
  content.metadata = { ...(content.metadata || {}), supersedes };
  db.prepare('UPDATE shared_memory SET content = ? WHERE id = ?')
    .run(JSON.stringify(content), observationId);
}

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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng1-unit-'));
  manager = new MemoryManager(path.join(workDir, 'test.db'));
});

afterAll(() => {
  try { (manager as any).db.close(); } catch { /* ignore */ }
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('getCurrentObservation degenerate cases (unit)', () => {
  it('well-ordered chain: newest wins, no fallback', async () => {
    const entity = 'unit_chain';
    const first = await storeObservation(entity, 'v1');
    const second = await storeObservation(entity, 'v2', { supersedes: [first] });

    const result = manager.getCurrentObservation(entity);
    expect(result.current.id).toBe(second);
    expect(result.resolution.fallback).toBeUndefined();
    expect(result.resolution.widened).toBeUndefined();
  });

  it('mutual supersession (anomaly): falls back to the newest row instead of returning null', async () => {
    const entity = 'unit_mutual';
    const first = await storeObservation(entity, 'v1');
    const second = await storeObservation(entity, 'v2', { supersedes: [first] });
    // Corrupt the older row to point forward at the newer one — now every row
    // is marked superseded.
    updateSupersedes(first, [second]);

    const result = manager.getCurrentObservation(entity);
    expect(result.current).not.toBeNull();
    expect(result.current.id).toBe(second);
    expect(result.resolution.fallback).toBe('all_candidates_superseded_returned_newest');
  });

  it('every row of the first window superseded: widens and finds the older current row', async () => {
    const entity = 'unit_widen';
    const ids: string[] = [];
    for (let i = 1; i <= 30; i++) {
      ids.push(await storeObservation(entity, `row ${i}`));
    }
    // Window of 25 covers rows 30..6 (newest-first). Corrupt row 6 to
    // forward-supersede rows 7..30 and row 7 to supersede row 6: all 25
    // window rows are now marked, while rows 5..1 (outside the window)
    // remain clean — row 5 is the true current.
    updateSupersedes(ids[5], ids.slice(6));
    updateSupersedes(ids[6], [...ids.slice(7), ids[5]]);

    const result = manager.getCurrentObservation(entity);
    expect(result.resolution.widened).toBe(true);
    expect(result.current.id).toBe(ids[4]);
    expect(result.resolution.fallback).toBeUndefined();
  });

  it('empty entity still returns a clean null', () => {
    const result = manager.getCurrentObservation('unit_empty_never_written');
    expect(result.current).toBeNull();
    expect(result.resolution.candidatesInWindow).toBe(0);
  });
});
