/**
 * Offline adjudication companion for migration 007.
 *
 * This tool never invents a disposition. Inventory is the default and opens
 * the database read-only. Plan requires a complete, hash-bound manifest. An
 * execute run additionally requires the exact plan confirmation token, a new
 * SQLite backup, and a new body-free report.
 *
 * Automated in this first version:
 *   - quarantine
 *   - restore_mailbox
 *   - private_duplicate
 *   - stale_vector_remove
 *
 * Explicitly refused until purpose-built adapters exist:
 *   - public_relink (graph-index and embedding rebuild required)
 *   - archive_then_remove_private (cryptographic archive verification required)
 *   - public_vector_rebuild (offline embedding runtime required)
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmodSync,
  closeSync,
  createReadStream,
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
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePrivateMessageResidue } from './007-private-message-residue.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;
const AUDIT_TABLE = 'private_message_residue_adjudication_audit';
const QUARANTINE_TABLE = 'private_message_residue_quarantine';
const SAFE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const POINTER_RE = /^Full content stored as entity "([^"\r\n]+)"(?:\.|\s|$)/;
const ANCILLARY_TABLES = [
  { table: 'graph_lookup_keys', idColumn: 'memory_id' },
  { table: 'entity_lookup_identity_links', idColumn: 'memory_id' },
  { table: 'entity_context_facets', idColumn: 'source_row_id' },
];
const MANUAL_ADAPTER_DISPOSITIONS = new Set([
  'public_relink',
  'archive_then_remove_private',
  'public_vector_rebuild',
]);
const ALLOWED_DISPOSITIONS = new Set([
  ...MANUAL_ADAPTER_DISPOSITIONS,
  'restore_mailbox',
  'private_duplicate',
  'quarantine',
  'stale_vector_remove',
]);
const VECTOR_ISSUE_CODES = new Set([
  'unrepresented_private_vector',
  'unrepresented_message_vector',
  'ambiguous_message_vector',
  'message_vector_tenant_mismatch',
  'missing_vec0_table',
  'missing_vec0_row',
  'shared_vec0_row',
  'vec0_row_referenced_by_non_target',
]);
const OBSERVATION_ISSUE_CODES = new Set([
  'orphan_private_observation',
  'ambiguous_private_observation_parent',
  'private_observation_parent_mismatch',
  'invalid_observation_json',
  'invalid_observation_payload',
]);
const RELATION_ISSUE_CODES = new Set([
  'orphan_private_relation_reference',
  'ambiguous_private_relation_reference',
  'invalid_relation_json',
  'invalid_relation_payload',
]);
const DETAIL_ISSUE_CODES = new Set([
  'orphan_message_detail',
  'invalid_entity_json',
  'invalid_entity_payload',
  'not_message_detail',
  'missing_entity_name',
  'invalid_payload_observations',
  'pointer_resolves_non_private_entity',
  'pointer_entity_case_mismatch',
  'unexpected_payload_memory_type',
  'payload_creator_mismatch',
  'payload_embedded_creator_mismatch',
  'payload_referenced_multiple_times',
]);
const SHARED_MESSAGE_ISSUE_CODES = new Set([
  'unrepresented_shared_message',
  'ambiguous_shared_message',
  'shared_message_tenant_mismatch',
  'invalid_shared_message_json',
  'invalid_shared_message_payload',
  'invalid_shared_message_fields',
  'shared_message_payload_mismatch',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { $number: String(value) };
    return value;
  }
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

function immutableJsonClone(value, label = 'value') {
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(cloned);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
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

function databasePathIdentity(path) {
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
    && left.realpath === right.realpath
    && left.device === right.device
    && left.inode === right.inode);
}

function databasePathFromConnection(db) {
  const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
  if (!main?.file) throw new Error('adjudication requires a file-backed main SQLite database');
  return main.file;
}

function logicalDatabaseSnapshot(db) {
  const schemaObjects = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name COLLATE BINARY
  `).all();
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name COLLATE BINARY
  `).all().map((row) => row.name);
  const tableDigests = [];
  for (const table of tables) {
    const rowHashes = [];
    const tableSql = schemaObjects.find((object) => object.type === 'table' && object.name === table)?.sql || '';
    const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
      .map((column) => String(column.name).toLowerCase()));
    const rowIdAlias = /\bWITHOUT\s+ROWID\b/i.test(tableSql)
      ? null
      : ['rowid', '_rowid_', 'oid'].find((candidate) => !columns.has(candidate));
    const select = rowIdAlias
      ? `SELECT ${rowIdAlias} AS __pmra_logical_rowid, * FROM ${quoteIdentifier(table)}`
      : `SELECT * FROM ${quoteIdentifier(table)}`;
    for (const row of db.prepare(select).iterate()) {
      rowHashes.push(valueHash(row));
    }
    rowHashes.sort();
    tableDigests.push({ table, rows: rowHashes.length, digest: sha256(rowHashes.join('\n')) });
  }
  const schemaDigest = valueHash(schemaObjects);
  return {
    schemaObjects: schemaObjects.length,
    schemaDigest,
    tables: tableDigests,
    digest: valueHash({ schemaDigest, tables: tableDigests }),
  };
}

function databaseEvidence(db) {
  const pathIdentity = databasePathIdentity(databasePathFromConnection(db));
  return {
    pathIdentity,
    logical: logicalDatabaseSnapshot(db),
  };
}

function databaseChecks(db) {
  const quickCheck = db.pragma('quick_check', { simple: true });
  const integrityRows = db.pragma('integrity_check');
  const integrityCheck = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok'
    ? 'ok'
    : integrityRows;
  const foreignKeyViolations = db.pragma('foreign_key_check').length;
  return { quickCheck, integrityCheck, foreignKeyViolations };
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

function uniqueSiblingPath(path, label) {
  return `${path}.${label}-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
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
    if (parent === ancestor) throw new Error(`cannot resolve artifact parent for ${absolute}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function assertArtifactNamespacesSafe(dbPath, artifacts) {
  const canonicalDatabase = realpathSync(resolve(dbPath));
  const seen = [{ label: 'database', path: canonicalDatabase }];
  for (const { label, path } of artifacts) {
    if (!path) continue;
    const canonical = canonicalProspectivePath(path);
    const prior = seen.find((entry) => entry.path === canonical
      || ['-journal', '-wal', '-shm'].some((suffix) =>
        canonical === `${entry.path}${suffix}` || entry.path === `${canonical}${suffix}`));
    if (prior?.label === 'database') {
      throw new Error(`${label} path collides with the source database or SQLite sidecar namespace`);
    }
    if (prior) throw new Error(`${label} path collides with the ${prior.label} SQLite namespace`);
    seen.push({ label, path: canonical });
  }
}

function createReportWriter(path) {
  if (!path) return null;
  const descriptor = openSync(path, 'wx+', 0o600);
  fchmodSync(descriptor, 0o600);
  const identity = fileIdentityFromStats(fstatSync(descriptor, { bigint: true }));
  let closed = false;
  const ownsPublishedPath = () => {
    try {
      return sameFileIdentity(
        fileIdentityFromStats(statSync(path, { bigint: true })),
        identity
      );
    } catch {
      return false;
    }
  };
  return {
    path,
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

async function verifyArtifact(path, expectedIdentity, expectedHash, expectedBytes) {
  try {
    const before = databasePathIdentity(path);
    if (!sameDatabaseObject(before, expectedIdentity)
        || before.bytes !== String(expectedBytes)) return false;
    const actualHash = await fileHash(path);
    const after = databasePathIdentity(path);
    return sameDatabaseObject(after, expectedIdentity)
      && after.bytes === String(expectedBytes)
      && actualHash === expectedHash;
  } catch {
    return false;
  }
}

function markCommittedBackupVerificationFailure(report, counts) {
  report.status = 'committed-backup-verification-failed';
  report.committed = true;
  report.committedCounts = counts || report.applied || report.committedCounts;
  delete report.applied;
  report.error = 'database committed but the verified adjudication backup is missing or changed';
}

function valueHash(value) {
  return sha256(stableStringify(value));
}

function rawContentHash(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return sha256(value);
  return sha256(String(value));
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? COLLATE NOCASE"
  ).get(name));
}

function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

function ancillaryTopology(db, tenantId, id) {
  if (!tenantId || !id) return [];
  return ANCILLARY_TABLES.map(({ table, idColumn }) => {
    const object = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name = ? COLLATE NOCASE ORDER BY name COLLATE BINARY"
    ).all(table);
    if (object.length > 1) throw new Error(`ambiguous ancillary table name: ${table}`);
    if (object.length === 0) return { table, idColumn, exists: false, rows: [] };
    if (object[0].type !== 'table') throw new Error(`ancillary object is not a table: ${table}`);
    const actualTable = assertIdentifier(object[0].name);
    const rows = db.prepare(
      `SELECT rowid AS __pmra_rowid, * FROM ${actualTable}
       WHERE tenant_id = ? AND ${idColumn} = ? ORDER BY rowid`
    ).all(tenantId, id).map((row) => {
      const rowId = row.__pmra_rowid;
      const persisted = { ...row };
      delete persisted.__pmra_rowid;
      return { rowId, rowHash: valueHash(persisted) };
    });
    return { table: actualTable, idColumn, exists: true, rows };
  });
}

function assertAncillaryTopologyCurrent(db, tenantId, id, expected, label) {
  const current = ancillaryTopology(db, tenantId, id);
  if (!sameValue(current, expected)) throw new Error(`ancillary rows changed before action: ${label}`);
  return current;
}

function assertIdentifier(name) {
  if (!SAFE_IDENTIFIER_RE.test(name) || name.toLowerCase().startsWith('sqlite_')) {
    throw new Error(`unsafe SQLite identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

function rowDescriptor(table, tenantId, id, row) {
  return {
    locator: { table, tenantId, id },
    exists: Boolean(row),
    rowHash: row ? valueHash(row) : null,
    contentHash: row && Object.hasOwn(row, 'content') ? rawContentHash(row.content) : null,
  };
}

function exactSharedRow(db, tenantId, id) {
  return db.prepare('SELECT * FROM shared_memory WHERE tenant_id = ? AND id = ?').get(tenantId, id);
}

function exactMessageRow(db, tenantId, id) {
  return db.prepare('SELECT * FROM ai_messages WHERE tenant_id = ? AND id = ?').get(tenantId, id);
}

function exactVectorIndexRow(db, table, tenantId, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND memory_id = ?`).get(tenantId, id);
}

function normalizeReference(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = value.trim().toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || null;
}

function referenceVariants(value) {
  const normalized = normalizeReference(value);
  if (!normalized) return [];
  const values = new Set([normalized]);
  for (const suffix of ['-llc', '-inc', '-corp', '-co', '-company']) {
    if (normalized.endsWith(suffix)) values.add(normalized.slice(0, -suffix.length));
    else values.add(`${normalized}${suffix}`);
  }
  if (/-v\d{1,3}$/.test(normalized)) values.add(normalized.replace(/-v\d{1,3}$/, ''));
  return [...values].filter(Boolean);
}

function isReservedReference(value) {
  return normalizeReference(value)?.startsWith('msg-detail-') === true;
}

function isMessageDetailPayload(payload) {
  return [payload?.type, payload?.entityType, payload?.memoryType, payload?.memory_type]
    .some((value) => String(value ?? '').trim().toLowerCase() === 'message_detail');
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function entityDirectory(db) {
  const rows = db.prepare(`
    SELECT * FROM shared_memory
    WHERE LOWER(memory_type) IN ('entity', 'message_detail')
    ORDER BY tenant_id, id
  `).all();
  const entries = [];
  for (const row of rows) {
    const payload = parseObject(row.content);
    if (!payload) continue;
    const references = [payload.name, ...(Array.isArray(payload.aliases) ? payload.aliases : [])]
      .filter((value) => typeof value === 'string' && value.length > 0);
    entries.push({
      row,
      payload,
      references,
      private: isMessageDetailPayload(payload) || references.some(isReservedReference)
        || String(row.memory_type).toLowerCase() === 'message_detail',
    });
  }
  return entries;
}

function parentTopology(db, row) {
  if (!row || !['observation', 'relation'].includes(String(row.memory_type).toLowerCase())) return null;
  const payload = parseObject(row.content);
  if (!payload) return { parseable: false, declarations: [], candidates: [] };
  const declarations = [];
  if (String(row.memory_type).toLowerCase() === 'observation') {
    if (typeof payload.metadata?.entityId === 'string') {
      declarations.push({ kind: 'entity_id', referenceHash: sha256(payload.metadata.entityId) });
    }
    if (typeof payload.entityName === 'string') {
      declarations.push({
        kind: 'entity_name',
        referenceHash: sha256(payload.entityName),
        reservedNamespace: isReservedReference(payload.entityName),
      });
    }
  } else {
    for (const kind of ['from', 'to']) {
      if (typeof payload[kind] === 'string') {
        declarations.push({
          kind,
          referenceHash: sha256(payload[kind]),
          reservedNamespace: isReservedReference(payload[kind]),
        });
      }
    }
  }

  const directory = entityDirectory(db);
  const candidateMap = new Map();
  for (const declaration of declarations) {
    const raw = declaration.kind === 'entity_id'
      ? payload.metadata.entityId
      : declaration.kind === 'entity_name'
        ? payload.entityName
        : payload[declaration.kind];
    for (const entry of directory) {
      const matches = declaration.kind === 'entity_id'
        ? entry.row.id === raw
        : entry.references.some((reference) => {
          const requested = new Set(referenceVariants(raw));
          return referenceVariants(reference).some((variant) => requested.has(variant));
        });
      if (!matches || entry.row.tenant_id !== row.tenant_id) continue;
      const descriptor = rowDescriptor('shared_memory', entry.row.tenant_id, entry.row.id, entry.row);
      candidateMap.set(`${entry.row.tenant_id}\u0000${entry.row.id}`, {
        ...descriptor,
        memoryType: entry.row.memory_type,
        private: entry.private,
      });
    }
  }
  return {
    parseable: true,
    declarations,
    candidates: [...candidateMap.values()].sort((a, b) =>
      `${a.locator.tenantId}\u0000${a.locator.id}`.localeCompare(`${b.locator.tenantId}\u0000${b.locator.id}`)),
  };
}

function detailTopology(db, row) {
  if (!row) return null;
  const payload = parseObject(row.content);
  const name = typeof payload?.name === 'string' ? payload.name : null;
  const body = Array.isArray(payload?.observations) && typeof payload.observations[0] === 'string'
    ? payload.observations[0]
    : null;
  const pointers = [];
  const bodyMatches = [];
  const encodedIdMatches = [];
  const encodedMessageId = name?.startsWith('msg-detail-') ? name.slice('msg-detail-'.length) : null;
  for (const message of db.prepare('SELECT * FROM ai_messages WHERE tenant_id = ? ORDER BY id').all(row.tenant_id)) {
    const pointer = typeof message.content === 'string' ? POINTER_RE.exec(message.content) : null;
    if (name && pointer?.[1] === name) {
      pointers.push({
        ...rowDescriptor('ai_messages', message.tenant_id, message.id, message),
        pointerHash: sha256(message.content),
      });
    }
    if (body != null && message.content === body) {
      bodyMatches.push(rowDescriptor('ai_messages', message.tenant_id, message.id, message));
    }
    if (encodedMessageId && message.id === encodedMessageId) {
      encodedIdMatches.push(rowDescriptor('ai_messages', message.tenant_id, message.id, message));
    }
  }
  return {
    parseable: Boolean(payload),
    canonicalNameHash: name == null ? null : sha256(name),
    bodyHash: body == null ? null : sha256(body),
    pointerMessages: pointers,
    bodyMatchMessages: bodyMatches,
    encodedIdMessages: encodedIdMatches,
  };
}

function sharedMessageTopology(db, row) {
  if (!row) return null;
  const parsed = parseLegacySharedMessage(row);
  if (!parsed) return { parseable: false, exactMailboxMatches: [] };
  const exactMailboxMatches = db.prepare(`
    SELECT * FROM ai_messages
    WHERE tenant_id = ? AND from_agent = ? AND to_agent = ? AND content = ?
    ORDER BY id
  `).all(row.tenant_id, parsed.fromAgent, parsed.toAgent, parsed.content)
    .map((message) => rowDescriptor('ai_messages', message.tenant_id, message.id, message));
  return {
    parseable: true,
    senderHash: sha256(parsed.fromAgent),
    recipientHash: sha256(parsed.toAgent),
    bodyHash: sha256(parsed.content),
    exactMailboxMatches,
  };
}

function vectorOwnership(db, vectorStorage, tenantId, id) {
  const indexTable = assertIdentifier(vectorStorage.indexTable);
  const vectorTable = assertIdentifier(vectorStorage.vectorTable);
  if (!tableExists(db, indexTable)) {
    return { indexTable, vectorTable, index: null, vec0: null, backingRows: [] };
  }
  const indexRow = exactVectorIndexRow(db, indexTable, tenantId, id);
  let vec0 = null;
  if (indexRow?.vector_rowid != null) {
    const owners = db.prepare(`SELECT * FROM ${indexTable} WHERE vector_rowid = ? ORDER BY tenant_id, memory_id`)
      .all(indexRow.vector_rowid).map((owner) => ({
        ...rowDescriptor(indexTable, owner.tenant_id, owner.memory_id, owner),
        memoryType: owner.memory_type,
      }));
    let vectorRow = null;
    if (tableExists(db, vectorTable)) {
      vectorRow = db.prepare(`SELECT rowid, * FROM ${vectorTable} WHERE rowid = ?`).get(indexRow.vector_rowid);
    }
    vec0 = {
      table: vectorTable,
      rowId: indexRow.vector_rowid,
      exists: Boolean(vectorRow),
      rowHash: vectorRow ? valueHash(vectorRow) : null,
      owners,
    };
  }

  const backingRows = [];
  if (tableExists(db, 'shared_memory')) {
    const shared = exactSharedRow(db, tenantId, id);
    if (shared) backingRows.push({
      ...rowDescriptor('shared_memory', tenantId, id, shared),
      memoryType: shared.memory_type,
    });
  }
  if (tableExists(db, 'ai_messages')) {
    const messages = db.prepare(`
      SELECT * FROM ai_messages
      WHERE tenant_id = ? AND (id = ? OR legacy_shared_memory_id = ?)
      ORDER BY id
    `).all(tenantId, id, id);
    for (const message of messages) {
      backingRows.push({
        ...rowDescriptor('ai_messages', tenantId, message.id, message),
        matchedBy: message.id === id ? 'id' : 'legacy_shared_memory_id',
      });
    }
  }
  return {
    indexTable,
    vectorTable,
    index: indexRow ? {
      ...rowDescriptor(indexTable, tenantId, id, indexRow),
      memoryType: indexRow.memory_type,
      vectorRowId: indexRow.vector_rowid,
    } : null,
    vec0,
    backingRows,
  };
}

function issueLocator(issue, vectorStorage) {
  const tenantId = issue.tenantId ?? null;
  if (VECTOR_ISSUE_CODES.has(issue.code) && issue.memoryId) {
    return { table: vectorStorage.indexTable, tenantId, id: issue.memoryId };
  }
  if (issue.observationId) return { table: 'shared_memory', tenantId, id: issue.observationId };
  if (issue.relationId) return { table: 'shared_memory', tenantId, id: issue.relationId };
  if (issue.entityId) return { table: 'shared_memory', tenantId, id: issue.entityId };
  if (issue.sharedMemoryId) return { table: 'shared_memory', tenantId, id: issue.sharedMemoryId };
  if (issue.messageId) return { table: 'ai_messages', tenantId, id: issue.messageId };
  return { table: 'unresolved', tenantId, id: null };
}

function rowForLocator(db, locator, vectorStorage) {
  if (!locator.id || !locator.tenantId) return null;
  if (locator.table === 'shared_memory') return exactSharedRow(db, locator.tenantId, locator.id);
  if (locator.table === 'ai_messages') return exactMessageRow(db, locator.tenantId, locator.id);
  if (locator.table === vectorStorage.indexTable) {
    return exactVectorIndexRow(db, vectorStorage.indexTable, locator.tenantId, locator.id);
  }
  return null;
}

function supportedDispositions(issue, descriptor, row, topology, vectors) {
  const supported = [];
  if (!descriptor.exists) return supported;
  if (VECTOR_ISSUE_CODES.has(issue.code)) supported.push('stale_vector_remove');
  if (descriptor.locator.table === 'shared_memory') {
    const pointerCount = topology?.pointerMessages?.length || 0;
    if (pointerCount === 0) supported.push('quarantine');
    if (issue.code === 'orphan_message_detail'
        || (DETAIL_ISSUE_CODES.has(issue.code) && pointerCount === 1)) {
      supported.push('restore_mailbox');
    }
    if (issue.code === 'unrepresented_shared_message') supported.push('private_duplicate');
    if (OBSERVATION_ISSUE_CODES.has(issue.code)) supported.push('public_relink');
  }
  // These are recognized manifest values but need external adapters. Listing
  // them makes the refusal explicit to an operator constructing a decision.
  supported.push('archive_then_remove_private');
  if (VECTOR_ISSUE_CODES.has(issue.code) || vectors?.index) supported.push('public_vector_rebuild');
  return [...new Set(supported)];
}

function sanitizeIssue(issue) {
  const safe = { code: issue.code };
  for (const key of [
    'reason', 'sourceMarked', 'longContent', 'memoryType', 'table', 'column',
    'vectorRowId', 'primaryTenantId',
  ]) {
    if (issue[key] != null) safe[key] = issue[key];
  }
  for (const key of ['candidateIds', 'parentEntityIds', 'primaryIds']) {
    if (Array.isArray(issue[key])) safe[`${key}Hash`] = valueHash(issue[key]);
  }
  for (const key of ['entityName', 'parentEntityName', 'reference', 'expectedName']) {
    if (typeof issue[key] === 'string') safe[`${key}Hash`] = sha256(issue[key]);
  }
  return safe;
}

function countBy(items, selector) {
  const result = {};
  for (const item of items) {
    const key = selector(item);
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function inventoryPrivateMessageResidue(db) {
  const source = analyzePrivateMessageResidue(db);
  const database = databaseEvidence(db);
  const findings = [];
  const occurrence = new Map();
  for (const sourceIssue of source.issues) {
    const issueHash = valueHash(sourceIssue);
    const ordinal = occurrence.get(issueHash) || 0;
    occurrence.set(issueHash, ordinal + 1);
    const locator = issueLocator(sourceIssue, source.vectorStorage);
    const row = rowForLocator(db, locator, source.vectorStorage);
    const descriptor = rowDescriptor(locator.table, locator.tenantId, locator.id, row);
    let topology = null;
    if (row && locator.table === 'shared_memory') {
      if (DETAIL_ISSUE_CODES.has(sourceIssue.code)) topology = detailTopology(db, row);
      else if (SHARED_MESSAGE_ISSUE_CODES.has(sourceIssue.code)) topology = sharedMessageTopology(db, row);
      else if (OBSERVATION_ISSUE_CODES.has(sourceIssue.code) || RELATION_ISSUE_CODES.has(sourceIssue.code)) {
        topology = parentTopology(db, row);
      }
    }
    const vectors = locator.table === source.vectorStorage.indexTable
      ? vectorOwnership(db, source.vectorStorage, locator.tenantId, locator.id)
      : locator.table === 'shared_memory'
        ? vectorOwnership(db, source.vectorStorage, locator.tenantId, locator.id)
        : null;
    const ancillaryRows = locator.table === 'shared_memory'
      ? ancillaryTopology(db, locator.tenantId, locator.id)
      : [];
    const evidence = {
      issueHash,
      issueOccurrence: ordinal,
      locator: descriptor.locator,
      rowHash: descriptor.rowHash,
      contentHash: descriptor.contentHash,
      parentTopology: topology,
      vectorOwnership: vectors,
      ancillaryRows,
    };
    const findingId = `PMRA-${sha256(stableStringify({ issueHash, ordinal, locator })).slice(0, 24)}`;
    const supported = supportedDispositions(sourceIssue, descriptor, row, topology, vectors);
    const finding = {
      findingId,
      issue: sanitizeIssue(sourceIssue),
      locator: descriptor.locator,
      exists: descriptor.exists,
      rowHash: descriptor.rowHash,
      contentHash: descriptor.contentHash,
      parentTopology: topology,
      vectorOwnership: vectors,
      ancillaryRows,
      evidenceHash: valueHash(evidence),
      supportedDispositions: supported,
    };
    findings.push(finding);
  }

  const contentFingerprint = valueHash({
    schemaVersion: SCHEMA_VERSION,
    sourceMigration: '007-private-message-residue',
    sourceFingerprint: source.fingerprint,
    vectorStorage: source.vectorStorage,
    logicalDatabase: database.logical,
    findings,
  });
  const inventoryFingerprint = valueHash({ contentFingerprint, pathIdentity: database.pathIdentity });
  const manifestTemplate = {
    schemaVersion: SCHEMA_VERSION,
    inventoryFingerprint,
    approval: {
      reviewer: null,
      rationale: null,
      approvedAt: null,
      reference: null,
      signatureHash: null,
    },
    decisions: findings.map((finding) => ({
      findingId: finding.findingId,
      locator: finding.locator,
      rowHash: finding.rowHash,
      contentHash: finding.contentHash,
      evidenceHash: finding.evidenceHash,
      disposition: null,
    })),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceMigration: '007-private-message-residue',
    sourceFingerprint: source.fingerprint,
    contentFingerprint,
    inventoryFingerprint,
    database,
    readyForMigration007: source.ready,
    vectorStorage: source.vectorStorage,
    counts: {
      findings: findings.length,
      byIssueCode: countBy(findings, (finding) => finding.issue.code),
      unmappedRows: findings.filter((finding) => !finding.exists).length,
    },
    findings,
    manifestTemplate,
  };
}

function publicInventory(inventory) {
  return inventory;
}

function strictKeys(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ code: 'invalid_object', field: label });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push({ code: 'unknown_field', field: `${label}.${key}` });
  }
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function validateApproval(value, errors) {
  strictKeys(
    value,
    new Set(['reviewer', 'rationale', 'approvedAt', 'reference', 'signatureHash']),
    'manifest.approval',
    errors
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const key of ['reviewer', 'rationale', 'approvedAt', 'reference', 'signatureHash']) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      errors.push({ code: 'missing_approval_field', field: `manifest.approval.${key}` });
    } else {
      normalized[key] = value[key].trim();
    }
  }
  if (normalized.approvedAt) {
    const timestamp = Date.parse(normalized.approvedAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized.approvedAt) {
      errors.push({ code: 'invalid_approval_timestamp', field: 'manifest.approval.approvedAt' });
    }
  }
  if (normalized.signatureHash && !SHA256_RE.test(normalized.signatureHash)) {
    errors.push({ code: 'invalid_approval_signature_hash', field: 'manifest.approval.signatureHash' });
  }
  return normalized;
}

function validateTarget(db, target, expectedTable, errors, findingId) {
  strictKeys(target, new Set(['table', 'tenantId', 'id', 'rowHash', 'contentHash']), 'decision.target', errors);
  if (!target || target.table !== expectedTable || typeof target.tenantId !== 'string'
      || typeof target.id !== 'string' || typeof target.rowHash !== 'string') {
    errors.push({ code: 'invalid_target_evidence', findingId });
    return null;
  }
  const row = expectedTable === 'ai_messages'
    ? exactMessageRow(db, target.tenantId, target.id)
    : exactSharedRow(db, target.tenantId, target.id);
  const current = rowDescriptor(expectedTable, target.tenantId, target.id, row);
  if (!row || current.rowHash !== target.rowHash || current.contentHash !== target.contentHash) {
    errors.push({ code: 'stale_or_missing_target', findingId });
    return null;
  }
  return row;
}

function parseLegacySharedMessage(row) {
  const payload = parseObject(row.content);
  if (!payload) return null;
  const fromAgent = typeof payload.from === 'string' && payload.from
    ? payload.from
    : typeof payload.sender === 'string' && payload.sender
      ? payload.sender
      : row.created_by || 'unknown';
  const toAgent = payload.to || payload.target || 'unknown';
  const content = payload.content || payload.message || '';
  if (typeof toAgent !== 'string' || typeof content !== 'string') return null;
  return { fromAgent, toAgent, content };
}

function validateRestoreMailbox(sourceRow, targetRow, decision, errors) {
  const payload = parseObject(sourceRow.content);
  const body = Array.isArray(payload?.observations) && payload.observations.length === 1
    && typeof payload.observations[0] === 'string'
    ? payload.observations[0]
    : null;
  if (!payload || !isMessageDetailPayload(payload) || !body || typeof payload.name !== 'string') {
    errors.push({ code: 'restore_source_not_exact_message_detail', findingId: decision.findingId });
    return null;
  }
  if (sourceRow.tenant_id !== targetRow.tenant_id
      || payload.name !== `msg-detail-${targetRow.id}`
      || sourceRow.created_by !== targetRow.from_agent
      || (payload.createdBy != null && payload.createdBy !== targetRow.from_agent)) {
    errors.push({ code: 'restore_mailbox_provenance_mismatch', findingId: decision.findingId });
    return null;
  }
  const pointer = typeof targetRow.content === 'string' ? POINTER_RE.exec(targetRow.content) : null;
  const targetHasExactPointer = pointer?.[1] === payload.name;
  const targetAlreadyHasExactBody = targetRow.content === body;
  if (!targetHasExactPointer && !targetAlreadyHasExactBody) {
    errors.push({
      code: 'restore_mailbox_content_mismatch',
      findingId: decision.findingId,
    });
    return null;
  }
  return { body, bodyHash: sha256(body) };
}

function validatePrivateDuplicate(sourceRow, targetRow, decision, errors) {
  const parsed = parseLegacySharedMessage(sourceRow);
  if (!parsed || String(sourceRow.memory_type).toLowerCase() !== 'ai_message'
      || sourceRow.tenant_id !== targetRow.tenant_id
      || parsed.fromAgent !== targetRow.from_agent
      || parsed.toAgent !== targetRow.to_agent
      || parsed.content !== targetRow.content) {
    errors.push({ code: 'private_duplicate_parity_mismatch', findingId: decision.findingId });
    return false;
  }
  return true;
}

function decisionDeleteKey(locator) {
  return `${locator.table}\u0000${locator.tenantId}\u0000${locator.id}`;
}

export function planPrivateMessageResidueAdjudication(db, inventory, manifestInput) {
  const manifest = immutableJsonClone(manifestInput, 'manifest');
  const errors = [];
  strictKeys(manifest, new Set(['schemaVersion', 'inventoryFingerprint', 'approval', 'decisions']), 'manifest', errors);
  if (manifest?.schemaVersion !== SCHEMA_VERSION) errors.push({ code: 'manifest_schema_version_mismatch' });
  if (manifest?.inventoryFingerprint !== inventory.inventoryFingerprint) {
    errors.push({ code: 'inventory_fingerprint_mismatch' });
  }
  const approval = validateApproval(manifest?.approval, errors);
  if (!Array.isArray(manifest?.decisions)) errors.push({ code: 'decisions_must_be_array' });
  const decisions = Array.isArray(manifest?.decisions) ? manifest.decisions : [];
  const byFinding = new Map(inventory.findings.map((finding) => [finding.findingId, finding]));
  const decisionByFinding = new Map();
  for (const decision of decisions) {
    strictKeys(
      decision,
      new Set(['findingId', 'locator', 'rowHash', 'contentHash', 'evidenceHash', 'disposition', 'target']),
      'decision',
      errors
    );
    if (typeof decision?.findingId !== 'string') {
      errors.push({ code: 'missing_finding_id' });
      continue;
    }
    if (decisionByFinding.has(decision.findingId)) {
      errors.push({ code: 'duplicate_decision', findingId: decision.findingId });
      continue;
    }
    decisionByFinding.set(decision.findingId, decision);
    const finding = byFinding.get(decision.findingId);
    if (!finding) {
      errors.push({ code: 'extra_decision', findingId: decision.findingId });
      continue;
    }
    if (!sameValue(decision.locator, finding.locator)
        || decision.rowHash !== finding.rowHash
        || decision.contentHash !== finding.contentHash
        || decision.evidenceHash !== finding.evidenceHash) {
      errors.push({ code: 'stale_or_incomplete_evidence', findingId: decision.findingId });
    }
    if (!ALLOWED_DISPOSITIONS.has(decision.disposition)) {
      errors.push({ code: 'invalid_disposition', findingId: decision.findingId });
    } else if (MANUAL_ADAPTER_DISPOSITIONS.has(decision.disposition)) {
      errors.push({
        code: 'manual_adapter_required',
        findingId: decision.findingId,
        disposition: decision.disposition,
      });
    } else if (!finding.supportedDispositions.includes(decision.disposition)) {
      errors.push({ code: 'disposition_not_supported_for_finding', findingId: decision.findingId });
    }
  }
  for (const finding of inventory.findings) {
    if (!decisionByFinding.has(finding.findingId)) {
      errors.push({ code: 'missing_decision', findingId: finding.findingId });
    }
  }

  const sourceActions = new Map();
  const vectorDeletes = new Map();
  const normalized = [];
  if (errors.length === 0) {
    for (const finding of inventory.findings) {
      const decision = decisionByFinding.get(finding.findingId);
      const normalizedDecision = {
        findingId: decision.findingId,
        locator: decision.locator,
        rowHash: decision.rowHash,
        contentHash: decision.contentHash,
        evidenceHash: decision.evidenceHash,
        disposition: decision.disposition,
        ...(decision.target ? {
          target: {
            table: decision.target.table,
            tenantId: decision.target.tenantId,
            id: decision.target.id,
            rowHash: decision.target.rowHash,
            contentHash: decision.target.contentHash,
          },
        } : {}),
      };
      normalized.push(normalizedDecision);
      const row = rowForLocator(db, finding.locator, inventory.vectorStorage);
      if (!row || valueHash(row) !== finding.rowHash) {
        errors.push({ code: 'source_changed_during_plan', findingId: finding.findingId });
        continue;
      }
      if (decision.disposition === 'stale_vector_remove') {
        vectorDeletes.set(decisionDeleteKey(finding.locator), finding.vectorOwnership);
        continue;
      }

      const key = decisionDeleteKey(finding.locator);
      const prior = sourceActions.get(key);
      if (prior && prior.disposition !== decision.disposition) {
        errors.push({ code: 'conflicting_source_dispositions', findingId: finding.findingId });
        continue;
      }
      if (prior && !sameValue(prior.decision.target ?? null, decision.target ?? null)) {
        errors.push({ code: 'conflicting_source_targets', findingId: finding.findingId });
        continue;
      }
      const action = prior || {
        findingIds: [],
        finding,
        decision: normalizedDecision,
        row,
        disposition: decision.disposition,
      };
      action.findingIds.push(finding.findingId);
      sourceActions.set(key, action);

      if (decision.disposition === 'restore_mailbox') {
        const target = validateTarget(db, normalizedDecision.target, 'ai_messages', errors, finding.findingId);
        if (target) action.restore = validateRestoreMailbox(row, target, normalizedDecision, errors);
        action.targetRow = target;
      } else if (decision.disposition === 'private_duplicate') {
        const target = validateTarget(db, normalizedDecision.target, 'ai_messages', errors, finding.findingId);
        if (target) validatePrivateDuplicate(row, target, normalizedDecision, errors);
        action.targetRow = target;
      }
    }
  }

  const scheduledSourceDeletes = new Set([...sourceActions.entries()]
    .filter(([, action]) => ['quarantine', 'restore_mailbox', 'private_duplicate'].includes(action.disposition))
    .map(([key]) => key));
  const scheduledVectorDeletes = new Set(vectorDeletes.keys());
  for (const action of sourceActions.values()) {
    if (action.finding.vectorOwnership?.index) {
      scheduledVectorDeletes.add(decisionDeleteKey(action.finding.vectorOwnership.index.locator));
      vectorDeletes.set(
        decisionDeleteKey(action.finding.vectorOwnership.index.locator),
        action.finding.vectorOwnership
      );
    }
  }

  for (const [key, ownership] of vectorDeletes) {
    if (!ownership?.index) {
      errors.push({ code: 'vector_index_missing', locatorHash: sha256(key) });
      continue;
    }
    for (const backing of ownership.backingRows || []) {
      const backingKey = decisionDeleteKey(backing.locator);
      if (backing.locator.table === 'ai_messages' || !scheduledSourceDeletes.has(backingKey)) {
        errors.push({
          code: 'vector_not_stale_or_source_not_scheduled_for_removal',
          findingId: decisionByFinding.get(ownership.index.locator.id)?.findingId,
          locator: ownership.index.locator,
        });
      }
    }
    for (const owner of ownership.vec0?.owners || []) {
      if (!scheduledVectorDeletes.has(decisionDeleteKey(owner.locator))) {
        errors.push({ code: 'vec0_row_has_unscheduled_owner', locator: ownership.index.locator });
      }
    }
  }

  const normalizedManifest = {
    schemaVersion: SCHEMA_VERSION,
    inventoryFingerprint: inventory.inventoryFingerprint,
    approval,
    decisions: normalized,
  };
  const planFingerprint = valueHash({
    inventoryFingerprint: inventory.inventoryFingerprint,
    manifest: normalizedManifest,
  });
  const confirmationToken = errors.length === 0
    ? `ADJUDICATE-PRIVATE-RESIDUE-${planFingerprint.slice(0, 20).toUpperCase()}`
    : null;
  const actions = [...sourceActions.values()].map((action) => ({
    disposition: action.disposition,
    source: action.finding.locator,
    target: action.decision.target
      ? { table: action.decision.target.table, tenantId: action.decision.target.tenantId, id: action.decision.target.id }
      : null,
    findingIds: action.findingIds,
  }));
  for (const ownership of vectorDeletes.values()) {
    actions.push({
      disposition: 'stale_vector_remove',
      source: ownership.index?.locator || null,
      target: null,
      findingIds: normalized.filter((decision) =>
        decision.disposition === 'stale_vector_remove'
        && sameValue(decision.locator, ownership.index?.locator)).map((decision) => decision.findingId),
    });
  }
  return {
    ready: errors.length === 0,
    inventoryFingerprint: inventory.inventoryFingerprint,
    manifestHash: valueHash(normalizedManifest),
    planFingerprint,
    confirmationToken,
    approvalHash: approval ? valueHash(approval) : null,
    counts: {
      decisions: normalized.length,
      actions: actions.length,
      byDisposition: countBy(normalized, (decision) => decision.disposition),
      errors: errors.length,
    },
    errors,
    actions,
    internal: { normalizedManifest, approval, sourceActions, vectorDeletes },
  };
}

function publicPlan(plan) {
  const { internal, ...value } = plan;
  return value;
}

function ensureNewPath(path, label, touch = true) {
  if (!path) throw new Error(`${label} path is required`);
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} path already exists: ${absolute}`);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  if (touch) {
    const fd = openSync(absolute, 'wx', 0o600);
    closeSync(fd);
  }
  return absolute;
}

function writeReport(writer, report) {
  writer?.write(report);
}

function loadManifest(path) {
  if (!path) throw new Error('--manifest is required for plan and execute modes');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new Error('manifest could not be read as valid JSON');
  }
  return parsed;
}

function deleteRelatedRows(db, tenantId, id, expected, counts, label) {
  const current = assertAncillaryTopologyCurrent(db, tenantId, id, expected, label);
  const countKeys = {
    graph_lookup_keys: 'graphLookupRowsDeleted',
    entity_lookup_identity_links: 'identityLinkRowsDeleted',
    entity_context_facets: 'contextFacetRowsDeleted',
  };
  for (const entry of current) {
    if (!entry.exists) continue;
    const table = assertIdentifier(entry.table);
    const idColumn = assertIdentifier(entry.idColumn);
    const changes = db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND ${idColumn} = ?`)
      .run(tenantId, id).changes;
    if (changes !== entry.rows.length) {
      throw new Error(`ancillary row deletion count changed: ${label}:${table}`);
    }
    const countKey = countKeys[table.toLowerCase()];
    if (!countKey) throw new Error(`unexpected ancillary table: ${table}`);
    counts[countKey] += changes;
  }
}

function createOperatorTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE} (
      quarantine_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      finding_ids_json TEXT NOT NULL,
      original_table TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      row_hash TEXT NOT NULL,
      content_hash TEXT,
      row_json TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      disposition TEXT NOT NULL,
      UNIQUE(original_table, tenant_id, row_id, row_hash)
    );
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      run_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      inventory_fingerprint TEXT NOT NULL,
      plan_fingerprint TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      approval_hash TEXT NOT NULL,
      approval_json TEXT NOT NULL,
      database_evidence_json TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      backup_sha256 TEXT NOT NULL,
      backup_bytes INTEGER NOT NULL,
      backup_identity_json TEXT NOT NULL,
      report_path TEXT NOT NULL,
      counts_json TEXT NOT NULL
    );
  `);
  const auditColumns = tableColumns(db, AUDIT_TABLE);
  for (const [column, declaration] of [
    ['approval_hash', 'TEXT'],
    ['approval_json', 'TEXT'],
    ['database_evidence_json', 'TEXT'],
    ['backup_sha256', 'TEXT'],
    ['backup_bytes', 'INTEGER'],
    ['backup_identity_json', 'TEXT'],
  ]) {
    if (!auditColumns.has(column)) db.exec(`ALTER TABLE ${AUDIT_TABLE} ADD COLUMN ${column} ${declaration}`);
  }
}

function applyPlan(db, plan, runId, options = {}) {
  const counts = {
    quarantinedRows: 0,
    restoredMailboxes: 0,
    privateDuplicatesRemoved: 0,
    sharedRowsDeleted: 0,
    vectorIndexRowsDeleted: 0,
    vec0RowsDeleted: 0,
    graphLookupRowsDeleted: 0,
    identityLinkRowsDeleted: 0,
    contextFacetRowsDeleted: 0,
  };
  let step = 0;
  const failPoint = () => {
    step += 1;
    if (options.failAfterStep === step) throw new Error(`injected failure after adjudication step ${step}`);
  };
  createOperatorTables(db);
  failPoint();

  const sourceDeletes = [];
  for (const action of plan.internal.sourceActions.values()) {
    const { finding, decision } = action;
    const current = exactSharedRow(db, finding.locator.tenantId, finding.locator.id);
    if (!current || valueHash(current) !== finding.rowHash) {
      throw new Error(`source row changed before action: ${finding.findingId}`);
    }
    if (action.disposition === 'quarantine') {
      const quarantineId = sha256(`${runId}\n${stableStringify(finding.locator)}\n${finding.rowHash}`).slice(0, 32);
      db.prepare(`
        INSERT INTO ${QUARANTINE_TABLE}
          (quarantine_id, run_id, finding_ids_json, original_table, tenant_id, row_id,
           row_hash, content_hash, row_json, quarantined_at, disposition)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantine')
      `).run(
        quarantineId,
        runId,
        JSON.stringify(action.findingIds),
        finding.locator.table,
        finding.locator.tenantId,
        finding.locator.id,
        finding.rowHash,
        finding.contentHash,
        stableStringify(current),
        new Date().toISOString()
      );
      counts.quarantinedRows += 1;
    } else if (action.disposition === 'restore_mailbox') {
      const targetCurrent = exactMessageRow(db, decision.target.tenantId, decision.target.id);
      if (!targetCurrent || valueHash(targetCurrent) !== decision.target.rowHash
          || rawContentHash(targetCurrent.content) !== decision.target.contentHash || !action.restore) {
        throw new Error(`mailbox target changed before action: ${finding.findingId}`);
      }
      const parityErrors = [];
      const restore = validateRestoreMailbox(current, targetCurrent, decision, parityErrors);
      if (!restore || parityErrors.length > 0 || restore.bodyHash !== action.restore.bodyHash) {
        throw new Error(`mailbox restore parity changed before action: ${finding.findingId}`);
      }
      const updated = db.prepare('UPDATE ai_messages SET content = ? WHERE tenant_id = ? AND id = ?')
        .run(restore.body, decision.target.tenantId, decision.target.id);
      if (updated.changes !== 1) throw new Error(`mailbox restore failed: ${finding.findingId}`);
      counts.restoredMailboxes += 1;
    } else if (action.disposition === 'private_duplicate') {
      const targetCurrent = exactMessageRow(db, decision.target.tenantId, decision.target.id);
      const parityErrors = [];
      if (!targetCurrent || valueHash(targetCurrent) !== decision.target.rowHash
          || rawContentHash(targetCurrent.content) !== decision.target.contentHash
          || !validatePrivateDuplicate(current, targetCurrent, decision, parityErrors)
          || parityErrors.length > 0) {
        throw new Error(`mailbox duplicate target changed before action: ${finding.findingId}`);
      }
      counts.privateDuplicatesRemoved += 1;
    } else {
      throw new Error(`unsupported source action reached execution: ${action.disposition}`);
    }
    sourceDeletes.push(finding.locator);
  }
  failPoint();

  const vectorTable = assertIdentifier(plan.internal.normalizedManifest
    ? plan.internal.sourceActions.values().next().value?.finding.vectorOwnership?.vectorTable
      || plan.internal.vectorDeletes.values().next().value?.vectorTable
      || 'shared_memory_vec'
    : 'shared_memory_vec');
  const vectorIndexLocators = new Map();
  const vecRows = new Map();
  for (const ownership of plan.internal.vectorDeletes.values()) {
    if (!ownership?.index) continue;
    vectorIndexLocators.set(decisionDeleteKey(ownership.index.locator), ownership.index.locator);
    if (ownership.vec0?.rowId != null && ownership.vec0.exists) {
      vecRows.set(ownership.vec0.rowId, ownership.vec0);
    }
  }
  for (const action of plan.internal.sourceActions.values()) {
    const ownership = action.finding.vectorOwnership;
    if (!ownership?.index) continue;
    vectorIndexLocators.set(decisionDeleteKey(ownership.index.locator), ownership.index.locator);
    if (ownership.vec0?.rowId != null && ownership.vec0.exists) {
      vecRows.set(ownership.vec0.rowId, ownership.vec0);
    }
  }
  const indexTable = vectorIndexLocators.values().next().value?.table
    || plan.internal.vectorDeletes.values().next().value?.indexTable
    || 'neural_vec_index';
  assertIdentifier(indexTable);
  for (const locator of vectorIndexLocators.values()) {
    const current = exactVectorIndexRow(db, indexTable, locator.tenantId, locator.id);
    const evidence = plan.internal.vectorDeletes.get(decisionDeleteKey(locator))?.index
      || [...plan.internal.sourceActions.values()]
        .map((action) => action.finding.vectorOwnership?.index)
        .find((index) => index && sameValue(index.locator, locator));
    if (!current || !evidence || valueHash(current) !== evidence.rowHash) {
      throw new Error(`vector index changed before action: ${locator.id}`);
    }
    const result = db.prepare(`DELETE FROM ${indexTable} WHERE tenant_id = ? AND memory_id = ?`)
      .run(locator.tenantId, locator.id);
    if (result.changes !== 1) throw new Error(`vector index deletion failed: ${locator.id}`);
    counts.vectorIndexRowsDeleted += 1;
  }
  if (tableExists(db, vectorTable)) {
    for (const [rowId, evidence] of vecRows) {
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM ${indexTable} WHERE vector_rowid = ?`).get(rowId).count;
      if (remaining !== 0) throw new Error(`vec0 row still has owners: ${rowId}`);
      const current = db.prepare(`SELECT rowid, * FROM ${vectorTable} WHERE rowid = ?`).get(rowId);
      if (!current || valueHash(current) !== evidence.rowHash) {
        throw new Error(`vec0 row changed before deletion: ${rowId}`);
      }
      const result = db.prepare(`DELETE FROM ${vectorTable} WHERE rowid = ?`).run(rowId);
      if (result.changes !== 1) throw new Error(`vec0 deletion failed: ${rowId}`);
      counts.vec0RowsDeleted += 1;
    }
  }
  failPoint();

  for (const locator of sourceDeletes) {
    const action = plan.internal.sourceActions.get(decisionDeleteKey(locator));
    deleteRelatedRows(
      db,
      locator.tenantId,
      locator.id,
      action.finding.ancillaryRows,
      counts,
      action.finding.findingId
    );
    const result = db.prepare('DELETE FROM shared_memory WHERE tenant_id = ? AND id = ?')
      .run(locator.tenantId, locator.id);
    if (result.changes !== 1) throw new Error(`shared row deletion failed: ${locator.id}`);
    counts.sharedRowsDeleted += 1;
  }
  failPoint();
  return counts;
}

export async function runPrivateMessageResidueAdjudication(options) {
  const mode = options.mode || 'inventory';
  if (!['inventory', 'plan', 'execute'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
  const dbPath = resolve(options.dbPath);
  const execute = mode === 'execute';
  let reportPath;
  let backupPath;
  const requestedReportPath = options.reportPath ? resolve(options.reportPath) : null;
  let requestedBackupPath = null;
  if (execute) {
    if (!options.confirm) throw new Error('--confirm is required in execute mode');
    if (!requestedReportPath) throw new Error('--report is required in execute mode');
    if (!options.backupPath) throw new Error('backup path is required');
    requestedBackupPath = resolve(options.backupPath);
  }
  assertArtifactNamespacesSafe(dbPath, [
    { label: 'report', path: requestedReportPath },
    { label: 'backup', path: requestedBackupPath },
  ]);
  if (requestedReportPath) reportPath = ensureNewPath(requestedReportPath, 'report', false);
  if (requestedBackupPath) backupPath = ensureNewPath(requestedBackupPath, 'backup', false);

  const startedAt = new Date().toISOString();
  const db = new Database(dbPath, { readonly: !execute, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  let report;
  let reportWriter = null;
  try {
    reportWriter = createReportWriter(reportPath);
    const inventory = inventoryPrivateMessageResidue(db);
    if (mode === 'inventory') {
      report = {
        tool: 'private-message-residue-adjudication',
        mode,
        database: dbPath,
        startedAt,
        status: 'inventoried',
        ...publicInventory(inventory),
        completedAt: new Date().toISOString(),
      };
      writeReport(reportWriter, report);
      return report;
    }

    const manifest = immutableJsonClone(
      options.manifest || loadManifest(options.manifestPath),
      'manifest'
    );
    const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
    report = {
      tool: 'private-message-residue-adjudication',
      mode,
      database: dbPath,
      startedAt,
      status: plan.ready ? (execute ? 'pending' : 'ready') : 'refused',
      inventory: {
        sourceFingerprint: inventory.sourceFingerprint,
        contentFingerprint: inventory.contentFingerprint,
        inventoryFingerprint: inventory.inventoryFingerprint,
        database: {
          pathIdentity: inventory.database.pathIdentity,
          logicalDigest: inventory.database.logical.digest,
        },
        counts: inventory.counts,
      },
      plan: publicPlan(plan),
    };
    if (mode === 'plan' || !plan.ready) {
      report.completedAt = new Date().toISOString();
      writeReport(reportWriter, report);
      return report;
    }
    if (options.confirm !== plan.confirmationToken) {
      report.status = 'refused';
      report.plan = {
        ...report.plan,
        ready: false,
        planFingerprint: null,
        confirmationToken: null,
        errors: [...report.plan.errors, { code: 'confirmation_token_mismatch' }],
      };
      report.completedAt = new Date().toISOString();
      writeReport(reportWriter, report);
      return report;
    }

    writeReport(reportWriter, report);
    if (typeof options.afterPendingReport === 'function') options.afterPendingReport();
    reportWriter?.assertOwned();
    let backupTemporaryPath = null;
    let backupTemporaryDescriptor = null;
    let backupTemporaryIdentity = null;
    let backupPromoted = false;
    let transactionStarted = false;
    try {
      const sourceIdentityBeforeBackup = databasePathIdentity(dbPath);
      const dataVersionBeforeBackup = db.pragma('data_version', { simple: true });
      if (!sameValue(sourceIdentityBeforeBackup, inventory.database.pathIdentity)) {
        throw new Error('database path identity changed before backup');
      }

      backupTemporaryPath = uniqueSiblingPath(backupPath, 'unverified');
      backupTemporaryDescriptor = openSync(backupTemporaryPath, 'wx+', 0o600);
      fchmodSync(backupTemporaryDescriptor, 0o600);
      backupTemporaryIdentity = fileIdentityFromStats(
        fstatSync(backupTemporaryDescriptor, { bigint: true })
      );
      await db.backup(backupTemporaryPath);
      if (!sameFileIdentity(pathFileIdentity(backupTemporaryPath), backupTemporaryIdentity)) {
        throw new Error('backup staging path ownership changed during backup');
      }
      fchmodSync(backupTemporaryDescriptor, 0o600);

      const sourceIdentityAfterBackup = databasePathIdentity(dbPath);
      const dataVersionAfterBackup = db.pragma('data_version', { simple: true });
      if (!sameValue(sourceIdentityAfterBackup, sourceIdentityBeforeBackup)
          || dataVersionAfterBackup !== dataVersionBeforeBackup) {
        throw new Error('database changed while the adjudication backup was being created');
      }

      const backupDb = new Database(backupTemporaryPath, { readonly: true, fileMustExist: true });
      let backupChecks;
      let backupInventory;
      try {
        backupDb.pragma('foreign_keys = ON');
        backupChecks = databaseChecks(backupDb);
        backupInventory = inventoryPrivateMessageResidue(backupDb);
      } finally {
        backupDb.close();
      }
      if (backupChecks.quickCheck !== 'ok' || backupChecks.integrityCheck !== 'ok'
          || backupChecks.foreignKeyViolations !== 0
          || backupInventory.contentFingerprint !== inventory.contentFingerprint
          || backupInventory.database.logical.digest !== inventory.database.logical.digest) {
        throw new Error('backup verification failed or backup logical content differs from preflight');
      }
      const backupSha256 = await fileHash(backupTemporaryPath);
      const backupBytes = statSync(backupTemporaryPath).size;
      fsyncSync(backupTemporaryDescriptor);
      fsyncFileAndParent(backupTemporaryPath);
      if (options.failAfterBackupVerification) {
        throw new Error('injected failure after adjudication backup verification');
      }

      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const lockedInventory = inventoryPrivateMessageResidue(db);
      const lockedPlan = planPrivateMessageResidueAdjudication(db, lockedInventory, manifest);
      const lockedPathIdentity = databasePathIdentity(dbPath);
      const lockedDataVersion = db.pragma('data_version', { simple: true });
      if (!lockedPlan.ready || lockedPlan.planFingerprint !== plan.planFingerprint
          || !sameValue(lockedPathIdentity, inventory.database.pathIdentity)
          || lockedDataVersion !== dataVersionAfterBackup
          || lockedInventory.contentFingerprint !== backupInventory.contentFingerprint) {
        throw new Error('database or manifest changed after preflight; confirmation is stale');
      }
      if (typeof options.beforeBackupPromotion === 'function') options.beforeBackupPromotion();
      const stagedHashBeforePromotion = await fileHash(backupTemporaryPath);
      if (!sameFileIdentity(pathFileIdentity(backupTemporaryPath), backupTemporaryIdentity)
          || stagedHashBeforePromotion !== backupSha256) {
        throw new Error('verified backup staging path changed before promotion');
      }
      publishNoClobber(backupTemporaryPath, backupPath);
      backupTemporaryPath = null;
      backupPromoted = true;
      const backupIdentity = databasePathIdentity(backupPath);
      if (!sameFileIdentity(
        { device: backupIdentity.device, inode: backupIdentity.inode },
        backupTemporaryIdentity
      ) || !await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        throw new Error('verified backup changed during atomic promotion');
      }
      report.backup = {
        path: backupPath,
        bytes: backupBytes,
        sha256: backupSha256,
        pathIdentity: backupIdentity,
        checks: backupChecks,
        contentFingerprint: backupInventory.contentFingerprint,
        logicalDigest: backupInventory.database.logical.digest,
      };

      const runId = sha256(`${plan.planFingerprint}\n${startedAt}\n${reportPath}`).slice(0, 32);
      const counts = applyPlan(db, lockedPlan, runId, { failAfterStep: options.failAfterStep });
      const postAnalysis = analyzePrivateMessageResidue(db);
      if (!postAnalysis.ready) {
        throw new Error(`adjudication did not resolve every migration refusal (${postAnalysis.issues.length} remain)`);
      }
      const postChecks = databaseChecks(db);
      if (postChecks.quickCheck !== 'ok' || postChecks.integrityCheck !== 'ok'
          || postChecks.foreignKeyViolations !== 0) {
        throw new Error('post-adjudication database integrity verification failed');
      }
      const currentPathIdentity = databasePathIdentity(dbPath);
      if (!sameDatabaseObject(currentPathIdentity, lockedPathIdentity)) {
        throw new Error('database path no longer names the locked database object');
      }
      db.prepare(`
        INSERT INTO ${AUDIT_TABLE}
          (run_id, applied_at, inventory_fingerprint, plan_fingerprint, manifest_hash,
           approval_hash, approval_json, database_evidence_json,
           backup_path, backup_sha256, backup_bytes, backup_identity_json,
           report_path, counts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        new Date().toISOString(),
        inventory.inventoryFingerprint,
        plan.planFingerprint,
        plan.manifestHash,
        lockedPlan.approvalHash,
        JSON.stringify(lockedPlan.internal.approval),
        JSON.stringify(inventory.database),
        backupPath,
        backupSha256,
        backupBytes,
        JSON.stringify(backupIdentity),
        reportPath,
        JSON.stringify(counts)
      );
      reportWriter?.assertOwned();
      if (typeof options.beforeCommit === 'function') options.beforeCommit();
      if (!await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        throw new Error('verified adjudication backup is missing or changed before commit');
      }
      reportWriter?.assertOwned();
      db.exec('COMMIT');
      transactionStarted = false;
      report.runId = runId;
      report.checks = postChecks;
      report.postMigration007 = {
        ready: postAnalysis.ready,
        fingerprint: postAnalysis.fingerprint,
        counts: postAnalysis.counts,
      };
      if (typeof options.afterCommit === 'function') options.afterCommit();
      if (!await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        markCommittedBackupVerificationFailure(report, counts);
      } else {
        report.status = 'applied';
        report.applied = counts;
      }
      try { closeSync(backupTemporaryDescriptor); } catch { /* close attempted after commit */ }
      backupTemporaryDescriptor = null;
      backupTemporaryIdentity = null;
    } catch (error) {
      if (backupTemporaryPath && backupTemporaryIdentity) {
        unlinkIfSameFileIdentity(backupTemporaryPath, backupTemporaryIdentity);
      }
      if (backupTemporaryDescriptor != null) {
        try { closeSync(backupTemporaryDescriptor); } catch { /* already closed */ }
      }
      if (db.inTransaction) db.exec('ROLLBACK');
      let rollbackRestored = null;
      try {
        const afterRollback = inventoryPrivateMessageResidue(db);
        rollbackRestored = afterRollback.contentFingerprint === inventory.contentFingerprint
          && sameDatabaseObject(afterRollback.database.pathIdentity, inventory.database.pathIdentity);
      } catch {
        rollbackRestored = false;
      }
      report.status = transactionStarted ? 'rolled-back' : 'aborted';
      report.rolledBack = transactionStarted ? rollbackRestored : null;
      report.backupPromoted = backupPromoted;
      report.error = error.message;
      report.completedAt = new Date().toISOString();
      try {
        writeReport(reportWriter, report);
      } catch (reportError) {
        report.reportWriteError = reportError.message;
      }
      return report;
    }
    report.completedAt = new Date().toISOString();
    try {
      if (typeof options.beforeFinalReportWrite === 'function') options.beforeFinalReportWrite();
      if (report.status === 'applied'
          && !await verifyArtifact(
            report.backup.path,
            report.backup.pathIdentity,
            report.backup.sha256,
            report.backup.bytes
          )) {
        markCommittedBackupVerificationFailure(report, report.applied);
      }
      writeReport(reportWriter, report);
      if (report.status === 'applied'
          && !await verifyArtifact(
            report.backup.path,
            report.backup.pathIdentity,
            report.backup.sha256,
            report.backup.bytes
          )) {
        markCommittedBackupVerificationFailure(report, report.applied);
        writeReport(reportWriter, report);
      }
    } catch (error) {
      if (report.status === 'applied') report.status = 'applied-report-write-failed';
      report.reportWriteError = error.message;
    }
    return report;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    const failure = report || {
      tool: 'private-message-residue-adjudication',
      mode,
      database: dbPath,
      startedAt,
    };
    failure.status = 'aborted';
    failure.error = error.message;
    failure.completedAt = new Date().toISOString();
    try {
      writeReport(reportWriter, failure);
    } catch (reportError) {
      failure.reportWriteError = reportError.message;
    }
    return failure;
  } finally {
    reportWriter?.close();
    db.close();
  }
}

function parseArgs(argv) {
  const options = { mode: 'inventory' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!options.dbPath && !arg.startsWith('--')) options.dbPath = arg;
    else if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--manifest') options.manifestPath = argv[++index];
    else if (arg === '--confirm') options.confirm = argv[++index];
    else if (arg === '--backup') options.backupPath = argv[++index];
    else if (arg === '--report') options.reportPath = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!options.dbPath) {
    throw new Error('usage: node private-message-residue-adjudication.mjs <db-path> [--mode inventory|plan|execute] [--manifest <path>] [--confirm <token> --backup <new-path> --report <new-path>]');
  }
  return options;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const report = await runPrivateMessageResidueAdjudication(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (['refused', 'rolled-back', 'aborted', 'applied-report-write-failed',
      'committed-backup-verification-failed'].includes(report.status)) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`ABORT: ${error.message}\n`);
    process.exitCode = 1;
  }
}
