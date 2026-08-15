import assert from 'node:assert/strict';
import test from 'node:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { planVacuumSanitation, runVacuumSanitation } from './vacuum-sanitized-database.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hythe-vacuum-sanitize-'));
  const dbPath = join(directory, 'source.db');
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
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
    CREATE TABLE neural_vec_index (
      memory_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      vector_rowid INTEGER
    );
    CREATE TABLE shared_memory_vec (embedding TEXT);
    INSERT INTO shared_memory VALUES
      ('public-1', 'default', 'entity', '{"name":"public-1","type":"project","observations":[]}', 'agent-a');
    INSERT INTO shared_memory_vec(rowid, embedding) VALUES (41, '[0.1,0.2]');
    INSERT INTO neural_vec_index VALUES
      ('public-1', 'default', 'entity', '{"name":"public-1","type":"project","observations":[]}', 41);
    CREATE TABLE deleted_material (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
  `);
  const secret = `PHYSICAL-DELETED-SECRET-${'x'.repeat(4096)}`;
  const insert = db.prepare('INSERT INTO deleted_material(content) VALUES (?)');
  const transaction = db.transaction(() => {
    for (let index = 0; index < 150; index += 1) insert.run(`${secret}-${index}`);
  });
  transaction();
  db.exec('DELETE FROM deleted_material');
  db.close();
  return { directory, dbPath, secret };
}

test('plan is read-only, requires logical 007 cleanliness, and binds the output path', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const before = readFileSync(value.dbPath);
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  assert.equal(plan.status, 'ready', JSON.stringify({ errors: plan.errors, residue: plan.source.residue }));
  assert.equal(plan.source.residue.clean, true);
  assert.ok(plan.source.freelistCount > 0, 'fixture must contain deleted free pages');
  assert.match(plan.confirmationToken, /^VACUUM-SANITIZED-[A-F0-9]{20}$/);
  assert.equal(existsSync(outputPath), false);
  assert.deepEqual(readFileSync(value.dbPath), before);
  const other = await planVacuumSanitation({
    dbPath: value.dbPath,
    outputPath: join(value.directory, 'different.db'),
  });
  assert.notEqual(other.confirmationToken, plan.confirmationToken);
});

test('wrong confirmation creates no database while execute verifies a compact body-free copy', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const refused = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'wrong-token.json'),
    execute: true,
    confirm: 'VACUUM-SANITIZED-WRONG',
  });
  assert.equal(refused.status, 'refused');
  assert.equal(existsSync(outputPath), false);
  assert.equal(refused.confirmationToken, null);
  assert.equal(refused.fingerprint, null);

  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'execute.json'),
    execute: true,
    confirm: plan.confirmationToken,
  });
  assert.equal(report.status, 'verified');
  assert.equal(report.verified, true);
  assert.equal(report.verification.sourceUnchanged, true);
  assert.equal(report.verification.logicalMatch, true);
  assert.equal(report.verification.vectorMatch, true);
  assert.equal(report.verification.custodyEmpty, true);
  assert.equal(report.verification.promoted, true);
  assert.equal(report.verification.promotionMatch, true);
  assert.equal(report.output.freelistCount, 0);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(outputPath).includes(Buffer.from(value.secret)), false);
  assert.equal(JSON.stringify(report).includes(value.secret), false);
  assert.equal(readdirSync(value.directory).some((name) => name.includes('.unverified-')), false);
});

test('non-empty WAL residue refuses inspection before output creation', async () => {
  const value = fixture();
  writeFileSync(`${value.dbPath}-wal`, 'not checkpointed');
  const outputPath = join(value.directory, 'sanitized.db');
  await assert.rejects(
    planVacuumSanitation({ dbPath: value.dbPath, outputPath }),
    /non-empty WAL/,
  );
  assert.equal(existsSync(outputPath), false);
});

test('non-empty SHM residue refuses inspection before output creation', async () => {
  const value = fixture();
  writeFileSync(`${value.dbPath}-shm`, 'live shared-memory state');
  const outputPath = join(value.directory, 'sanitized.db');
  await assert.rejects(
    planVacuumSanitation({ dbPath: value.dbPath, outputPath }),
    /non-empty WAL, rollback journal, or SHM/,
  );
  assert.equal(existsSync(outputPath), false);
});

test('output and report paths cannot use the source SQLite sidecar namespace', async () => {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const outputCollision = fixture();
    const sidecarOutput = `${outputCollision.dbPath}${suffix}`;
    await assert.rejects(
      planVacuumSanitation({ dbPath: outputCollision.dbPath, outputPath: sidecarOutput }),
      /collides with the source database or SQLite sidecar namespace/,
      `output:${suffix}`
    );
    assert.equal(existsSync(sidecarOutput), false, `output:${suffix}`);

    const reportCollision = fixture();
    const outputPath = join(reportCollision.directory, `safe-output${suffix}.db`);
    const plan = await planVacuumSanitation({ dbPath: reportCollision.dbPath, outputPath });
    const sidecarReport = `${reportCollision.dbPath}${suffix}`;
    await assert.rejects(
      runVacuumSanitation({
        dbPath: reportCollision.dbPath,
        outputPath,
        reportPath: sidecarReport,
        execute: true,
        confirm: plan.confirmationToken,
      }),
      /collides with the source database or SQLite sidecar namespace/,
      `report:${suffix}`
    );
    assert.equal(existsSync(sidecarReport), false, `report:${suffix}`);
    assert.equal(existsSync(outputPath), false, `report:${suffix}`);
  }
});

test('execute refuses an output path that aliases its report path', async () => {
  const value = fixture();
  const sharedPath = join(value.directory, 'output-and-report.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath: sharedPath });
  await assert.rejects(
    runVacuumSanitation({
      dbPath: value.dbPath,
      outputPath: sharedPath,
      reportPath: sharedPath,
      execute: true,
      confirm: plan.confirmationToken,
    }),
    /report path aliases the output path/
  );
  assert.equal(existsSync(sharedPath), false);
});

test('sanitation refuses plaintext quarantine and any explicit residue custody table', async () => {
  for (const table of ['private_message_residue_quarantine', 'private_message_residue_custody_export']) {
    const value = fixture();
    const db = new Database(value.dbPath);
    db.exec(`CREATE TABLE ${table} (row_json TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} (row_json) VALUES (?)`).run('PRIVATE-CUSTODY-BODY');
    db.close();
    const outputPath = join(value.directory, 'sanitized.db');
    const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
    assert.equal(plan.status, 'refused', table);
    assert.equal(plan.source.custody.totalRows, 1, table);
    assert.ok(plan.errors.includes('private_custody_not_empty'), table);
    assert.equal(existsSync(outputPath), false, table);
  }
});

test('failed staged verification leaves no final or temporary database', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'failed-stage.json'),
    execute: true,
    confirm: plan.confirmationToken,
    failAfterStagedVerification: true,
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(report.verification.promoted, false);
  assert.equal(existsSync(outputPath), false);
  assert.equal(readdirSync(value.directory).some((name) => name.includes('.unverified-')), false);
});

test('verified output promotion refuses a destination race without overwriting it', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const sourceBefore = readFileSync(value.dbPath);
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-SANITATION-DESTINATION';
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'destination-race.json'),
    execute: true,
    confirm: plan.confirmationToken,
    beforeOutputPromotion() {
      writeFileSync(outputPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(report.verified, false);
  assert.equal(report.verification.promoted, false);
  assert.equal(readFileSync(outputPath, 'utf8'), marker);
  assert.deepEqual(readFileSync(value.dbPath), sourceBefore);
  assert.equal(readdirSync(value.directory).some((name) => name.includes('.unverified-')), false);
});

test('post-promotion verification never deletes an independently replaced output', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-POST-PROMOTION-DESTINATION';
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'post-promotion-race.json'),
    execute: true,
    confirm: plan.confirmationToken,
    afterOutputPromotion() {
      unlinkSync(outputPath);
      writeFileSync(outputPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(report.verified, false);
  assert.equal(report.verification.promoted, false);
  assert.equal(readFileSync(outputPath, 'utf8'), marker);
  assert.equal(readdirSync(value.directory).some((name) => name.includes('.unverified-')), false);
});

test('staged-output cleanup preserves an independently replaced temporary path', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-STAGED-OUTPUT';
  let replacedPath;
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'staged-output-race.json'),
    execute: true,
    confirm: plan.confirmationToken,
    beforeOutputPromotion() {
      const name = readdirSync(value.directory).find((entry) => entry.includes('.unverified-'));
      assert.ok(name);
      replacedPath = join(value.directory, name);
      unlinkSync(replacedPath);
      writeFileSync(replacedPath, marker, { flag: 'wx', mode: 0o600 });
      throw new Error('injected replacement of staged sanitation output');
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(readFileSync(replacedPath, 'utf8'), marker);
  assert.equal(existsSync(outputPath), false);
});

test('failed temporary reservation never deletes a preexisting path', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'PREEXISTING-STAGED-PATH';
  let reservedPath;
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath: join(value.directory, 'temporary-reservation-race.json'),
    execute: true,
    confirm: plan.confirmationToken,
    beforeTemporaryReservation(path) {
      reservedPath = path;
      writeFileSync(path, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(readFileSync(reservedPath, 'utf8'), marker);
  assert.equal(existsSync(outputPath), false);
});

test('a replaced pending report is preserved and aborts before output creation', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const reportPath = join(value.directory, 'report-race.json');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-SANITATION-REPORT';
  await assert.rejects(
    runVacuumSanitation({
      dbPath: value.dbPath,
      outputPath,
      reportPath,
      execute: true,
      confirm: plan.confirmationToken,
      afterPendingReport() {
        unlinkSync(reportPath);
        writeFileSync(reportPath, marker, { flag: 'wx', mode: 0o600 });
      },
    }),
    /report path ownership changed/
  );
  assert.equal(readFileSync(reportPath, 'utf8'), marker);
  assert.equal(existsSync(outputPath), false);
});

test('final report replacement is preserved and removes only the owned output', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const reportPath = join(value.directory, 'final-report-race.json');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-FINAL-SANITATION-REPORT';
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath,
    execute: true,
    confirm: plan.confirmationToken,
    beforeFinalReportWrite() {
      unlinkSync(reportPath);
      writeFileSync(reportPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.match(report.reportWriteError, /report path ownership changed/);
  assert.equal(readFileSync(reportPath, 'utf8'), marker);
  assert.equal(existsSync(outputPath), false);
});

test('final output replacement is preserved and can never be reported as verified', async () => {
  const value = fixture();
  const outputPath = join(value.directory, 'sanitized.db');
  const reportPath = join(value.directory, 'final-output-race.json');
  const plan = await planVacuumSanitation({ dbPath: value.dbPath, outputPath });
  const marker = 'INDEPENDENT-UNVERIFIED-SANITATION-OUTPUT';
  const report = await runVacuumSanitation({
    dbPath: value.dbPath,
    outputPath,
    reportPath,
    execute: true,
    confirm: plan.confirmationToken,
    beforeFinalReportWrite() {
      unlinkSync(outputPath);
      writeFileSync(outputPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'verification-failed');
  assert.equal(report.verified, false);
  assert.equal(report.verification.promoted, false);
  assert.equal(readFileSync(outputPath, 'utf8'), marker);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(persisted.status, 'verification-failed');
  assert.equal(persisted.verified, false);
});

test('real vec0 rowid-to-embedding mappings survive VACUUM INTO exactly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hythe-vacuum-real-vec-'));
  const dbPath = join(directory, 'source.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE ai_messages (
      id TEXT PRIMARY KEY, legacy_shared_memory_id TEXT UNIQUE,
      tenant_id TEXT NOT NULL, from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL, content TEXT NOT NULL
    );
    CREATE TABLE shared_memory (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, memory_type TEXT NOT NULL,
      content TEXT NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE neural_vec_index (
      memory_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      memory_type TEXT NOT NULL, content TEXT NOT NULL, vector_rowid INTEGER
    );
    CREATE VIRTUAL TABLE shared_memory_vec USING vec0(embedding float[2]);
    INSERT INTO shared_memory VALUES
      ('public-vec', 'default', 'entity', '{"name":"public-vec","type":"project","observations":[]}', 'agent-a');
    INSERT INTO shared_memory_vec(rowid, embedding) VALUES (73, '[0.25,0.75]');
    INSERT INTO neural_vec_index VALUES
      ('public-vec', 'default', 'entity', '{"name":"public-vec","type":"project","observations":[]}', 73);
  `);
  db.close();
  const outputPath = join(directory, 'sanitized.db');
  const plan = await planVacuumSanitation({ dbPath, outputPath });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.errors));
  const report = await runVacuumSanitation({
    dbPath,
    outputPath,
    reportPath: join(directory, 'execute.json'),
    execute: true,
    confirm: plan.confirmationToken,
  });
  assert.equal(report.status, 'verified', JSON.stringify(report.verification));
  assert.equal(report.verification.vectorMatch, true);
  assert.equal(report.output.logical.vectors.vectorRows, 1);
  assert.equal(report.output.logical.vectors.indexRows, 1);
});
