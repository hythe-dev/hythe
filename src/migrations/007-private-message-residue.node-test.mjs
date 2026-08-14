import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import {
  analyzePrivateMessageResidue,
  runPrivateMessageResidueMigration,
} from './007-private-message-residue.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

function makeFixture({
  realVec0 = false,
  vectorTable = 'shared_memory_vec',
  vectorIndexTable = 'neural_vec_index',
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hythe-message-residue-'));
  const dbPath = join(directory, 'memory.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ai_messages (
      id TEXT PRIMARY KEY,
      legacy_shared_memory_id TEXT UNIQUE,
      tenant_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE shared_memory (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE graph_lookup_keys (
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL
    );
    CREATE TABLE entity_lookup_identity_links (
      tenant_id TEXT NOT NULL,
      memory_id TEXT NOT NULL
    );
    CREATE TABLE entity_context_facets (
      tenant_id TEXT NOT NULL,
      source_row_id TEXT NOT NULL
    );
    CREATE TABLE ${vectorIndexTable} (
      memory_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      vector_rowid INTEGER
    );
  `);
  if (realVec0) {
    (sqliteVec.load || sqliteVec.default?.load)(db);
    db.exec(`CREATE VIRTUAL TABLE ${vectorTable} USING vec0(embedding float[2])`);
  } else {
    db.exec(`CREATE TABLE ${vectorTable} (embedding TEXT)`);
  }
  const fullBody = 'private body '.repeat(400);
  const pointer = 'Full content stored as entity "msg-detail-message-1". To read the full message, call get_message_detail.';
  db.prepare(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('message-1', 'legacy-message-1', 'tenant-a', 'sender-a', 'recipient-a', pointer);
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('detail-row-1', 'tenant-a', 'entity', JSON.stringify({
    name: 'msg-detail-message-1',
    aliases: ['private-detail-alias'],
    type: 'message_detail',
    observations: [fullBody],
    createdBy: 'sender-a',
  }), 'sender-a');
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy-message-1', 'tenant-a', 'ai_message', JSON.stringify({
    from: 'sender-a', to: 'recipient-a', content: pointer,
  }), 'sender-a');

  let messageVectorRowId = 11;
  let detailVectorRowId = 12;
  if (realVec0) {
    messageVectorRowId = Number(
      db.prepare(`INSERT INTO ${vectorTable} (embedding) VALUES (?)`).run('[1,0]').lastInsertRowid
    );
    detailVectorRowId = Number(
      db.prepare(`INSERT INTO ${vectorTable} (embedding) VALUES (?)`).run('[0,1]').lastInsertRowid
    );
  } else {
    db.prepare(`INSERT INTO ${vectorTable} (rowid, embedding) VALUES (?, ?)`).run(11, '[1]');
    db.prepare(`INSERT INTO ${vectorTable} (rowid, embedding) VALUES (?, ?)`).run(12, '[2]');
  }
  db.prepare(`
    INSERT INTO ${vectorIndexTable} (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, ?, ?, ?)
  `).run('message-1', 'tenant-a', 'ai_message', fullBody, messageVectorRowId);
  db.prepare(`
    INSERT INTO ${vectorIndexTable} (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, ?, ?, ?)
  `).run('detail-row-1', 'tenant-a', 'entity', fullBody, detailVectorRowId);
  for (const id of ['detail-row-1', 'legacy-message-1']) {
    db.prepare('INSERT INTO graph_lookup_keys (tenant_id, memory_id) VALUES (?, ?)').run('tenant-a', id);
    db.prepare('INSERT INTO entity_lookup_identity_links (tenant_id, memory_id) VALUES (?, ?)').run('tenant-a', id);
    db.prepare('INSERT INTO entity_context_facets (tenant_id, source_row_id) VALUES (?, ?)').run('tenant-a', id);
  }
  db.close();
  return { directory, dbPath, fullBody, vectorTable, vectorIndexTable };
}

function readCounts(
  dbPath,
  { vectorTable = 'shared_memory_vec', vectorIndexTable = 'neural_vec_index' } = {}
) {
  const db = new Database(dbPath, { readonly: true });
  try {
    (sqliteVec.load || sqliteVec.default?.load)(db);
  } catch {
    // Ordinary table fixtures do not need the extension.
  }
  const result = {
    ai: db.prepare('SELECT COUNT(*) AS count FROM ai_messages').get().count,
    shared: db.prepare('SELECT COUNT(*) AS count FROM shared_memory').get().count,
    vectors: db.prepare(`SELECT COUNT(*) AS count FROM ${vectorIndexTable}`).get().count,
    vec0: db.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get().count,
    graph: db.prepare('SELECT COUNT(*) AS count FROM graph_lookup_keys').get().count,
    links: db.prepare('SELECT COUNT(*) AS count FROM entity_lookup_identity_links').get().count,
    facets: db.prepare('SELECT COUNT(*) AS count FROM entity_context_facets').get().count,
    content: db.prepare("SELECT content FROM ai_messages WHERE id = 'message-1'").get().content,
  };
  db.close();
  return result;
}

async function withVectorStorageEnvironment(vectorTable, vectorIndexTable, operation) {
  const priorVectorTable = process.env.SQLITE_VEC_TABLE;
  const priorIndexTable = process.env.SQLITE_VEC_INDEX_TABLE;
  if (vectorTable == null) delete process.env.SQLITE_VEC_TABLE;
  else process.env.SQLITE_VEC_TABLE = vectorTable;
  if (vectorIndexTable == null) delete process.env.SQLITE_VEC_INDEX_TABLE;
  else process.env.SQLITE_VEC_INDEX_TABLE = vectorIndexTable;
  try {
    return await operation();
  } finally {
    if (priorVectorTable == null) delete process.env.SQLITE_VEC_TABLE;
    else process.env.SQLITE_VEC_TABLE = priorVectorTable;
    if (priorIndexTable == null) delete process.env.SQLITE_VEC_INDEX_TABLE;
    else process.env.SQLITE_VEC_INDEX_TABLE = priorIndexTable;
  }
}

async function executeFixture(fixture, suffix = '') {
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  assert.equal(dry.status, 'ready');
  return runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath: join(fixture.directory, `backup${suffix}.db`),
    reportPath: join(fixture.directory, `report${suffix}.json`),
  });
}

test('dry-run is default and leaves a clean migration fixture unchanged', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const reportPath = join(fixture.directory, 'dry-run.json');
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    reportPath,
  });
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.counts, {
    pointers: 1,
    detailEntities: 1,
    privateObservations: 0,
    privateRelations: 0,
    sharedMessages: 1,
    vectorIndexRows: 2,
    vec0Rows: 2,
    issues: 0,
  });
  assert.deepEqual(readCounts(fixture.dbPath), before);
  const reportText = readFileSync(reportPath, 'utf8');
  assert.equal(JSON.parse(reportText).fingerprint, report.fingerprint);
  assert.equal(reportText.includes(fixture.fullBody), false);
});

test('execute requires the reviewed token and does not create a backup on refusal', async () => {
  const fixture = makeFixture();
  const backupPath = join(fixture.directory, 'wrong-token-backup.db');
  const reportPath = join(fixture.directory, 'wrong-token-report.json');
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: 'RESTORE-PRIVATE-MESSAGES-WRONG',
    backupPath,
    reportPath,
  });
  assert.equal(report.status, 'refused');
  assert.ok(report.issues.some(({ code }) => code === 'confirmation_token_mismatch'));
  assert.equal(existsSync(backupPath), false);
  assert.equal(existsSync(reportPath), true);
});

test('backup and report paths cannot alias the source database sidecar namespace', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  assert.equal(dry.status, 'ready');
  for (const suffix of ['-wal', '-journal', '-shm']) {
    await assert.rejects(
      runPrivateMessageResidueMigration({
        dbPath: fixture.dbPath,
        execute: true,
        confirm: dry.confirmationToken,
        backupPath: `${fixture.dbPath}${suffix}`,
        reportPath: join(fixture.directory, `sidecar-backup${suffix}.json`),
      }),
      /backup path collides with the source SQLite database or one of its sidecars/,
      `backup alias ${suffix}`
    );
    await assert.rejects(
      runPrivateMessageResidueMigration({
        dbPath: fixture.dbPath,
        execute: true,
        confirm: dry.confirmationToken,
        backupPath: join(fixture.directory, `safe-backup${suffix}.db`),
        reportPath: `${fixture.dbPath}${suffix}`,
      }),
      /report path collides with the source SQLite database or one of its sidecars/,
      `report alias ${suffix}`
    );
    await assert.rejects(
      runPrivateMessageResidueMigration({
        dbPath: fixture.dbPath,
        reportPath: `${fixture.dbPath}${suffix}`,
      }),
      /report path collides with the source SQLite database or one of its sidecars/,
      `dry-run report alias ${suffix}`
    );
  }
  assert.deepEqual(readCounts(fixture.dbPath), before);
  for (const suffix of ['-wal', '-journal', '-shm']) {
    assert.equal(existsSync(`${fixture.dbPath}${suffix}`), false, suffix);
  }
});

test('symlinked artifact parents cannot bypass the source SQLite sidecar namespace', async () => {
  for (const collision of ['backup', 'report']) {
    const fixture = makeFixture();
    const before = readCounts(fixture.dbPath);
    const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
    const aliasRoot = join(fixture.directory, 'alias-root');
    mkdirSync(aliasRoot);
    const alias = join(aliasRoot, 'database-parent');
    symlinkSync(fixture.directory, alias, 'dir');
    const sidecarAlias = join(alias, 'memory.db-journal');
    const backupPath = collision === 'backup'
      ? sidecarAlias
      : join(fixture.directory, 'safe-symlink-backup.db');
    const reportPath = collision === 'report'
      ? sidecarAlias
      : join(fixture.directory, 'safe-symlink-report.json');
    await assert.rejects(
      runPrivateMessageResidueMigration({
        dbPath: fixture.dbPath,
        execute: true,
        confirm: dry.confirmationToken,
        backupPath,
        reportPath,
      }),
      /path collides with the source SQLite database or one of its sidecars/
    );
    assert.equal(existsSync(sidecarAlias), false);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(reportPath), false);
    assert.deepEqual(readCounts(fixture.dbPath), before);
  }
});

test('verified backup publication never overwrites a destination created in the promotion gap', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'raced-backup.db');
  const marker = 'INDEPENDENT-MIGRATION-BACKUP';
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'raced-backup-report.json'),
    beforeBackupPromotion() {
      writeFileSync(backupPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.rolledBack, true);
  assert.equal(readFileSync(backupPath, 'utf8'), marker);
  assert.deepEqual(readCounts(fixture.dbPath), before);
  assert.equal(readdirSync(fixture.directory).some((name) => name.includes('.unverified-')), false);
});

test('migration refuses to mutate when the verified backup is replaced before mutation', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'replaced-backup.db');
  const marker = 'INDEPENDENT-REPLACEMENT';
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'replaced-backup-report.json'),
    afterBackupPromotion() {
      unlinkSync(backupPath);
      writeFileSync(backupPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.rolledBack, true);
  assert.equal(readFileSync(backupPath, 'utf8'), marker);
  assert.deepEqual(readCounts(fixture.dbPath), before);
  assert.equal(readdirSync(fixture.directory).some((name) => name.includes('.unverified-')), false);
});

test('backup replacement immediately before commit preserves the replacement and rolls back', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'precommit-replaced-backup.db');
  const marker = 'INDEPENDENT-PRECOMMIT-BACKUP';
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'precommit-replaced-report.json'),
    beforeCommit() {
      unlinkSync(backupPath);
      writeFileSync(backupPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.rolledBack, true);
  assert.equal(readFileSync(backupPath, 'utf8'), marker);
  assert.deepEqual(readCounts(fixture.dbPath), before);
});

test('backup deletion immediately after commit can never be reported as applied', async () => {
  const fixture = makeFixture();
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'postcommit-deleted-backup.db');
  const reportPath = join(fixture.directory, 'postcommit-deleted-report.json');
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath,
    afterCommit() {
      unlinkSync(backupPath);
    },
  });
  assert.equal(report.status, 'committed-backup-verification-failed');
  assert.equal(report.committed, true);
  assert.equal(report.applied, undefined);
  assert.equal(existsSync(backupPath), false);
  assert.equal(readCounts(fixture.dbPath).content, fixture.fullBody);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status,
    'committed-backup-verification-failed');
});

test('pending report write preserves an independently replaced reservation and does not mutate', async () => {
  const fixture = makeFixture();
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'pending-report-backup.db');
  const reportPath = join(fixture.directory, 'pending-report.json');
  const marker = 'INDEPENDENT-PENDING-REPORT';
  await assert.rejects(
    runPrivateMessageResidueMigration({
      dbPath: fixture.dbPath,
      execute: true,
      confirm: dry.confirmationToken,
      backupPath,
      reportPath,
      beforePendingReportWrite() {
        unlinkSync(reportPath);
        writeFileSync(reportPath, marker, { flag: 'wx', mode: 0o600 });
      },
    }),
    /report path ownership changed; refusing to overwrite it/
  );
  assert.equal(readFileSync(reportPath, 'utf8'), marker);
  assert.equal(existsSync(backupPath), false);
  assert.deepEqual(readCounts(fixture.dbPath), before);
});

test('final report write never overwrites an independently replaced pending report', async () => {
  const fixture = makeFixture();
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'final-report-backup.db');
  const reportPath = join(fixture.directory, 'final-report.json');
  const marker = 'INDEPENDENT-FINAL-REPORT';
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath,
    beforeFinalReportWrite() {
      unlinkSync(reportPath);
      writeFileSync(reportPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'applied-report-write-failed');
  assert.match(report.reportWriteError, /report path ownership changed/);
  assert.equal(readFileSync(reportPath, 'utf8'), marker);
  assert.equal(existsSync(backupPath), true);
  assert.equal(readCounts(fixture.dbPath).content, fixture.fullBody);
});

test('backup replacement at final reporting is preserved and downgrades applied status', async () => {
  const fixture = makeFixture();
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const backupPath = join(fixture.directory, 'final-replaced-backup.db');
  const reportPath = join(fixture.directory, 'final-replaced-backup-report.json');
  const marker = 'INDEPENDENT-FINAL-BACKUP';
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath,
    reportPath,
    beforeFinalReportWrite() {
      unlinkSync(backupPath);
      writeFileSync(backupPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'committed-backup-verification-failed');
  assert.equal(report.committed, true);
  assert.equal(report.applied, undefined);
  assert.equal(readFileSync(backupPath, 'utf8'), marker);
  assert.equal(readCounts(fixture.dbPath).content, fixture.fullBody);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status,
    'committed-backup-verification-failed');
});

test('confirmation fingerprint binds shared sender fallback and vector primary mapping', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  db.prepare(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('shared-primary', 'shared-legacy', 'tenant-a', 'fallback-sender-a', 'recipient-a', 'shared body');
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, 'ai_message', ?, ?)
  `).run('shared-legacy', 'tenant-a', JSON.stringify({
    to: 'recipient-a',
    content: 'shared body',
  }), 'fallback-sender-a');

  db.prepare(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('vector-primary-a', 'vector-legacy', 'tenant-a', 'vector-sender-a', 'recipient-a', 'vector body a');
  db.prepare(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES (?, NULL, ?, ?, ?, ?)
  `).run('vector-primary-b', 'tenant-a', 'vector-sender-b', 'recipient-b', 'vector body b');
  db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(91, '[91]');
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, 'ai_message', ?, ?)
  `).run('vector-legacy', 'tenant-a', 'vector residue', 91);

  const before = analyzePrivateMessageResidue(db);
  assert.equal(before.ready, true);
  db.prepare("UPDATE ai_messages SET from_agent = 'fallback-sender-b' WHERE id = 'shared-primary'").run();
  db.prepare("UPDATE shared_memory SET created_by = 'fallback-sender-b' WHERE id = 'shared-legacy'").run();
  const afterSenderChange = analyzePrivateMessageResidue(db);
  assert.equal(afterSenderChange.ready, true);
  assert.notEqual(afterSenderChange.fingerprint, before.fingerprint);

  db.prepare("UPDATE ai_messages SET legacy_shared_memory_id = NULL WHERE id = 'vector-primary-a'").run();
  db.prepare("UPDATE ai_messages SET legacy_shared_memory_id = 'vector-legacy' WHERE id = 'vector-primary-b'").run();
  const afterVectorRemap = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(afterVectorRemap.ready, true);
  assert.notEqual(afterVectorRemap.fingerprint, afterSenderChange.fingerprint);
});

test('clean execution restores the full body and removes only accounted residue', async () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const unrelatedEntityContent = JSON.stringify({
    name: 'unrelated', type: 'project', observations: ['must remain'],
  });
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('unrelated-entity', 'tenant-a', 'entity', unrelatedEntityContent, 'someone-else');
  db.prepare('INSERT INTO graph_lookup_keys (tenant_id, memory_id) VALUES (?, ?)')
    .run('tenant-a', 'unrelated-entity');
  db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(13, '[3]');
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, ?, ?, ?)
  `).run('unrelated-entity', 'tenant-a', 'entity', unrelatedEntityContent, 13);
  db.close();
  const report = await executeFixture(fixture);
  assert.equal(report.status, 'applied');
  assert.equal(report.quickCheck, 'ok');
  assert.equal(report.backup.checks.quickCheck, 'ok');
  assert.equal(report.backup.checks.integrityCheck, 'ok');
  assert.equal(report.backup.checks.foreignKeyViolations, 0);
  assert.match(report.backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.backup.bytes, statSync(join(fixture.directory, 'backup.db')).size);
  assert.equal(statSync(join(fixture.directory, 'backup.db')).mode & 0o777, 0o600);
  assert.deepEqual(readCounts(fixture.dbPath), {
    ai: 1,
    shared: 1,
    vectors: 1,
    vec0: 1,
    graph: 1,
    links: 0,
    facets: 0,
    content: fixture.fullBody,
  });
  const backup = readCounts(join(fixture.directory, 'backup.db'));
  assert.match(backup.content, /^Full content stored as entity/);
  assert.equal(backup.shared, 3);
  const audit = new Database(fixture.dbPath, { readonly: true });
  const auditRow = audit.prepare(`
    SELECT backup_sha256, backup_bytes, backup_identity_json
    FROM private_message_residue_migration_audit
  `).get();
  audit.close();
  assert.equal(auditRow.backup_sha256, report.backup.sha256);
  assert.equal(auditRow.backup_bytes, report.backup.bytes);
  assert.equal(JSON.parse(auditRow.backup_identity_json).inode, report.backup.pathIdentity.inode);
});

test('real sqlite-vec rows are removed with their private index rows', async () => {
  const fixture = makeFixture({ realVec0: true });
  const report = await executeFixture(fixture, '-vec0');
  assert.equal(report.status, 'applied');
  const db = new Database(fixture.dbPath);
  (sqliteVec.load || sqliteVec.default?.load)(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM neural_vec_index').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_memory_vec').get().count, 0);
  db.close();
});

test('materialized observations of a private detail entity are removed with their indexes', async () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const observation = {
    entityName: 'msg-detail-message-1',
    contents: [fixture.fullBody],
    addedBy: 'sender-a',
    metadata: {
      source: 'create_entities_inline',
      entityId: 'detail-row-1',
    },
  };
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, 'observation', ?, ?)
  `).run('private-observation-1', 'tenant-a', JSON.stringify(observation), 'sender-a');
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, 'observation', ?, ?)
  `).run('private-observation-alias', 'tenant-a', JSON.stringify({
    entityName: 'private-detail-alias',
    contents: [fixture.fullBody],
    addedBy: 'sender-a',
    metadata: { source: 'add_observations' },
  }), 'sender-a');
  db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(13, '[3]');
  db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(14, '[4]');
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, 'observation', ?, ?)
  `).run('private-observation-1', 'tenant-a', fixture.fullBody, 13);
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, 'observation', ?, ?)
  `).run('private-observation-alias', 'tenant-a', fixture.fullBody, 14);
  db.prepare('INSERT INTO graph_lookup_keys (tenant_id, memory_id) VALUES (?, ?)')
    .run('tenant-a', 'private-observation-1');
  db.prepare('INSERT INTO graph_lookup_keys (tenant_id, memory_id) VALUES (?, ?)')
    .run('tenant-a', 'private-observation-alias');
  db.close();

  const report = await executeFixture(fixture, '-private-observation');
  assert.equal(report.status, 'applied');
  assert.equal(report.applied.privateObservationsDeleted, 2);
  assert.equal(report.applied.vectorIndexRowsDeleted, 4);
  const after = readCounts(fixture.dbPath);
  assert.equal(after.shared, 0);
  assert.equal(after.vectors, 0);
  assert.equal(after.vec0, 0);
  assert.equal(after.graph, 0);
});

test('full same-tenant entity resolution refuses public name and alias collisions', async (t) => {
  await t.test('a public alias colliding with the pointer name makes the pointer ambiguous', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-pointer-collision', 'tenant-a', JSON.stringify({
      name: 'public-project',
      aliases: ['msg-detail-message-1'],
      type: 'project',
      observations: [],
    }), 'public-agent');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, candidateIds }) =>
      code === 'ambiguous_pointer_payload'
      && candidateIds.includes('detail-row-1')
      && candidateIds.includes('public-pointer-collision')));
  });

  await t.test('an observation alias collision is refused and neither row is selected for deletion', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-alias-collision', 'tenant-a', JSON.stringify({
      name: 'public-alias-owner',
      aliases: ['private-detail-alias'],
      type: 'project',
      observations: [],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('collision-observation', 'tenant-a', JSON.stringify({
      entityName: 'private-detail-alias',
      contents: [fixture.fullBody],
      metadata: { source: 'add_observations' },
    }), 'public-agent');
    const analysis = analyzePrivateMessageResidue(db);
    assert.equal(analysis.ready, false);
    assert.equal(analysis.privateObservations.some(({ id }) => id === 'collision-observation'), false);
    assert.ok(analysis.issues.some(({ code, observationId, parentEntityIds }) =>
      code === 'ambiguous_private_observation_parent'
      && observationId === 'collision-observation'
      && parentEntityIds.includes('detail-row-1')
      && parentEntityIds.includes('public-alias-collision')));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id IN ('public-alias-collision', 'collision-observation')").get().count, 2);
    db.close();
  });

  await t.test('runtime-equivalent punctuation variants make observations and relations ambiguous', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-normalized-collision', 'tenant-a', JSON.stringify({
      name: 'public-normalized-owner',
      aliases: ['msg detail message 1'],
      type: 'project',
      observations: [],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('normalized-collision-observation', 'tenant-a', JSON.stringify({
      entityName: 'msg-detail-message-1',
      contents: ['public note that must not be guessed away'],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'relation', ?, ?)
    `).run('normalized-collision-relation', 'tenant-a', JSON.stringify({
      from: 'msg-detail-message-1',
      to: 'public-target',
      relationType: 'public-link',
    }), 'public-agent');

    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.equal(
      analysis.privateObservations.some(({ id }) => id === 'normalized-collision-observation'),
      false
    );
    assert.equal(
      analysis.privateRelations.some(({ id }) => id === 'normalized-collision-relation'),
      false
    );
    assert.ok(analysis.issues.some(({ code, observationId, parentEntityIds }) =>
      code === 'ambiguous_private_observation_parent'
      && observationId === 'normalized-collision-observation'
      && parentEntityIds.includes('detail-row-1')
      && parentEntityIds.includes('public-normalized-collision')));
    assert.ok(analysis.issues.some(({ code, relationId, parentEntityIds }) =>
      code === 'ambiguous_private_relation_reference'
      && relationId === 'normalized-collision-relation'
      && parentEntityIds.includes('detail-row-1')
      && parentEntityIds.includes('public-normalized-collision')));
  });
});

