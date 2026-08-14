/**
 * Offline physical SQLite sanitation after logical residue migrations.
 *
 * The source is never modified. Plan mode binds a stopped, sidecar-free source
 * snapshot and a new output path to a confirmation token. Execute uses SQLite
 * VACUUM INTO, then compares every logical table, schema object, and vector
 * rowid→embedding mapping before the compacted file can be promoted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePrivateMessageResidue } from './007-private-message-residue.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPLICIT_CUSTODY_TABLE = /^private_message_residue_(?:quarantine|custody(?:_|$)|archive(?:_|$))/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (ArrayBuffer.isView(value)) {
    return { $binary: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return { $type: typeof value, $value: String(value) };
}

function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

async function fileHash(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

function pathIdentity(path) {
  const realpath = realpathSync(resolve(path));
  const stats = statSync(realpath, { bigint: true });
  return {
    realpath,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    bytes: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function sameDatabaseObject(left, right) {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode);
}

function fsyncFileAndParent(path) {
  const fileDescriptor = openSync(path, 'r');
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  const directoryDescriptor = openSync(dirname(path), 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function uniqueSiblingPath(path) {
  return `${path}.unverified-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function fileIdentityFromStats(stats) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.device === right.device && left.inode === right.inode);
}

function pathFileIdentity(path) {
  return fileIdentityFromStats(statSync(path, { bigint: true }));
}

function unlinkIfSameFileIdentity(path, expectedIdentity) {
  try {
    if (!sameFileIdentity(pathFileIdentity(path), expectedIdentity)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonicalProspectivePath(path) {
  const absolute = resolve(path);
  const suffix = [basename(absolute)];
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve output parent for ${absolute}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function assertArtifactNamespacesSafe(dbPath, artifacts) {
  const canonicalDatabase = realpathSync(resolve(dbPath));
  const reserved = new Set([
    canonicalDatabase,
    `${canonicalDatabase}-journal`,
    `${canonicalDatabase}-wal`,
    `${canonicalDatabase}-shm`,
  ]);
  const seen = new Map([[canonicalDatabase, 'database']]);
  for (const { label, path } of artifacts) {
    if (!path) continue;
    const canonical = canonicalProspectivePath(path);
    if (reserved.has(canonical)) {
      throw new Error(`${label} path collides with the source database or SQLite sidecar namespace`);
    }
    const prior = seen.get(canonical);
    if (prior) throw new Error(`${label} path aliases the ${prior} path`);
    seen.set(canonical, label);
  }
}

function createReportWriter(path) {
  if (!path) return null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, 'wx+', 0o600);
  fchmodSync(descriptor, 0o600);
  const identity = fileIdentityFromStats(fstatSync(descriptor, { bigint: true }));
  let closed = false;
  const ownsPublishedPath = () => {
    try {
      return sameFileIdentity(pathFileIdentity(path), identity);
    } catch {
      return false;
    }
  };
  return {
    assertOwned() {
      if (closed || !ownsPublishedPath()) throw new Error('report path ownership changed');
    },
    write(report) {
      if (closed || !ownsPublishedPath()) throw new Error('report path ownership changed');
      const content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      ftruncateSync(descriptor, 0);
      let offset = 0;
      while (offset < content.length) {
        offset += writeSync(descriptor, content, offset, content.length - offset, offset);
      }
      fsyncSync(descriptor);
      if (!ownsPublishedPath()) throw new Error('report path ownership changed during write');
      const directoryDescriptor = openSync(dirname(path), 'r');
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  };
}

function publishNoClobber(temporaryPath, finalPath) {
  linkSync(temporaryPath, finalPath);
  try {
    chmodSync(finalPath, 0o600);
    fsyncFileAndParent(finalPath);
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    try {
      const temporaryStats = statSync(temporaryPath, { bigint: true });
      const finalStats = statSync(finalPath, { bigint: true });
      if (temporaryStats.dev === finalStats.dev && temporaryStats.ino === finalStats.ino) {
        unlinkSync(finalPath);
      }
    } catch {
      // Preserve an independently-created destination and report the publication failure.
    }
    throw error;
  }
}

async function unlinkIfOwnedDatabaseOutput(path, expectedIdentity, expectedFileHash) {
  try {
    const beforeIdentity = pathIdentity(path);
    if (!sameDatabaseObject(beforeIdentity, expectedIdentity)) return false;
    if (await fileHash(path) !== expectedFileHash) return false;
    const afterIdentity = pathIdentity(path);
    if (!sameDatabaseObject(afterIdentity, expectedIdentity)
        || !sameDatabaseObject(afterIdentity, beforeIdentity)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function configuredIdentifier(environmentName, fallback) {
  const value = process.env[environmentName] || fallback;
  if (!SAFE_IDENTIFIER.test(value) || value.toLowerCase().startsWith('sqlite_')) {
    throw new Error(`unsafe ${environmentName} identifier`);
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function actualObjectName(db, requested) {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type IN ('table','view') AND name = ? COLLATE NOCASE
     ORDER BY name COLLATE BINARY`,
  ).all(requested);
  if (rows.length > 1) throw new Error(`ambiguous SQLite object name for ${requested}`);
  return rows[0]?.name ?? null;
}

function loadVecExtensionIfNeeded(db, vectorTable) {
  const actual = actualObjectName(db, vectorTable);
  if (!actual) return null;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE BINARY`,
  ).get(actual);
  if (!/\bUSING\s+vec0\b/i.test(String(row?.sql || ''))) return actual;
  try {
    db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(actual)}`).get();
    return actual;
  } catch {
    // Load below.
  }
  const module = require('sqlite-vec');
  const load = module.load || module.default?.load;
  if (typeof load !== 'function') throw new Error('sqlite-vec has no load() export');
  load(db);
  db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(actual)}`).get();
  return actual;
}

function sidecarState(path) {
  const state = {};
  for (const suffix of ['-wal', '-journal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    state[suffix.slice(1)] = existsSync(sidecar) ? statSync(sidecar).size : 0;
  }
  return state;
}

function assertStoppedSidecars(path) {
  const sidecars = sidecarState(path);
  if (sidecars.wal > 0 || sidecars.journal > 0 || sidecars.shm > 0) {
    throw new Error('database has a non-empty WAL, rollback journal, or SHM; stop all users and remove sidecars after checkpointing');
  }
  return sidecars;
}

function tableDigest(db, table) {
  const rowHashes = [];
  const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`);
  for (const row of statement.iterate()) rowHashes.push(sha256(stableStringify(row)));
  rowHashes.sort();
  return {
    table,
    rows: rowHashes.length,
    digest: sha256(rowHashes.join('\n')),
  };
}

function schemaSnapshot(db) {
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name COLLATE BINARY`,
  ).all();
  return {
    count: objects.length,
    digest: sha256(stableStringify(objects)),
  };
}

function vectorSnapshot(db, vectorTableRequested, indexTableRequested) {
  const vectorTable = actualObjectName(db, vectorTableRequested);
  const indexTable = actualObjectName(db, indexTableRequested);
  if (!vectorTable && !indexTable) {
    return { vectorTable: null, indexTable: null, indexRows: 0, vectorRows: 0, digest: sha256('[]') };
  }
  if (!vectorTable || !indexTable) throw new Error('vector table and index table must either both exist or both be absent');
  loadVecExtensionIfNeeded(db, vectorTable);
  const vectorByRowId = new Map();
  for (const row of db.prepare(
    `SELECT rowid, * FROM ${quoteIdentifier(vectorTable)} ORDER BY rowid`,
  ).iterate()) {
    const { rowid, ...payload } = row;
    vectorByRowId.set(rowid, sha256(stableStringify(payload)));
  }
  const mappings = [];
  for (const row of db.prepare(
    `SELECT memory_id, tenant_id, vector_rowid
     FROM ${quoteIdentifier(indexTable)}
     ORDER BY tenant_id COLLATE BINARY, memory_id COLLATE BINARY`,
  ).iterate()) {
    mappings.push({
      memoryId: row.memory_id,
      tenantId: row.tenant_id,
      vectorRowId: row.vector_rowid,
      embeddingHash: row.vector_rowid == null ? null : vectorByRowId.get(row.vector_rowid) ?? null,
    });
    if (row.vector_rowid != null && !vectorByRowId.has(row.vector_rowid)) {
      throw new Error(`vector index references missing rowid ${row.vector_rowid}`);
    }
  }
  return {
    vectorTable,
    indexTable,
    indexRows: mappings.length,
    vectorRows: vectorByRowId.size,
    digest: sha256(stableStringify({
      mappings,
      allVectors: [...vectorByRowId.entries()].map(([rowId, embeddingHash]) => ({ rowId, embeddingHash })),
    })),
  };
}

function logicalSnapshot(db, vectorTable, indexTable) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name COLLATE BINARY`,
  ).all().map((row) => row.name);
  const tableDigests = tables.map((table) => tableDigest(db, table));
  const schema = schemaSnapshot(db);
  const vectors = vectorSnapshot(db, vectorTable, indexTable);
  return {
    schema,
    tables: tableDigests,
    vectors,
    digest: sha256(stableStringify({ schema, tables: tableDigests, vectors })),
  };
}

function custodySnapshot(db) {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name COLLATE BINARY
  `).all().map((row) => row.name).filter((name) => EXPLICIT_CUSTODY_TABLE.test(name));
  const custodyTables = tables.map((table) => ({
    table,
    rows: db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count,
  }));
  return {
    tables: custodyTables,
    totalRows: custodyTables.reduce((sum, table) => sum + table.rows, 0),
  };
}

function residueSummary(db) {
  const analysis = analyzePrivateMessageResidue(db);
  const clean = analysis.ready
    && analysis.counts.issues === 0
    && Object.entries(analysis.counts)
      .filter(([key]) => key !== 'issues')
      .every(([, value]) => value === 0);
  return {
    clean,
    ready: analysis.ready,
    fingerprint: analysis.fingerprint,
    counts: analysis.counts,
    issueCodes: [...new Set(analysis.issues.map((issue) => issue.code))].sort(),
  };
}

function databaseChecks(db) {
  const quickCheck = db.pragma('quick_check', { simple: true });
  const integrityRows = db.pragma('integrity_check');
  const integrityCheck = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok'
    ? 'ok'
    : integrityRows;
  const foreignKeyRows = db.pragma('foreign_key_check');
  return { quickCheck, integrityCheck, foreignKeyViolations: foreignKeyRows.length };
}

async function inspectDatabase(path) {
  const beforeSidecars = assertStoppedSidecars(path);
  const beforeIdentity = pathIdentity(path);
  const beforeHash = await fileHash(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  let inspection;
  try {
    db.pragma('foreign_keys = ON');
    const vectorTable = configuredIdentifier('SQLITE_VEC_TABLE', 'shared_memory_vec');
    const indexTable = configuredIdentifier('SQLITE_VEC_INDEX_TABLE', 'neural_vec_index');
    loadVecExtensionIfNeeded(db, vectorTable);
    inspection = {
      checks: databaseChecks(db),
      pageSize: db.pragma('page_size', { simple: true }),
      pageCount: db.pragma('page_count', { simple: true }),
      freelistCount: db.pragma('freelist_count', { simple: true }),
      journalMode: db.pragma('journal_mode', { simple: true }),
      logical: logicalSnapshot(db, vectorTable, indexTable),
      residue: residueSummary(db),
      custody: custodySnapshot(db),
    };
  } finally {
    db.close();
  }
  const afterHash = await fileHash(path);
  const afterSidecars = assertStoppedSidecars(path);
  const afterIdentity = pathIdentity(path);
  if (beforeHash !== afterHash || beforeSidecars.wal !== afterSidecars.wal
      || beforeSidecars.journal !== afterSidecars.journal
      || beforeSidecars.shm !== afterSidecars.shm
      || JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity)) {
    throw new Error('database changed during inspection');
  }
  return {
    path,
    pathIdentity: afterIdentity,
    bytes: statSync(path).size,
    fileHash: afterHash,
    sidecars: afterSidecars,
    ...inspection,
  };
}

function ensureNewPath(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} path already exists`);
  return absolute;
}

function writeReport(writer, report) {
  writer?.write(report);
}

function publicInspection(inspection) {
  return {
    path: inspection.path,
    pathIdentity: inspection.pathIdentity,
    bytes: inspection.bytes,
    fileHash: inspection.fileHash,
    sidecars: inspection.sidecars,
    checks: inspection.checks,
    pageSize: inspection.pageSize,
    pageCount: inspection.pageCount,
    freelistCount: inspection.freelistCount,
    journalMode: inspection.journalMode,
    logical: {
      schema: inspection.logical.schema,
      tableCount: inspection.logical.tables.length,
      tables: inspection.logical.tables,
      vectors: inspection.logical.vectors,
      digest: inspection.logical.digest,
    },
    residue: inspection.residue,
    custody: inspection.custody,
  };
}

function verifiedOutputMatches(output, stagedOutput, stagedIdentity) {
  const sidecarsClean = output.sidecars.wal === 0
    && output.sidecars.journal === 0
    && output.sidecars.shm === 0;
  return sameDatabaseObject(output.pathIdentity, stagedIdentity)
    && output.bytes === stagedOutput.bytes
    && output.fileHash === stagedOutput.fileHash
    && output.logical.digest === stagedOutput.logical.digest
    && output.logical.vectors.digest === stagedOutput.logical.vectors.digest
    && output.checks.quickCheck === 'ok'
    && output.checks.integrityCheck === 'ok'
    && output.checks.foreignKeyViolations === 0
    && output.freelistCount === 0
    && output.residue.clean
    && output.custody.totalRows === 0
    && sidecarsClean;
}

export async function planVacuumSanitation(options) {
  const sourcePath = resolve(options.dbPath);
  const outputPath = ensureNewPath(options.outputPath, 'output');
  assertArtifactNamespacesSafe(sourcePath, [{ label: 'output', path: outputPath }]);
  const source = await inspectDatabase(sourcePath);
  const ready = source.checks.quickCheck === 'ok'
    && source.checks.integrityCheck === 'ok'
    && source.checks.foreignKeyViolations === 0
    && source.residue.clean
    && source.custody.totalRows === 0;
  const fingerprint = sha256(stableStringify({
    sourcePath,
    outputPath,
    sourceFileHash: source.fileHash,
    sourcePathIdentity: source.pathIdentity,
    logicalDigest: source.logical.digest,
    residueFingerprint: source.residue.fingerprint,
    custody: source.custody,
  }));
  return {
    tool: 'vacuum-sanitized-database',
    mode: 'plan',
    status: ready ? 'ready' : 'refused',
    ready,
    source: publicInspection(source),
    outputPath,
    fingerprint,
    confirmationToken: ready ? `VACUUM-SANITIZED-${fingerprint.slice(0, 20).toUpperCase()}` : null,
    errors: [
      ...(source.checks.quickCheck === 'ok' ? [] : ['quick_check_failed']),
      ...(source.checks.integrityCheck === 'ok' ? [] : ['integrity_check_failed']),
      ...(source.checks.foreignKeyViolations === 0 ? [] : ['foreign_key_check_failed']),
      ...(source.residue.clean ? [] : ['migration_007_not_logically_clean']),
      ...(source.custody.totalRows === 0 ? [] : ['private_custody_not_empty']),
    ],
  };
}

export async function runVacuumSanitation(options) {
  const plan = await planVacuumSanitation(options);
  const reportPath = options.reportPath ? ensureNewPath(options.reportPath, 'report') : null;
  assertArtifactNamespacesSafe(plan.source.path, [
    { label: 'output', path: plan.outputPath },
    { label: 'report', path: reportPath },
  ]);
  let reportWriter = null;
  try {
    reportWriter = createReportWriter(reportPath);
    if (!options.execute) {
      const report = { ...plan, completedAt: new Date().toISOString() };
      writeReport(reportWriter, report);
      return report;
    }
    if (!reportPath) throw new Error('--report is required in execute mode');
    if (!plan.ready) {
      const report = { ...plan, mode: 'execute', completedAt: new Date().toISOString() };
      writeReport(reportWriter, report);
      return report;
    }
    if (options.confirm !== plan.confirmationToken) {
      const report = {
        ...plan,
        mode: 'execute',
        status: 'refused',
        ready: false,
        fingerprint: null,
        confirmationToken: null,
        errors: [...plan.errors, 'confirmation_token_mismatch'],
        completedAt: new Date().toISOString(),
      };
      writeReport(reportWriter, report);
      return report;
    }

    const pending = {
      ...plan,
      mode: 'execute',
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    writeReport(reportWriter, pending);
    if (typeof options.afterPendingReport === 'function') options.afterPendingReport();
    reportWriter.assertOwned();
    mkdirSync(dirname(plan.outputPath), { recursive: true, mode: 0o700 });
    let temporaryOutput = null;
    let temporaryDescriptor = null;
    let temporaryIdentity = null;
    let promotedByThisRun = false;
    let promotedIdentity = null;
    let promotedFileHash = null;
    const cleanupTemporary = () => {
      if (temporaryOutput && temporaryIdentity) {
        unlinkIfSameFileIdentity(temporaryOutput, temporaryIdentity);
      }
      if (temporaryDescriptor != null) {
        try { closeSync(temporaryDescriptor); } catch { /* already closed */ }
      }
      temporaryOutput = null;
      temporaryDescriptor = null;
      temporaryIdentity = null;
    };
    try {
      if (JSON.stringify(pathIdentity(plan.source.path)) !== JSON.stringify(plan.source.pathIdentity)) {
        throw new Error('source database path identity changed after planning');
      }
      temporaryOutput = uniqueSiblingPath(plan.outputPath);
      if (typeof options.beforeTemporaryReservation === 'function') {
        options.beforeTemporaryReservation(temporaryOutput);
      }
      temporaryDescriptor = openSync(temporaryOutput, 'wx+', 0o600);
      fchmodSync(temporaryDescriptor, 0o600);
      temporaryIdentity = fileIdentityFromStats(fstatSync(temporaryDescriptor, { bigint: true }));
      const sourceDb = new Database(plan.source.pathIdentity.realpath, { readonly: true, fileMustExist: true });
      const previousUmask = process.umask(0o077);
      try {
        loadVecExtensionIfNeeded(sourceDb, configuredIdentifier('SQLITE_VEC_TABLE', 'shared_memory_vec'));
        sourceDb.prepare('VACUUM INTO ?').run(temporaryOutput);
      } finally {
        process.umask(previousUmask);
        sourceDb.close();
      }
      if (!sameFileIdentity(pathFileIdentity(temporaryOutput), temporaryIdentity)) {
        throw new Error('sanitation staging path ownership changed during VACUUM');
      }
      fchmodSync(temporaryDescriptor, 0o600);
      fsyncSync(temporaryDescriptor);
      const stagingDirectoryDescriptor = openSync(dirname(temporaryOutput), 'r');
      try {
        fsyncSync(stagingDirectoryDescriptor);
      } finally {
        closeSync(stagingDirectoryDescriptor);
      }

      const sourceAfter = await inspectDatabase(plan.source.path);
      const stagedOutput = await inspectDatabase(temporaryOutput);
      if (!sameFileIdentity(
        {
          device: stagedOutput.pathIdentity.device,
          inode: stagedOutput.pathIdentity.inode,
        },
        temporaryIdentity
      )) {
        throw new Error('sanitation staging path ownership changed during verification');
      }
      const sourceUnchanged = sourceAfter.fileHash === plan.source.fileHash
        && sourceAfter.logical.digest === plan.source.logical.digest
        && JSON.stringify(sourceAfter.pathIdentity) === JSON.stringify(plan.source.pathIdentity);
      const logicalMatch = stagedOutput.logical.digest === plan.source.logical.digest;
      const vectorMatch = stagedOutput.logical.vectors.digest === plan.source.logical.vectors.digest;
      const outputSidecarsClean = stagedOutput.sidecars.wal === 0
        && stagedOutput.sidecars.journal === 0
        && stagedOutput.sidecars.shm === 0;
      const stagedVerified = sourceUnchanged
        && logicalMatch
        && vectorMatch
        && stagedOutput.checks.quickCheck === 'ok'
        && stagedOutput.checks.integrityCheck === 'ok'
        && stagedOutput.checks.foreignKeyViolations === 0
        && stagedOutput.freelistCount === 0
        && stagedOutput.residue.clean
        && stagedOutput.custody.totalRows === 0
        && outputSidecarsClean;
      if (!stagedVerified) {
        cleanupTemporary();
        const report = {
          ...pending,
          status: 'verification-failed',
          verified: false,
          verification: {
            sourceUnchanged,
            logicalMatch,
            vectorMatch,
            outputFreelistZero: stagedOutput.freelistCount === 0,
            outputSidecarsClean,
            custodyEmpty: stagedOutput.custody.totalRows === 0,
            promoted: false,
          },
          sourceAfter: publicInspection(sourceAfter),
          stagedOutput: publicInspection(stagedOutput),
          completedAt: new Date().toISOString(),
        };
        writeReport(reportWriter, report);
        return report;
      }
      if (options.failAfterStagedVerification) {
        throw new Error('injected failure after staged sanitation verification');
      }
      const stagedIdentity = stagedOutput.pathIdentity;
      if (typeof options.beforeOutputPromotion === 'function') options.beforeOutputPromotion();
      reportWriter.assertOwned();
      if (!sameFileIdentity(pathFileIdentity(temporaryOutput), temporaryIdentity)
          || await fileHash(temporaryOutput) !== stagedOutput.fileHash) {
        throw new Error('verified sanitation staging path changed before promotion');
      }
      publishNoClobber(temporaryOutput, plan.outputPath);
      temporaryOutput = null;
      promotedByThisRun = true;
      promotedIdentity = stagedIdentity;
      promotedFileHash = stagedOutput.fileHash;
      closeSync(temporaryDescriptor);
      temporaryDescriptor = null;
      temporaryIdentity = null;
      if (typeof options.afterOutputPromotion === 'function') options.afterOutputPromotion();

      const output = await inspectDatabase(plan.outputPath);
      const promotionMatch = verifiedOutputMatches(output, stagedOutput, stagedIdentity);
      const verified = stagedVerified && promotionMatch;
      if (!verified) {
        await unlinkIfOwnedDatabaseOutput(plan.outputPath, promotedIdentity, promotedFileHash);
        promotedByThisRun = false;
      }
      const report = {
        ...pending,
        status: verified ? 'verified' : 'verification-failed',
        verified,
        verification: {
          sourceUnchanged,
          logicalMatch,
          vectorMatch,
          outputFreelistZero: stagedOutput.freelistCount === 0,
          outputSidecarsClean,
          custodyEmpty: stagedOutput.custody.totalRows === 0,
          promoted: verified,
          promotionMatch,
        },
        sourceAfter: publicInspection(sourceAfter),
        output: publicInspection(output),
        completedAt: new Date().toISOString(),
      };
      if (typeof options.beforeFinalReportWrite === 'function') options.beforeFinalReportWrite();
      const finalOutput = await inspectDatabase(plan.outputPath);
      const finalOutputMatch = verifiedOutputMatches(finalOutput, stagedOutput, stagedIdentity);
      if (!finalOutputMatch) {
        throw new Error('verified sanitation output changed before final report');
      }
      report.output = publicInspection(finalOutput);
      report.verification.finalOutputMatch = true;
      reportWriter.assertOwned();
      writeReport(reportWriter, report);
      return report;
    } catch (error) {
      cleanupTemporary();
      if (promotedByThisRun && promotedIdentity && promotedFileHash) {
        await unlinkIfOwnedDatabaseOutput(plan.outputPath, promotedIdentity, promotedFileHash);
      }
      const report = {
        ...pending,
        status: 'verification-failed',
        verified: false,
        error: error.message,
        verification: { promoted: false },
        completedAt: new Date().toISOString(),
      };
      try {
        writeReport(reportWriter, report);
      } catch (reportError) {
        report.reportWriteError = reportError.message;
      }
      return report;
    }
  } finally {
    reportWriter?.close();
  }
}

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!options.dbPath && !arg.startsWith('--')) options.dbPath = arg;
    else if (arg === '--output') options.outputPath = argv[++index];
    else if (arg === '--report') options.reportPath = argv[++index];
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--confirm') options.confirm = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.dbPath || !options.outputPath) {
    throw new Error('usage: node vacuum-sanitized-database.mjs <db-path> --output <new-db> [--report <new-json>] [--execute --confirm <token>]');
  }
  return options;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const report = await runVacuumSanitation(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'refused' || report.status === 'verification-failed') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`vacuum sanitation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
