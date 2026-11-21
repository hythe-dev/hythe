/**
 * Issue #39: the server database runs in WAL. MemoryManager sets
 * journal_mode=WAL on every open (startup and snapshot restore) before any
 * schema work; HYTHE_SQLITE_JOURNAL_MODE=delete opts out (network
 * filesystems); synchronous is FULL (the bundled SQLite would reopen a WAL
 * database at NORMAL).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';
import { MemoryManager, walCheckpointComplete } from '../src/unified-server/memory/index.js';

// Every fixture below changes these; put back whatever the runner had.
const ENV_KEYS = ['HYTHE_SQLITE_JOURNAL_MODE', 'ENABLE_ADVANCED_MEMORY'] as const;
const savedEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});
const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
afterEach(restoreEnv);
afterAll(restoreEnv);

const journalMode = (db: Database.Database) => String(db.pragma('journal_mode', { simple: true })).toLowerCase();
const snapshotCount = (manager: any) => manager.listSnapshots().length;

describe('walCheckpointComplete (issue #39)', () => {
  it('accepts only busy 0 with every frame copied', () => {
    expect(walCheckpointComplete({ busy: 0, log: 0, checkpointed: 0 })).toBe(true);
    expect(walCheckpointComplete({ busy: 0, log: 7, checkpointed: 7 })).toBe(true);
    // Another connection holds the checkpoint lock: a failure, not "not WAL".
    expect(walCheckpointComplete({ busy: 1, log: -1, checkpointed: -1 })).toBe(false);
    expect(walCheckpointComplete({ busy: 1, log: 5, checkpointed: 5 })).toBe(false);
    expect(walCheckpointComplete({ busy: 0, log: 5, checkpointed: 3 })).toBe(false);
    expect(walCheckpointComplete({ busy: 0, log: -1, checkpointed: -1 })).toBe(false);
    expect(walCheckpointComplete(undefined)).toBe(false);
    expect(walCheckpointComplete({})).toBe(false);
  });
});

describe('server database journal mode (issue #39)', () => {
  let tmpDir = '';
  const servers: NeuralMCPServer[] = [];
  const boot = (file = 'test.db') => {
    const server = new NeuralMCPServer(0, path.join(tmpDir, file));
    servers.push(server);
    return server;
  };
  const mode = (server: NeuralMCPServer) =>
    String(server.getMemoryManager().getDb().pragma('journal_mode', { simple: true })).toLowerCase();

  beforeEach(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    delete process.env.HYTHE_SQLITE_JOURNAL_MODE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hythe-journal-'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a fresh database starts in WAL with synchronous FULL', () => {
    const server = boot();
    expect(mode(server)).toBe('wal');
    expect(server.getMemoryManager().getDb().pragma('synchronous', { simple: true })).toBe(2);
    // The mode is stored in the file: a separate connection sees WAL too.
    const other = new Database(path.join(tmpDir, 'test.db'), { readonly: true });
    try {
      expect(String(other.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    } finally {
      other.close();
    }
  });

  it('an existing rollback-journal (DELETE) database is switched to WAL at startup', async () => {
    const file = path.join(tmpDir, 'legacy.db');
    const legacy = new Database(file);
    legacy.pragma('journal_mode = DELETE');
    legacy.exec('CREATE TABLE legacy_marker (x INTEGER)');
    legacy.close();
    const server = boot('legacy.db');
    expect(mode(server)).toBe('wal');
    expect(server.getMemoryManager().getDb().pragma('synchronous', { simple: true })).toBe(2);
    expect(server.getMemoryManager().getDb().prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'legacy_marker'`).get()).toEqual({ c: 1 });
  });

  it('reopening an existing WAL database keeps WAL and synchronous FULL', async () => {
    const first = boot();
    expect(mode(first)).toBe('wal');
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = boot();
    expect(mode(second)).toBe('wal');
    expect(second.getMemoryManager().getDb().pragma('synchronous', { simple: true })).toBe(2);
  });

  it('a stopped database is one file: graceful close checkpoints and switches back to DELETE', async () => {
    const file = path.join(tmpDir, 'test.db');
    const server = boot();
    server.getMemoryManager().getDb().exec('CREATE TABLE IF NOT EXISTS stop_probe (v TEXT)');
    server.getMemoryManager().getDb().prepare('INSERT INTO stop_probe (v) VALUES (?)').run('kept');
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
    // A read-only offline tool (like the migration dry-runs) leaves no sidecars.
    const offline = new Database(file, { readonly: true });
    try {
      expect(String(offline.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
      expect(offline.prepare('SELECT v FROM stop_probe').all()).toEqual([{ v: 'kept' }]);
    } finally {
      offline.close();
    }
    for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(`${file}${suffix}`)).toBe(false);
    // The next start runs in WAL again.
    expect(mode(boot())).toBe('wal');
  });

  it('snapshot files are single-file DELETE-mode databases', async () => {
    const server = boot();
    const snapshot = await (server.getMemoryManager() as any).createSnapshot('mode-probe');
    const backupDir = path.join(tmpDir, 'backups');
    const snapshotFile = path.join(backupDir, snapshot.filename);
    const reader = new Database(snapshotFile, { readonly: true });
    try {
      expect(String(reader.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
    } finally {
      reader.close();
    }
    expect(fs.readdirSync(backupDir).filter((f) => /-(wal|shm|journal)$/.test(f))).toEqual([]);
  });

  it('HYTHE_SQLITE_JOURNAL_MODE=delete keeps the rollback journal; an unknown value falls back to WAL', () => {
    process.env.HYTHE_SQLITE_JOURNAL_MODE = 'delete';
    expect(mode(boot('opt-out.db'))).toBe('delete');
    process.env.HYTHE_SQLITE_JOURNAL_MODE = 'truncate';
    expect(mode(boot('fallback.db'))).toBe('wal');
  });

  it('an in-memory database is left in memory mode', () => {
    const server = new NeuralMCPServer(0, ':memory:');
    servers.push(server);
    expect(mode(server)).toBe('memory');
  });

  it('snapshot restore in WAL: restored data only (no stale -wal replay), still WAL, integrity ok', async () => {
    const server = boot();
    const manager = server.getMemoryManager() as any;
    const db = () => server.getMemoryManager().getDb();
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('journal-probe');
    // Written after the snapshot; in WAL these pages sit in the -wal file.
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
    expect(fs.existsSync(path.join(tmpDir, 'test.db-wal'))).toBe(true);
    await manager.restoreSnapshot(snapshot.snapshotId);
    expect(mode(server)).toBe('wal');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('snapshot restore with another connection open (issue #39)', () => {
  let tmpDir = '';
  let server: NeuralMCPServer | null = null;

  beforeEach(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    delete process.env.HYTHE_SQLITE_JOURNAL_MODE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hythe-journal-held-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('an idle connection (no transaction) is refused too; the server stays in WAL, writes, and keeps no orphan snapshot', async () => {
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    const manager = server.getMemoryManager() as any;
    const db = () => server!.getMemoryManager().getDb();
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('held-probe');
    const snapshotsBefore = snapshotCount(manager);
    const reader = new Database(file, { readonly: true });
    try {
      reader.prepare('SELECT COUNT(*) FROM journal_probe').get(); // idle afterwards, WAL index still mapped
      db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
      const started = Date.now();
      await expect(manager.restoreSnapshot(snapshot.snapshotId)).rejects.toThrow(/another connection is using the database/);
      expect(Date.now() - started).toBeLessThan(2000); // refused without the 5 s busy wait
      expect(journalMode(db())).toBe('wal');
      expect(snapshotCount(manager)).toBe(snapshotsBefore); // the pre-restore snapshot was removed
      db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('while-reader-open');
      expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([
        { v: 'before-snapshot' }, { v: 'after-snapshot' }, { v: 'while-reader-open' },
      ]);
    } finally {
      reader.close();
    }
    await manager.restoreSnapshot(snapshot.snapshotId); // succeeds once the reader is gone
    expect(journalMode(db())).toBe('wal');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-restore');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }, { v: 'after-restore' }]);
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('a competing checkpointer (busy 1, log -1) is a refusal, not a non-WAL no-op', async () => {
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    const manager = server.getMemoryManager() as any;
    const db = () => server!.getMemoryManager().getDb();
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('checkpointer-probe');
    const snapshotsBefore = snapshotCount(manager);
    // A reader pins the WAL, so another process's TRUNCATE checkpoint waits
    // on it while owning the checkpoint lock.
    const reader = new Database(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM journal_probe').get();
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const Sqlite = require(workerData.module);
       const db = new Sqlite(workerData.file);
       db.pragma('busy_timeout = 10000');
       parentPort.postMessage('checkpointing');
       db.pragma('wal_checkpoint(TRUNCATE)');
       db.close();`,
      { eval: true, workerData: { module: createRequire(import.meta.url).resolve('better-sqlite3'), file } },
    );
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
      // Wait until the worker really holds the checkpoint lock.
      const probe = new Database(file);
      try {
        let held = false;
        for (const deadline = Date.now() + 5000; !held && Date.now() < deadline;) {
          const [r] = probe.pragma('wal_checkpoint(PASSIVE)') as any[];
          held = r.busy === 1 && r.log === -1;
          if (!held) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(held).toBe(true);
      } finally {
        probe.close();
      }
      await expect(manager.restoreSnapshot(snapshot.snapshotId)).rejects.toThrow(/WAL checkpoint incomplete: \{"busy":1,"log":-1,"checkpointed":-1\}/);
      expect(journalMode(db())).toBe('wal');
      expect(snapshotCount(manager)).toBe(snapshotsBefore);
      expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }, { v: 'after-snapshot' }]);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await exited;
    }
    await manager.restoreSnapshot(snapshot.snapshotId);
    expect(journalMode(db())).toBe('wal');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-restore');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }, { v: 'after-restore' }]);
  });

  it('graceful close with another connection open does not wait: the file stays in WAL', async () => {
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    server.getMemoryManager().getDb().exec('CREATE TABLE IF NOT EXISTS stop_probe (v TEXT)');
    const reader = new Database(file, { readonly: true });
    try {
      reader.prepare('SELECT COUNT(*) FROM stop_probe').get();
      const started = Date.now();
      await server.close();
      server = null;
      expect(Date.now() - started).toBeLessThan(2000);
      expect(journalMode(reader)).toBe('wal');
    } finally {
      reader.close();
    }
  });
});

describe('journal-mode failures at startup (issue #39)', () => {
  let tmpDir = '';

  beforeEach(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    delete process.env.HYTHE_SQLITE_JOURNAL_MODE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hythe-journal-fail-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('an explicit HYTHE_SQLITE_JOURNAL_MODE=delete that cannot be applied refuses startup', () => {
    const file = path.join(tmpDir, 'held.db');
    const seed = new Database(file);
    seed.pragma('journal_mode = WAL');
    seed.exec('CREATE TABLE seed (x INTEGER)');
    const idle = new Database(file, { readonly: true });
    try {
      idle.prepare('SELECT COUNT(*) FROM seed').get();
      process.env.HYTHE_SQLITE_JOURNAL_MODE = 'delete';
      expect(() => new MemoryManager(file)).toThrow(/HYTHE_SQLITE_JOURNAL_MODE=delete was requested explicitly/);
      expect(journalMode(seed)).toBe('wal');
    } finally {
      idle.close();
      seed.close();
    }
  });

  it('synchronous is FULL even when the switch to WAL fails; on the restore reopen (strict) the failure throws', async () => {
    const file = path.join(tmpDir, 'busy.db');
    process.env.HYTHE_SQLITE_JOURNAL_MODE = 'delete';
    const manager = new MemoryManager(file);
    const db = manager.getDb() as Database.Database;
    const reader = new Database(file, { readonly: true });
    try {
      expect(journalMode(db)).toBe('delete');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 0');
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM sqlite_master').get(); // a read lock blocks DELETE -> WAL
      delete process.env.HYTHE_SQLITE_JOURNAL_MODE; // now WAL is wanted
      (manager as any).applyJournalMode({ strict: false });
      expect(journalMode(db)).toBe('delete');
      expect(db.pragma('synchronous', { simple: true })).toBe(2);
      db.pragma('synchronous = NORMAL');
      expect(() => (manager as any).applyJournalMode({ strict: true })).toThrow(/journal_mode=wal could not be set/);
      expect(db.pragma('synchronous', { simple: true })).toBe(2);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await manager.close();
    }
  });
});

describe('snapshot restore refused while another connection is mid-read (issue #39)', () => {
  let tmpDir = '';
  let server: NeuralMCPServer | null = null;

  beforeEach(() => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    delete process.env.HYTHE_SQLITE_JOURNAL_MODE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hythe-journal-busy-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the restore throws before touching the file; the server keeps its data and keeps working', async () => {
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    const manager = server.getMemoryManager() as any;
    const db = () => server!.getMemoryManager().getDb();
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('busy-probe');
    const snapshotsBefore = snapshotCount(manager);
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM journal_probe').get(); // an open read transaction pins the WAL
    try {
      const started = Date.now();
      await expect(manager.restoreSnapshot(snapshot.snapshotId)).rejects.toThrow(/another connection is using the database/);
      expect(Date.now() - started).toBeLessThan(2000); // refused without the 5 s busy wait
      expect(journalMode(db())).toBe('wal');
      expect(snapshotCount(manager)).toBe(snapshotsBefore);
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }, { v: 'after-snapshot' }]);
    const created = await (server as any)._handleToolCall('create_entities', {
      entities: [{ name: `after-refused-restore-${Date.now()}`, entityType: 'project', observations: [], aliases: [] }],
    });
    expect(created.isError).toBeFalsy();
    await manager.restoreSnapshot(snapshot.snapshotId); // succeeds once the reader is gone
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
  });
  it('with the HYTHE_SQLITE_JOURNAL_MODE=delete opt-out, a mid-read connection is refused too', async () => {
    process.env.HYTHE_SQLITE_JOURNAL_MODE = 'delete';
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    const manager = server.getMemoryManager() as any;
    const db = () => server!.getMemoryManager().getDb();
    expect(journalMode(db())).toBe('delete');
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('delete-busy-probe');
    const snapshotsBefore = snapshotCount(manager);
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM journal_probe').get(); // holds a SHARED lock
    try {
      await expect(manager.restoreSnapshot(snapshot.snapshotId)).rejects.toThrow(/another connection is using the database \(no exclusive lock/);
      expect(snapshotCount(manager)).toBe(snapshotsBefore);
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }, { v: 'after-snapshot' }]);
    await manager.restoreSnapshot(snapshot.snapshotId);
    expect(journalMode(db())).toBe('delete');
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
  });
});