test('orphan private-shaped child observations fail closed without reserved names', async (t) => {
  await t.test('an unresolved explicit parent ID is always reported', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('orphan-id-only', 'tenant-a', JSON.stringify({
      entityName: 'ordinary-looking-alias',
      contents: [fixture.fullBody],
      metadata: { entityId: 'lost-non-prefixed-id' },
    }), 'sender-a');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, observationId, reason }) =>
      code === 'orphan_private_observation'
      && observationId === 'orphan-id-only'
      && reason === 'unresolved_parent_id'));
  });

  await t.test('a long source-marked orphan alias is reported', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('orphan-private-shape', 'tenant-a', JSON.stringify({
      entityName: 'lost-private-alias',
      contents: [fixture.fullBody],
      metadata: { source: 'create_entities_inline' },
    }), 'sender-a');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, observationId, sourceMarked, longContent }) =>
      code === 'orphan_private_observation'
      && observationId === 'orphan-private-shape'
      && sourceMarked === true
      && longContent === true));
  });

  await t.test('a private-shaped observation missing every parent reference is reported', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('orphan-without-parent-reference', 'tenant-a', JSON.stringify({
      contents: [fixture.fullBody],
      metadata: { source: 'create_entities_inline' },
    }), 'sender-a');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, observationId, reason }) =>
      code === 'orphan_private_observation'
      && observationId === 'orphan-without-parent-reference'
      && reason === 'missing_private_shaped_parent_reference'));
  });

  await t.test('a long source-marked observation with one public parent remains legitimate', async () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-parent', 'tenant-a', JSON.stringify({
      name: 'public-parent-name',
      type: 'project',
      observations: [],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('public-long-observation', 'tenant-a', JSON.stringify({
      entityName: 'public-parent-name',
      contents: [fixture.fullBody],
      metadata: { entityId: 'public-parent', source: 'add_observations' },
    }), 'public-agent');
    db.close();
    const report = await executeFixture(fixture, '-public-long');
    assert.equal(report.status, 'applied');
    const after = new Database(fixture.dbPath, { readonly: true });
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id IN ('public-parent', 'public-long-observation')").get().count, 2);
    after.close();
  });

  await t.test('a public entity cannot legitimize the reserved private namespace', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-reserved-parent', 'tenant-a', JSON.stringify({
      name: 'msg-detail-public-reserved',
      type: 'project',
      observations: [],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'observation', ?, ?)
    `).run('public-reserved-observation', 'tenant-a', JSON.stringify({
      entityName: 'msg-detail-public-reserved',
      contents: ['short but reserved'],
      metadata: { entityId: 'public-reserved-parent' },
    }), 'public-agent');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, entityId }) =>
      code === 'not_message_detail'
      && entityId === 'public-reserved-parent'));
  });
});

test('relations referencing a private entity are deleted or make analysis refuse', async (t) => {
  await t.test('unambiguous ID, canonical-name, and alias relations are deleted with indexes', async () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    const insertRelation = db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'relation', ?, ?)
    `);
    for (const [relationId, reference] of [
      ['private-relation-alias', 'private-detail-alias'],
      ['private-relation-id', 'detail-row-1'],
      ['private-relation-name', 'msg-detail-message-1'],
    ]) {
      insertRelation.run(relationId, 'tenant-a', JSON.stringify({
        from: reference,
        to: 'public-target',
        relationType: 'mentions',
        properties: {},
      }), 'sender-a');
      for (const [table, column] of [
        ['graph_lookup_keys', 'memory_id'],
        ['entity_lookup_identity_links', 'memory_id'],
        ['entity_context_facets', 'source_row_id'],
      ]) {
        db.prepare(`INSERT INTO ${table} (tenant_id, ${column}) VALUES (?, ?)`)
          .run('tenant-a', relationId);
      }
    }
    db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(15, '[5]');
    db.prepare(`
      INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
      VALUES (?, ?, 'relation', ?, ?)
    `).run('private-relation-alias', 'tenant-a', fixture.fullBody, 15);
    db.close();

    const report = await executeFixture(fixture, '-relation');
    assert.equal(report.status, 'applied');
    assert.equal(report.applied.privateRelationsDeleted, 3);
    assert.equal(report.applied.vectorIndexRowsDeleted, 3);
    const after = new Database(fixture.dbPath, { readonly: true });
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id LIKE 'private-relation-%'").get().count, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM neural_vec_index WHERE memory_id = 'private-relation-alias'").get().count, 0);
    assert.equal(after.prepare('SELECT COUNT(*) AS count FROM shared_memory_vec WHERE rowid = 15').get().count, 0);
    assert.equal(after.prepare("SELECT COUNT(*) AS count FROM graph_lookup_keys WHERE memory_id LIKE 'private-relation-%'").get().count, 0);
    after.close();
  });

  await t.test('a public alias collision makes a private-looking relation ambiguous', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'entity', ?, ?)
    `).run('public-relation-alias', 'tenant-a', JSON.stringify({
      name: 'public-relation-owner',
      aliases: ['private-detail-alias'],
      type: 'project',
      observations: [],
    }), 'public-agent');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'relation', ?, ?)
    `).run('ambiguous-relation', 'tenant-a', JSON.stringify({
      from: 'private-detail-alias',
      to: 'public-target',
      relationType: 'mentions',
    }), 'sender-a');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.equal(analysis.privateRelations.some(({ id }) => id === 'ambiguous-relation'), false);
    assert.ok(analysis.issues.some(({ code, relationId }) =>
      code === 'ambiguous_private_relation_reference' && relationId === 'ambiguous-relation'));
  });

  await t.test('a relation to a missing reserved parent is refused', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'relation', ?, ?)
    `).run('orphan-private-relation', 'tenant-a', JSON.stringify({
      from: 'msg-detail-missing-parent',
      to: 'public-target',
      relationType: 'mentions',
    }), 'sender-a');
    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, relationId }) =>
      code === 'orphan_private_relation_reference' && relationId === 'orphan-private-relation'));
  });
});

test('configured vector table names are bound to analysis and cleanup', async () => {
  const vectorTable = 'hythe_private_vec';
  const vectorIndexTable = 'hythe_private_vec_index';
  const fixture = makeFixture({ vectorTable, vectorIndexTable });
  await withVectorStorageEnvironment(vectorTable, vectorIndexTable, async () => {
    const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
    assert.equal(dry.status, 'ready');
    assert.deepEqual(dry.vectorStorage, { vectorTable, indexTable: vectorIndexTable });
    const report = await runPrivateMessageResidueMigration({
      dbPath: fixture.dbPath,
      execute: true,
      confirm: dry.confirmationToken,
      backupPath: join(fixture.directory, 'custom-vector-backup.db'),
      reportPath: join(fixture.directory, 'custom-vector-report.json'),
    });
    assert.equal(report.status, 'applied');
    assert.deepEqual(readCounts(fixture.dbPath, { vectorTable, vectorIndexTable }), {
      ai: 1,
      shared: 0,
      vectors: 0,
      vec0: 0,
      graph: 0,
      links: 0,
      facets: 0,
      content: fixture.fullBody,
    });
    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('shared_memory_vec', 'neural_vec_index')").get().count, 0);
    db.close();
  });
});

test('configured vector table discovery follows SQLite case-insensitive identifiers', async () => {
  const actualVectorTable = 'HythePrivateVec';
  const actualVectorIndexTable = 'HythePrivateVecIndex';
  const configuredVectorTable = actualVectorTable.toLowerCase();
  const configuredVectorIndexTable = actualVectorIndexTable.toLowerCase();
  const fixture = makeFixture({
    vectorTable: actualVectorTable,
    vectorIndexTable: actualVectorIndexTable,
  });
  await withVectorStorageEnvironment(
    configuredVectorTable,
    configuredVectorIndexTable,
    async () => {
      const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
      assert.equal(dry.status, 'ready');
      assert.equal(dry.counts.vectorIndexRows, 2);
      assert.equal(dry.counts.vec0Rows, 2);
      const report = await runPrivateMessageResidueMigration({
        dbPath: fixture.dbPath,
        execute: true,
        confirm: dry.confirmationToken,
        backupPath: join(fixture.directory, 'case-insensitive-vector-backup.db'),
        reportPath: join(fixture.directory, 'case-insensitive-vector-report.json'),
      });
      assert.equal(report.status, 'applied');
      assert.deepEqual(readCounts(fixture.dbPath, {
        vectorTable: actualVectorTable,
        vectorIndexTable: actualVectorIndexTable,
      }), {
        ai: 1,
        shared: 0,
        vectors: 0,
        vec0: 0,
        graph: 0,
        links: 0,
        facets: 0,
        content: fixture.fullBody,
      });
    }
  );
});

test('unsafe configured vector identifiers abort before mutation', async (t) => {
  for (const [environmentName, vectorTable, vectorIndexTable] of [
    ['SQLITE_VEC_TABLE', 'bad-name', 'neural_vec_index'],
    ['SQLITE_VEC_INDEX_TABLE', 'shared_memory_vec', 'sqlite_private_index'],
  ]) {
    await t.test(environmentName, async () => {
      const fixture = makeFixture();
      const before = readCounts(fixture.dbPath);
      await withVectorStorageEnvironment(vectorTable, vectorIndexTable, async () => {
        const report = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
        assert.equal(report.status, 'aborted');
        assert.match(report.error, new RegExp(`unsafe ${environmentName} identifier`));
      });
      assert.deepEqual(readCounts(fixture.dbPath), before);
    });
  }
});

test('configured vector table names must be distinct under SQLite casing rules', async () => {
  const fixture = makeFixture();
  await withVectorStorageEnvironment('CaseEquivalent', 'caseequivalent', async () => {
    const report = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
    assert.equal(report.status, 'aborted');
    assert.match(report.error, /must be distinct/);
  });
});

test('orphan and ambiguous detail entities refuse the whole migration', async (t) => {
  await t.test('orphan', async () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run('orphan-detail', 'tenant-a', 'entity', JSON.stringify({
      name: 'msg-detail-orphan', type: 'message_detail', observations: [fixture.fullBody], createdBy: 'sender-a',
    }), 'sender-a');
    db.close();
    const before = readCounts(fixture.dbPath);
    const report = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
    assert.equal(report.status, 'refused');
    assert.ok(report.issues.some(({ code }) => code === 'orphan_message_detail'));
    assert.deepEqual(readCounts(fixture.dbPath), before);
  });

  await t.test('ambiguous', async () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run('detail-row-duplicate', 'tenant-a', 'entity', JSON.stringify({
      name: 'msg-detail-message-1', type: 'message_detail', observations: [`${fixture.fullBody}different`], createdBy: 'sender-a',
    }), 'sender-a');
    db.close();
    const report = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
    assert.equal(report.status, 'refused');
    assert.ok(report.issues.some(({ code }) => code === 'ambiguous_pointer_payload'));
  });
});

test('reserved message-detail names and aliases remain private when discriminators are corrupt', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const insert = db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, 'entity', ?, ?)
  `);
  insert.run('corrupt-reserved-name', 'tenant-a', JSON.stringify({
    name: 'msg detail corrupt canonical',
    type: 'project',
    observations: [fixture.fullBody],
  }), 'legacy-sender');
  insert.run('corrupt-reserved-alias', 'tenant-a', JSON.stringify({
    name: 'ordinary-corrupt-parent',
    aliases: ['msg_detail_corrupt_alias'],
    entityType: 'analysis',
    observations: [fixture.fullBody],
  }), 'legacy-sender');
  insert.run('conflicting-private-discriminator', 'tenant-a', JSON.stringify({
    name: 'ordinary-conflicting-discriminator',
    type: 'project',
    entityType: 'message_detail',
    observations: [fixture.fullBody],
  }), 'legacy-sender');

  const analysis = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(analysis.ready, false);
  for (const entityId of ['corrupt-reserved-name', 'corrupt-reserved-alias']) {
    assert.ok(analysis.detailEntities.some(({ id }) => id === entityId));
    assert.ok(analysis.issues.some(({ code, entityId: issueEntityId }) =>
      code === 'not_message_detail' && issueEntityId === entityId));
  }
  assert.ok(analysis.detailEntities.some(({ id }) => id === 'conflicting-private-discriminator'));
  assert.ok(analysis.issues.some(({ code, entityId }) =>
    code === 'orphan_message_detail' && entityId === 'conflicting-private-discriminator'));
});

