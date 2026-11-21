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
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeuralMCPServer } from '../src/unified-neural-mcp-server.js';

describe('server database journal mode (issue #39)', () => {
  let tmpDir = '';
  const servers: NeuralMCPServer[] = [];
  const previous = process.env.HYTHE_SQLITE_JOURNAL_MODE;
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
    if (previous === undefined) delete process.env.HYTHE_SQLITE_JOURNAL_MODE;
    else process.env.HYTHE_SQLITE_JOURNAL_MODE = previous;
    delete process.env.ENABLE_ADVANCED_MEMORY;
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

describe('snapshot restore with another connection holding the WAL (issue #39)', () => {
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
    delete process.env.ENABLE_ADVANCED_MEMORY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a -wal file left by another open connection is not replayed onto the restored database', async () => {
    const file = path.join(tmpDir, 'test.db');
    server = new NeuralMCPServer(0, file);
    const manager = server.getMemoryManager() as any;
    const db = () => server!.getMemoryManager().getDb();
    db().exec('CREATE TABLE IF NOT EXISTS journal_probe (v TEXT)');
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('before-snapshot');
    const snapshot = await manager.createSnapshot('held-probe');
    const reader = new Database(file, { readonly: true });
    try {
      reader.prepare('SELECT COUNT(*) FROM journal_probe').get(); // keeps the WAL index mapped
      db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
      reader.prepare('SELECT COUNT(*) FROM journal_probe').get();
      await manager.restoreSnapshot(snapshot.snapshotId);
    } finally {
      reader.close();
    }
    expect(db().prepare('SELECT v FROM journal_probe ORDER BY rowid').all()).toEqual([{ v: 'before-snapshot' }]);
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok');
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
    delete process.env.ENABLE_ADVANCED_MEMORY;
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
    db().prepare('INSERT INTO journal_probe (v) VALUES (?)').run('after-snapshot');
    const reader = new Database(file, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM journal_probe').get(); // an open read transaction pins the WAL
    try {
      await expect(manager.restoreSnapshot(snapshot.snapshotId)).rejects.toThrow(/another connection is using the database/);
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
});