test('invalid entity and observation rows make analysis fail closed', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const insert = db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, 'tenant-a', ?, ?, 'legacy-sender')
  `);
  insert.run(
    'invalid-private-entity-json',
    'entity',
    `{"name":"msg-detail-truncated","type":"message_detail","observations":["${fixture.fullBody}`
  );
  insert.run('invalid-entity-payload', 'entity', JSON.stringify(['not', 'an', 'entity']));
  insert.run(
    'invalid-private-observation-json',
    'observation',
    `{"entityName":"msg-detail-message-1","contents":["${fixture.fullBody}`
  );
  insert.run('invalid-observation-payload', 'observation', JSON.stringify(['not', 'an', 'observation']));

  const analysis = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(analysis.ready, false);
  for (const [code, idField, id] of [
    ['invalid_entity_json', 'entityId', 'invalid-private-entity-json'],
    ['invalid_entity_payload', 'entityId', 'invalid-entity-payload'],
    ['invalid_observation_json', 'observationId', 'invalid-private-observation-json'],
    ['invalid_observation_payload', 'observationId', 'invalid-observation-payload'],
  ]) {
    assert.ok(analysis.issues.some((entry) => entry.code === code && entry[idField] === id));
  }
});

test('a pointer cannot consume a message-detail entity from another tenant', async () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  db.prepare("UPDATE shared_memory SET tenant_id = 'tenant-b' WHERE id = 'detail-row-1'").run();
  db.prepare("UPDATE neural_vec_index SET tenant_id = 'tenant-b' WHERE memory_id = 'detail-row-1'").run();
  db.close();
  const report = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  assert.equal(report.status, 'refused');
  assert.ok(report.issues.some(({ code }) => code === 'missing_pointer_payload'));
  assert.ok(report.issues.some(({ code }) => code === 'orphan_message_detail'));
});

test('an injected mid-transaction failure rolls back all database changes', async () => {
  const fixture = makeFixture({ realVec0: true });
  const before = readCounts(fixture.dbPath);
  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  const reportPath = join(fixture.directory, 'rollback-report.json');
  const report = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath: join(fixture.directory, 'rollback-backup.db'),
    reportPath,
    failAfterStep: 3,
  });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.rolledBack, true);
  assert.deepEqual(readCounts(fixture.dbPath), before);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status, 'rolled-back');
});

test('successful migration is idempotent on a guarded second execution', async () => {
  const fixture = makeFixture();
  const first = await executeFixture(fixture, '-first');
  assert.equal(first.status, 'applied');
  const afterFirst = readCounts(fixture.dbPath);

  const dry = await runPrivateMessageResidueMigration({ dbPath: fixture.dbPath });
  assert.equal(dry.status, 'ready');
  assert.deepEqual(dry.counts, {
    pointers: 0,
    detailEntities: 0,
    privateObservations: 0,
    privateRelations: 0,
    sharedMessages: 0,
    vectorIndexRows: 0,
    vec0Rows: 0,
    issues: 0,
  });
  const second = await runPrivateMessageResidueMigration({
    dbPath: fixture.dbPath,
    execute: true,
    confirm: dry.confirmationToken,
    backupPath: join(fixture.directory, 'backup-second.db'),
    reportPath: join(fixture.directory, 'report-second.json'),
  });
  assert.equal(second.status, 'applied');
  assert.deepEqual(readCounts(fixture.dbPath), afterFirst);
});

test('analysis detects a vector row that is not represented by a dedicated message', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)').run(99, '[9]');
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, ?, ?, ?, ?)
  `).run('unknown-message', 'tenant-a', 'ai_message', 'private unknown', 99);
  const analysis = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(analysis.ready, false);
  assert.ok(analysis.issues.some(({ code }) => code === 'unrepresented_message_vector'));
});

test('private-shaped vector-only residue is refused instead of guessed away or skipped', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const insertVec = db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)');
  const insertIndex = db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, 'tenant-a', ?, ?, ?)
  `);
  insertVec.run(92, '[92]');
  insertIndex.run('orphan-discriminator-vector', 'knowledge', JSON.stringify({
    name: 'ordinary-vector-name',
    type: 'message_detail',
    observations: [fixture.fullBody],
  }), 92);
  insertVec.run(93, '[93]');
  insertIndex.run('orphan-reserved-vector', 'entity', JSON.stringify({
    name: 'msg detail vector orphan',
    type: 'project',
    observations: [fixture.fullBody],
  }), 93);
  insertVec.run(94, '[94]');
  insertIndex.run('orphan-reserved-arbitrary-vector', 'knowledge', JSON.stringify({
    name: 'ordinary-vector-name',
    aliases: ['msg_detail_vector_alias_orphan'],
    type: 'project',
    observations: [fixture.fullBody],
  }), 94);
  insertVec.run(95, '[95]');
  insertIndex.run('orphan-conflicting-discriminator-vector', 'knowledge', JSON.stringify({
    name: 'ordinary-conflicting-vector',
    type: 'project',
    memoryType: 'message_detail',
    observations: [fixture.fullBody],
  }), 95);

  const analysis = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(analysis.ready, false);
  assert.equal(
    analysis.vectors.some(({ memory_id }) =>
      [
        'orphan-discriminator-vector',
        'orphan-reserved-vector',
        'orphan-reserved-arbitrary-vector',
        'orphan-conflicting-discriminator-vector',
      ].includes(memory_id)),
    false
  );
  for (const [memoryId, reason] of [
    ['orphan-discriminator-vector', 'message_detail_discriminator'],
    ['orphan-reserved-vector', 'reserved_entity_reference'],
    ['orphan-reserved-arbitrary-vector', 'reserved_entity_reference'],
    ['orphan-conflicting-discriminator-vector', 'message_detail_discriminator'],
  ]) {
    assert.ok(analysis.issues.some((entry) =>
      entry.code === 'unrepresented_private_vector'
      && entry.memoryId === memoryId
      && entry.reason === reason));
  }
});

test('unlinked graph vectors fail closed unless a private-shaped observation has one public parent', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, 'tenant-a', 'entity', ?, 'public-agent')
  `).run('public-vector-parent', JSON.stringify({
    name: 'public-vector-parent',
    aliases: ['public-vector-alias'],
    type: 'project',
    observations: [],
  }));
  const insertVec = db.prepare('INSERT INTO shared_memory_vec (rowid, embedding) VALUES (?, ?)');
  const insertIndex = db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES (?, 'tenant-a', ?, ?, ?)
  `);
  const rows = [
    ['malformed-entity-vector', 'entity', '{"name":', 'invalid_graph_json'],
    ['non-object-relation-vector', 'relation', JSON.stringify(['not', 'a', 'relation']), 'invalid_graph_payload'],
    ['unresolved-shaped-observation-vector', 'observation', JSON.stringify({
      entityName: 'lost-private-parent',
      contents: [fixture.fullBody],
      metadata: { source: 'add_observations' },
    }), 'unresolved_private_shaped_observation'],
    ['unresolved-id-observation-vector', 'observation', JSON.stringify({
      entityName: 'public-vector-parent',
      contents: ['short note'],
      metadata: { entityId: 'lost-explicit-id' },
    }), 'unresolved_observation_parent_id'],
  ];
  rows.forEach(([memoryId, memoryType, content], index) => {
    const rowId = 96 + index;
    insertVec.run(rowId, `[${rowId}]`);
    insertIndex.run(memoryId, memoryType, content, rowId);
  });
  insertVec.run(100, '[100]');
  insertIndex.run('resolved-public-observation-vector', 'observation', JSON.stringify({
    entityName: 'public-vector-alias',
    contents: [fixture.fullBody],
    metadata: { source: 'add_observations' },
  }), 100);

  const analysis = analyzePrivateMessageResidue(db);
  db.close();
  assert.equal(analysis.ready, false);
  for (const [memoryId, , , reason] of rows) {
    assert.ok(analysis.issues.some((entry) =>
      entry.code === 'unrepresented_private_vector'
      && entry.memoryId === memoryId
      && entry.reason === reason));
  }
  assert.equal(analysis.issues.some(({ memoryId }) =>
    memoryId === 'resolved-public-observation-vector'), false);
  assert.equal(analysis.vectors.some(({ memory_id }) =>
    memory_id === 'resolved-public-observation-vector'), false);
});

test('shared-message cleanup requires explicit provenance and payload parity', async (t) => {
  await t.test('an unrelated dedicated-message ID collision is refused', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO ai_messages
        (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
      VALUES (?, NULL, ?, ?, ?, ?)
    `).run('collision', 'tenant-a', 'unrelated-sender', 'unrelated-recipient', 'unrelated body');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'ai_message', ?, ?)
    `).run('collision', 'tenant-a', JSON.stringify({
      from: 'legacy-sender', to: 'legacy-recipient', content: 'legacy body',
    }), 'legacy-sender');

    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, sharedMemoryId }) =>
      code === 'unrepresented_shared_message' && sharedMemoryId === 'collision'));
  });

  await t.test('a linked row with different logical payload is refused', () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.prepare(`
      INSERT INTO ai_messages
        (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('linked-primary', 'linked-shared', 'tenant-a', 'sender-a', 'recipient-a', 'dedicated body');
    db.prepare(`
      INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
      VALUES (?, ?, 'ai_message', ?, ?)
    `).run('linked-shared', 'tenant-a', JSON.stringify({
      from: 'sender-a', to: 'recipient-a', content: 'different shared body',
    }), 'sender-a');

    const analysis = analyzePrivateMessageResidue(db);
    db.close();
    assert.equal(analysis.ready, false);
    assert.ok(analysis.issues.some(({ code, sharedMemoryId }) =>
      code === 'shared_message_payload_mismatch' && sharedMemoryId === 'linked-shared'));
  });
});
