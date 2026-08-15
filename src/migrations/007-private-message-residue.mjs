/**
 * Migration 007 — restore private message bodies and remove shared/search residue.
 *
 * This is deliberately an OFFLINE operator migration. It defaults to dry-run.
 * Execution requires all of:
 *
 *   node dist/migrations/007-private-message-residue.mjs <db-path> \
 *     --execute --confirm <token-from-dry-run> \
 *     --backup <new-backup-path> --report <new-report-path>
 *
 * The server must be stopped while it runs. The script re-scans under a write
 * transaction and refuses to mutate if the confirmation token changed. Every
 * legacy pointer/entity/message/vector row must be uniquely and tenant-safely
 * accounted for; ambiguous or orphaned state is reported and left untouched.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmodSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const POINTER_PREFIX = 'Full content stored as entity "';
const POINTER_RE = /^Full content stored as entity "([^"\r\n]+)"(?:\.|\s|$)/;
const AUDIT_TABLE = 'private_message_residue_migration_audit';
const DEFAULT_VECTOR_TABLE = 'shared_memory_vec';
const DEFAULT_VECTOR_INDEX_TABLE = 'neural_vec_index';
const SAFE_SQLITE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-journal', '-shm'];
const PRIVATE_OBSERVATION_SOURCES = new Set([
  'create_entities_inline',
  'add_observations',
]);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function fileHash(path) {
  const digest = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  return digest.digest('hex');
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

function sameFileObject(left, right) {
  return Boolean(left && right
    && left.device === right.device
    && left.inode === right.inode);
}

function databasePathFromConnection(db) {
  const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
  if (!main?.file) throw new Error('migration requires a file-backed main SQLite database');
  return main.file;
}

function logicalDatabaseSnapshot(db) {
  const schemaObjects = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    ORDER BY type, name COLLATE BINARY
  `).all();
  const tables = schemaObjects
    .filter((object) => object.type === 'table')
    .map((object) => object.name);
  const tableDigests = [];
  for (const table of tables) {
    const tableSql = schemaObjects.find((object) => object.type === 'table' && object.name === table)?.sql || '';
    const columns = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
      .map((column) => String(column.name).toLowerCase()));
    const rowIdAlias = /\bWITHOUT\s+ROWID\b/i.test(tableSql)
      ? null
      : ['rowid', '_rowid_', 'oid'].find((candidate) => !columns.has(candidate));
    const select = rowIdAlias
      ? `SELECT ${rowIdAlias} AS __pmr_logical_rowid, * FROM ${quoteIdentifier(table)}`
      : `SELECT * FROM ${quoteIdentifier(table)}`;
    const rowHashes = [];
    for (const row of db.prepare(select).iterate()) rowHashes.push(hash(stableStringify(row)));
    rowHashes.sort();
    tableDigests.push({ table, rows: rowHashes.length, digest: hash(rowHashes.join('\n')) });
  }
  const schemaDigest = hash(stableStringify(schemaObjects));
  return {
    schemaObjects: schemaObjects.length,
    schemaDigest,
    tables: tableDigests,
    digest: hash(stableStringify({ schemaDigest, tables: tableDigests })),
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

function uniqueSiblingPath(path) {
  return `${path}.unverified-${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function publishNoClobber(temporaryPath, finalPath) {
  linkSync(temporaryPath, finalPath);
  try {
    chmodSync(finalPath, 0o600);
    fsyncFileAndParent(finalPath);
    unlinkSync(temporaryPath);
  } catch (error) {
    try {
      const temporaryIdentity = pathIdentity(temporaryPath);
      const finalIdentity = pathIdentity(finalPath);
      if (sameFileObject(temporaryIdentity, finalIdentity)) unlinkSync(finalPath);
    } catch {
      // Preserve an independently-created destination if publication lost ownership.
    }
    throw error;
  }
}

function sqlitePathsCollide(left, right) {
  if (left === right) return true;
  return SQLITE_SIDECAR_SUFFIXES.some((suffix) => left === `${right}${suffix}` || right === `${left}${suffix}`);
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

function validateReportPath(databasePath, reportPath) {
  const canonicalDatabase = realpathSync(resolve(databasePath));
  const canonicalReport = canonicalProspectivePath(reportPath);
  if (sqlitePathsCollide(canonicalDatabase, canonicalReport)) {
    throw new Error('report path collides with the source SQLite database or one of its sidecars');
  }
}

function validateArtifactPaths(databasePath, backupPath, reportPath) {
  const canonicalDatabase = realpathSync(resolve(databasePath));
  const canonicalBackup = canonicalProspectivePath(backupPath);
  const canonicalReport = canonicalProspectivePath(reportPath);
  if (new Set([canonicalDatabase, canonicalBackup, canonicalReport]).size !== 3) {
    throw new Error('database, backup, and report paths must be distinct');
  }
  if (sqlitePathsCollide(canonicalDatabase, canonicalBackup)) {
    throw new Error('backup path collides with the source SQLite database or one of its sidecars');
  }
  if (sqlitePathsCollide(canonicalDatabase, canonicalReport)) {
    throw new Error('report path collides with the source SQLite database or one of its sidecars');
  }
  if (sqlitePathsCollide(canonicalBackup, canonicalReport)) {
    throw new Error('backup and report paths collide within one SQLite sidecar namespace');
  }
}

async function verifyArtifact(path, expectedIdentity, expectedHash, expectedBytes) {
  try {
    const before = pathIdentity(path);
    if (!sameFileObject(before, expectedIdentity)
        || before.realpath !== expectedIdentity.realpath
        || before.bytes !== String(expectedBytes)
        || statSync(path).size !== expectedBytes) return false;
    const actualHash = await fileHash(path);
    const after = pathIdentity(path);
    return sameFileObject(after, expectedIdentity)
      && after.realpath === expectedIdentity.realpath
      && after.bytes === String(expectedBytes)
      && statSync(path).size === expectedBytes
      && actualHash === expectedHash;
  } catch {
    return false;
  }
}

function unlinkIfSameObject(path, expectedIdentity) {
  try {
    if (!sameFileObject(pathIdentity(path), expectedIdentity)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function markCommittedBackupVerificationFailure(report, counts) {
  report.status = 'committed-backup-verification-failed';
  report.committed = true;
  report.committedCounts = counts || report.applied || report.committedCounts;
  delete report.applied;
  report.error = 'database committed but the verified backup is missing or changed';
}

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? COLLATE NOCASE"
  ).get(name));
}

function tableColumns(db, name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

function configuredTableName(environmentName, fallback) {
  const configured = process.env[environmentName];
  if (configured == null || configured === '') return fallback;
  if (
    !SAFE_SQLITE_IDENTIFIER_RE.test(configured)
    || configured.toLowerCase().startsWith('sqlite_')
  ) {
    throw new Error(`unsafe ${environmentName} identifier: ${JSON.stringify(configured)}`);
  }
  return configured;
}

function vectorStorageConfiguration() {
  const vectorTable = configuredTableName('SQLITE_VEC_TABLE', DEFAULT_VECTOR_TABLE);
  const indexTable = configuredTableName('SQLITE_VEC_INDEX_TABLE', DEFAULT_VECTOR_INDEX_TABLE);
  if (vectorTable.toLowerCase() === indexTable.toLowerCase()) {
    throw new Error('SQLITE_VEC_TABLE and SQLITE_VEC_INDEX_TABLE must be distinct');
  }
  return { vectorTable, indexTable };
}

function issue(code, details = {}) {
  return { code, ...details };
}

function messageDetailDiscriminator(payload) {
  return [payload?.type, payload?.entityType, payload?.memoryType, payload?.memory_type]
    .some((value) => String(value ?? '').trim().toLowerCase() === 'message_detail');
}

function parseEntity(row) {
  let payload;
  try {
    payload = JSON.parse(row.content);
  } catch {
    return { error: 'invalid_entity_json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'invalid_entity_payload' };
  }
  if (!messageDetailDiscriminator(payload)) return { error: 'not_message_detail' };
  if (typeof payload.name !== 'string' || !payload.name) return { error: 'missing_entity_name' };
  if (!Array.isArray(payload.observations) || payload.observations.length !== 1
      || typeof payload.observations[0] !== 'string'
      || payload.observations[0].length <= 3000) {
    return { error: 'invalid_payload_observations' };
  }
  return { payload, body: payload.observations[0] };
}

function entityReferenceNames(payload) {
  return [
    payload?.name,
    ...(Array.isArray(payload?.aliases) ? payload.aliases : []),
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

function normalizedEntityReference(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || null;
}

function entityReferenceVariants(value) {
  const normalized = normalizedEntityReference(value);
  if (!normalized) return [];
  const variants = new Set([normalized]);
  for (const suffix of ['-llc', '-inc', '-corp', '-co', '-company']) {
    if (normalized.endsWith(suffix)) variants.add(normalized.slice(0, -suffix.length));
    else variants.add(`${normalized}${suffix}`);
  }
  if (/-v\d{1,3}$/.test(normalized)) variants.add(normalized.replace(/-v\d{1,3}$/, ''));
  return Array.from(variants).filter(Boolean);
}

function isReservedPrivateReference(value) {
  return normalizedEntityReference(value)?.startsWith('msg-detail-') === true;
}

function entityReferenceMatches(payload, reference) {
  const requested = new Set(entityReferenceVariants(reference));
  if (requested.size === 0) return false;
  return entityReferenceNames(payload).some((value) =>
    entityReferenceVariants(value).some((variant) => requested.has(variant)));
}

function loadVecExtensionIfNeeded(db, vectorTable) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE"
  ).get(vectorTable);
  if (!row || !/\bUSING\s+vec0\b/i.test(String(row.sql || ''))) return;
  try {
    db.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get();
    return;
  } catch {
    // The schema is present but this connection has not loaded sqlite-vec yet.
  }
  let sqliteVec;
  try {
    sqliteVec = require('sqlite-vec');
    const load = sqliteVec.load || sqliteVec.default?.load;
    if (typeof load !== 'function') throw new Error('sqlite-vec has no load() export');
    load(db);
    db.prepare(`SELECT COUNT(*) AS count FROM ${vectorTable}`).get();
  } catch (error) {
    throw new Error(`sqlite-vec table exists but its extension could not be loaded: ${error.message}`);
  }
}

function validateSchema(db, vectorStorage) {
  const problems = [];
  for (const table of ['ai_messages', 'shared_memory']) {
    if (!tableExists(db, table)) problems.push(issue('missing_required_table', { table }));
  }
  if (problems.length) return problems;

  const aiColumns = tableColumns(db, 'ai_messages');
  for (const column of ['id', 'legacy_shared_memory_id', 'tenant_id', 'from_agent', 'to_agent', 'content']) {
    if (!aiColumns.has(column)) problems.push(issue('missing_required_column', { table: 'ai_messages', column }));
  }
  const sharedColumns = tableColumns(db, 'shared_memory');
  for (const column of ['id', 'tenant_id', 'memory_type', 'content', 'created_by']) {
    if (!sharedColumns.has(column)) problems.push(issue('missing_required_column', { table: 'shared_memory', column }));
  }
  if (tableExists(db, vectorStorage.indexTable)) {
    const vecColumns = tableColumns(db, vectorStorage.indexTable);
    for (const column of ['memory_id', 'tenant_id', 'memory_type', 'content', 'vector_rowid']) {
      if (!vecColumns.has(column)) {
        problems.push(issue('missing_required_column', { table: vectorStorage.indexTable, column }));
      }
    }
  }
  for (const [table, required] of [
    ['graph_lookup_keys', ['tenant_id', 'memory_id']],
    ['entity_lookup_identity_links', ['tenant_id', 'memory_id']],
    ['entity_context_facets', ['tenant_id', 'source_row_id']],
  ]) {
    if (!tableExists(db, table)) continue;
    const columns = tableColumns(db, table);
    for (const column of required) {
      if (!columns.has(column)) problems.push(issue('missing_required_column', { table, column }));
    }
  }
  return problems;
}

function parseDirectoryEntity(row, privateKeys) {
  let payload;
  try {
    payload = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const references = entityReferenceNames(payload);
  if (references.length === 0) return null;
  const key = `${row.tenant_id}\u0000${row.id}`;
  return {
    row,
    payload,
    references,
    private: privateKeys.has(key),
  };
}

function buildEntityDirectory(entityRows, privateKeys) {
  const byId = new Map();
  const byReference = new Map();
  const descriptors = [];
  const add = (map, key, descriptor) => {
    const current = map.get(key) || [];
    if (!current.some((candidate) =>
      candidate.row.id === descriptor.row.id
      && candidate.row.tenant_id === descriptor.row.tenant_id)) {
      current.push(descriptor);
      map.set(key, current);
    }
  };
  for (const row of entityRows) {
    const descriptor = parseDirectoryEntity(row, privateKeys);
    if (!descriptor) continue;
    descriptors.push(descriptor);
    add(byId, `${row.tenant_id}\u0000${row.id}`, descriptor);
    for (const reference of descriptor.references) {
      for (const variant of entityReferenceVariants(reference)) {
        add(byReference, `${row.tenant_id}\u0000${variant}`, descriptor);
      }
    }
  }
  return {
    descriptors,
    byId,
    byReference,
    lookupId(tenantId, value) {
      if (typeof value !== 'string' || value.length === 0) return [];
      return byId.get(`${tenantId}\u0000${value}`) || [];
    },
    lookupReference(tenantId, value) {
      const candidates = entityReferenceVariants(value)
        .flatMap((variant) => byReference.get(`${tenantId}\u0000${variant}`) || []);
      return Array.from(new Map(candidates.map((candidate) => [
        `${candidate.row.tenant_id}\u0000${candidate.row.id}`,
        candidate,
      ])).values());
    },
    resolveAny(tenantId, value) {
      const candidates = [
        ...this.lookupId(tenantId, value),
        ...this.lookupReference(tenantId, value),
      ];
      return Array.from(new Map(candidates.map((candidate) => [
        `${candidate.row.tenant_id}\u0000${candidate.row.id}`,
        candidate,
      ])).values());
    },
  };
}

function classifyUnlinkedVector(row, entityDirectory) {
  const memoryType = String(row.memory_type || '').trim().toLowerCase();
  const graphType = ['entity', 'observation', 'relation'].includes(memoryType);
  let payload;
  try {
    payload = JSON.parse(row.content);
  } catch {
    return graphType
      ? { private: true, reason: 'invalid_graph_json' }
      : { private: false };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return graphType
      ? { private: true, reason: 'invalid_graph_payload' }
      : { private: false };
  }
  if (messageDetailDiscriminator(payload)) {
    return { private: true, reason: 'message_detail_discriminator' };
  }
  if (entityReferenceNames(payload).some((reference) => isReservedPrivateReference(reference))) {
    return { private: true, reason: 'reserved_entity_reference' };
  }
  if (memoryType === 'observation') {
    const parentId = typeof payload.metadata?.entityId === 'string'
      ? payload.metadata.entityId
      : null;
    const parentName = typeof payload.entityName === 'string' ? payload.entityName : null;
    const idMatches = parentId ? entityDirectory.lookupId(row.tenant_id, parentId) : [];
    const nameMatches = parentName
      ? entityDirectory.lookupReference(row.tenant_id, parentName)
      : [];
    const candidates = Array.from(new Map(
      [...idMatches, ...nameMatches].map((candidate) => [
        `${candidate.row.tenant_id}\u0000${candidate.row.id}`,
        candidate,
      ])
    ).values());
    const clues = observationPrivacyClues(payload, parentId, parentName);
    if (
      candidates.some((candidate) => candidate.private)
      || [parentId, parentName].some((reference) => isReservedPrivateReference(reference))
    ) {
      return { private: true, reason: 'private_observation_reference' };
    }
    if (parentId && idMatches.length === 0) {
      return { private: true, reason: 'unresolved_observation_parent_id' };
    }
    if (clues.sourceMarked || clues.longContent) {
      const safelyResolvedPublicParent = candidates.length === 1
        && !candidates[0].private
        && (!parentId || idMatches.length === 1)
        && (!parentName || nameMatches.length === 1);
      if (!safelyResolvedPublicParent) {
        return { private: true, reason: 'unresolved_private_shaped_observation' };
      }
    }
  }
  if (memoryType === 'relation') {
    for (const reference of [payload.from, payload.to]) {
      if (
        isReservedPrivateReference(reference)
        || entityDirectory.resolveAny(row.tenant_id, reference)
          .some((candidate) => candidate.private)
      ) {
        return { private: true, reason: 'private_relation_reference' };
      }
    }
  }
  return { private: false };
}

function observationPrivacyClues(payload, parentId, parentName) {
  const source = typeof payload.metadata?.source === 'string'
    ? payload.metadata.source.trim().toLowerCase()
    : '';
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  const longContent = contents.some((value) => typeof value === 'string' && value.length > 3000);
  const reservedReference = [parentId, parentName].some((value) =>
    isReservedPrivateReference(value));
  return {
    source,
    sourceMarked: PRIVATE_OBSERVATION_SOURCES.has(source),
    longContent,
    reservedReference,
  };
}

function findPrimaryMatches(db, memoryId) {
  return db.prepare(`
    SELECT id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content
    FROM ai_messages
    WHERE id = ? OR legacy_shared_memory_id = ?
    ORDER BY id
  `).all(memoryId, memoryId);
}

function findPrimaryLegacyMatches(db, sharedMemoryId) {
  return db.prepare(`
    SELECT id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content
    FROM ai_messages
    WHERE legacy_shared_memory_id = ?
    ORDER BY id
  `).all(sharedMemoryId);
}

function parseLegacySharedMessage(row) {
  let payload;
  try {
    payload = JSON.parse(row.content);
  } catch {
    return { error: 'invalid_shared_message_json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'invalid_shared_message_payload' };
  }
  const fromAgent = typeof payload.from === 'string' && payload.from.length > 0
    ? payload.from
    : typeof payload.sender === 'string' && payload.sender.length > 0
      ? payload.sender
      : row.created_by && row.created_by.length > 0
        ? row.created_by
        : 'unknown';
  const toAgent = payload.to || payload.target || 'unknown';
  const content = payload.content || payload.message || '';
  if (typeof toAgent !== 'string' || typeof content !== 'string') {
    return { error: 'invalid_shared_message_fields' };
  }
  return { fromAgent, toAgent, content };
}

export function analyzePrivateMessageResidue(db) {
  const vectorStorage = vectorStorageConfiguration();
  const issues = validateSchema(db, vectorStorage);
  if (issues.length) {
    return finalizeAnalysis({
      issues,
      pointers: [],
      detailEntities: [],
      privateObservations: [],
      privateRelations: [],
      sharedMessages: [],
      vectors: [],
      vectorStorage,
    });
  }

  loadVecExtensionIfNeeded(db, vectorStorage.vectorTable);

  const pointerRows = db.prepare(`
    SELECT id, tenant_id, from_agent, to_agent, content
    FROM ai_messages
    WHERE content LIKE ?
    ORDER BY tenant_id, id
  `).all(`${POINTER_PREFIX}%`);

  const entityRows = db.prepare(`
    SELECT id, tenant_id, memory_type, content, created_by
    FROM shared_memory
    WHERE LOWER(memory_type) IN ('entity', 'message_detail')
       OR (
         json_valid(content)
         AND (
           LOWER(TRIM(COALESCE(json_extract(content, '$.type'), ''))) = 'message_detail'
           OR LOWER(TRIM(COALESCE(json_extract(content, '$.entityType'), ''))) = 'message_detail'
           OR LOWER(TRIM(COALESCE(json_extract(content, '$.memoryType'), ''))) = 'message_detail'
           OR LOWER(TRIM(COALESCE(json_extract(content, '$.memory_type'), ''))) = 'message_detail'
         )
       )
    ORDER BY tenant_id, id
  `).all();
  const entityPayloadByKey = new Map();
  for (const row of entityRows) {
    const memoryType = String(row.memory_type).trim().toLowerCase();
    let payload;
    try {
      payload = JSON.parse(row.content);
    } catch {
      if (memoryType === 'entity') {
        issues.push(issue('invalid_entity_json', { entityId: row.id, tenantId: row.tenant_id }));
      }
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      if (memoryType === 'entity') {
        issues.push(issue('invalid_entity_payload', { entityId: row.id, tenantId: row.tenant_id }));
      }
      continue;
    }
    entityPayloadByKey.set(`${row.tenant_id}\u0000${row.id}`, payload);
  }
  const allDetailRows = entityRows.filter((row) => {
    const memoryType = String(row.memory_type).trim().toLowerCase();
    if (memoryType === 'message_detail') return true;
    const payload = entityPayloadByKey.get(`${row.tenant_id}\u0000${row.id}`);
    if (!payload) return false;
    if (messageDetailDiscriminator(payload)) return true;
    return memoryType === 'entity'
      && entityReferenceNames(payload).some((reference) => isReservedPrivateReference(reference));
  });
  const parsedDetails = allDetailRows.map((row) => ({ row, parsed: parseEntity(row) }));
  const privateEntityKeys = new Set(allDetailRows.map((row) =>
    `${row.tenant_id}\u0000${row.id}`));
  const entityDirectory = buildEntityDirectory(entityRows, privateEntityKeys);
  const parsedDetailByKey = new Map(parsedDetails.map((entry) => [
    `${entry.row.tenant_id}\u0000${entry.row.id}`,
    entry,
  ]));
  const referencedDetailIds = new Set();
  const pointerPlans = [];

  for (const message of pointerRows) {
    const match = POINTER_RE.exec(message.content);
    if (!match) {
      issues.push(issue('malformed_pointer', { messageId: message.id, tenantId: message.tenant_id }));
      continue;
    }
    const entityName = match[1];
    const expectedName = `msg-detail-${message.id}`;
    if (entityName !== expectedName) {
      issues.push(issue('unexpected_pointer_name', {
        messageId: message.id, tenantId: message.tenant_id, entityName, expectedName,
      }));
      continue;
    }

    const candidates = entityDirectory.lookupReference(message.tenant_id, entityName);
    if (candidates.length !== 1) {
      issues.push(issue(candidates.length === 0 ? 'missing_pointer_payload' : 'ambiguous_pointer_payload', {
        messageId: message.id,
        tenantId: message.tenant_id,
        entityName,
        candidateIds: candidates.map((candidate) => candidate.row.id),
      }));
      continue;
    }
    const descriptor = candidates[0];
    const detail = parsedDetailByKey.get(`${message.tenant_id}\u0000${descriptor.row.id}`);
    if (!descriptor.private || !detail || detail.parsed.error) {
      issues.push(issue('pointer_resolves_non_private_entity', {
        messageId: message.id,
        tenantId: message.tenant_id,
        entityName,
        candidateId: descriptor.row.id,
      }));
      continue;
    }
    const { row, parsed } = detail;
    if (parsed.payload.name !== entityName) {
      issues.push(issue('pointer_entity_case_mismatch', {
        messageId: message.id, tenantId: message.tenant_id, entityId: row.id, entityName,
      }));
      continue;
    }
    if (row.memory_type !== 'entity') {
      issues.push(issue('unexpected_payload_memory_type', {
        messageId: message.id, tenantId: message.tenant_id, entityId: row.id, memoryType: row.memory_type,
      }));
      continue;
    }
    if (row.created_by !== message.from_agent) {
      issues.push(issue('payload_creator_mismatch', {
        messageId: message.id, tenantId: message.tenant_id, entityId: row.id,
      }));
      continue;
    }
    if (parsed.payload.createdBy != null && parsed.payload.createdBy !== message.from_agent) {
      issues.push(issue('payload_embedded_creator_mismatch', {
        messageId: message.id, tenantId: message.tenant_id, entityId: row.id,
      }));
      continue;
    }
    if (referencedDetailIds.has(row.id)) {
      issues.push(issue('payload_referenced_multiple_times', {
        messageId: message.id, tenantId: message.tenant_id, entityId: row.id,
      }));
      continue;
    }
    referencedDetailIds.add(row.id);
    pointerPlans.push({
      messageId: message.id,
      tenantId: message.tenant_id,
      fromAgent: message.from_agent,
      toAgent: message.to_agent,
      entityId: row.id,
      entityName,
      body: parsed.body,
      bodyHash: hash(parsed.body),
      pointerHash: hash(message.content),
    });
  }

  for (const { row, parsed } of parsedDetails) {
    if (parsed.error) {
      issues.push(issue(parsed.error, { entityId: row.id, tenantId: row.tenant_id }));
    } else if (!referencedDetailIds.has(row.id)) {
      issues.push(issue('orphan_message_detail', {
        entityId: row.id, tenantId: row.tenant_id, entityName: parsed.payload.name,
      }));
    }
  }

  const privateObservationPlans = [];
  const observationRows = db.prepare(`
    SELECT id, tenant_id, content, created_by
    FROM shared_memory
    WHERE LOWER(memory_type) = 'observation'
    ORDER BY tenant_id, id
  `).all();
  for (const row of observationRows) {
    let payload;
    try {
      payload = JSON.parse(row.content);
    } catch {
      issues.push(issue('invalid_observation_json', {
        observationId: row.id,
        tenantId: row.tenant_id,
      }));
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      issues.push(issue('invalid_observation_payload', {
        observationId: row.id,
        tenantId: row.tenant_id,
      }));
      continue;
    }

    const parentId = typeof payload.metadata?.entityId === 'string'
      ? payload.metadata.entityId
      : null;
    const parentName = typeof payload.entityName === 'string'
      ? payload.entityName
      : null;
    const idMatches = parentId ? entityDirectory.lookupId(row.tenant_id, parentId) : [];
    const nameMatches = parentName
      ? entityDirectory.lookupReference(row.tenant_id, parentName)
      : [];
    const candidates = Array.from(new Map(
      [...idMatches, ...nameMatches].map((candidate) => [
        `${candidate.row.tenant_id}\u0000${candidate.row.id}`,
        candidate,
      ])
    ).values());
    const clues = observationPrivacyClues(payload, parentId, parentName);

    if (parentId && idMatches.length === 0) {
      issues.push(issue('orphan_private_observation', {
        observationId: row.id,
        tenantId: row.tenant_id,
        parentEntityId: parentId,
        parentEntityName: parentName,
        reason: 'unresolved_parent_id',
        sourceMarked: clues.sourceMarked,
        longContent: clues.longContent,
      }));
      continue;
    }

    if (candidates.length === 0) {
      if (parentName && (clues.reservedReference || clues.sourceMarked || clues.longContent)) {
        issues.push(issue('orphan_private_observation', {
          observationId: row.id,
          tenantId: row.tenant_id,
          parentEntityName: parentName,
          reason: 'unresolved_private_shaped_parent_name',
          sourceMarked: clues.sourceMarked,
          longContent: clues.longContent,
        }));
      } else if (!parentName && (clues.sourceMarked || clues.longContent)) {
        issues.push(issue('orphan_private_observation', {
          observationId: row.id,
          tenantId: row.tenant_id,
          reason: 'missing_private_shaped_parent_reference',
          sourceMarked: clues.sourceMarked,
          longContent: clues.longContent,
        }));
      }
      continue;
    }

    const privateCandidates = candidates.filter((candidate) => candidate.private);
    if (privateCandidates.length === 0) {
      if (
        parentName
        && (
          clues.reservedReference
          || (
            nameMatches.length === 0
            && (clues.sourceMarked || clues.longContent)
          )
        )
      ) {
        issues.push(issue('private_observation_parent_mismatch', {
          observationId: row.id,
          tenantId: row.tenant_id,
          parentEntityIds: candidates.map((candidate) => candidate.row.id),
          reason: 'private_shaped_name_disagrees_with_public_id',
        }));
      }
      continue;
    }
    if (candidates.length !== 1 || privateCandidates.length !== 1) {
      issues.push(issue('ambiguous_private_observation_parent', {
        observationId: row.id,
        tenantId: row.tenant_id,
        parentEntityIds: candidates.map((candidate) => candidate.row.id),
      }));
      continue;
    }
    const parent = privateCandidates[0];
    if (
      (parentId && parentId !== parent.row.id)
      || (parentName && !entityReferenceMatches(parent.payload, parentName))
    ) {
      issues.push(issue('private_observation_parent_mismatch', {
        observationId: row.id,
        tenantId: row.tenant_id,
        parentEntityId: parent.row.id,
      }));
      continue;
    }
    privateObservationPlans.push({
      id: row.id,
      tenantId: row.tenant_id,
      parentEntityId: parent.row.id,
      createdBy: row.created_by,
      contentHash: hash(row.content),
    });
  }

  const privateRelationPlans = [];
  const relationRows = db.prepare(`
    SELECT id, tenant_id, content, created_by
    FROM shared_memory
    WHERE LOWER(memory_type) = 'relation'
    ORDER BY tenant_id, id
  `).all();
  for (const row of relationRows) {
    let payload;
    try {
      payload = JSON.parse(row.content);
    } catch {
      issues.push(issue('invalid_relation_json', {
        relationId: row.id,
        tenantId: row.tenant_id,
      }));
      continue;
    }
    if (
      !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || typeof payload.from !== 'string'
      || typeof payload.to !== 'string'
      || payload.from.length === 0
      || payload.to.length === 0
    ) {
      issues.push(issue('invalid_relation_payload', {
        relationId: row.id,
        tenantId: row.tenant_id,
      }));
      continue;
    }

    let referencesPrivateEntity = false;
    let referenceIsUnsafe = false;
    for (const [endpoint, reference] of [['from', payload.from], ['to', payload.to]]) {
      const candidates = entityDirectory.resolveAny(row.tenant_id, reference);
      const privateCandidates = candidates.filter((candidate) => candidate.private);
      if (privateCandidates.length > 0) {
        if (candidates.length !== 1 || privateCandidates.length !== 1) {
          issues.push(issue('ambiguous_private_relation_reference', {
            relationId: row.id,
            tenantId: row.tenant_id,
            endpoint,
            reference,
            parentEntityIds: candidates.map((candidate) => candidate.row.id),
          }));
          referenceIsUnsafe = true;
        } else {
          referencesPrivateEntity = true;
        }
      } else if (isReservedPrivateReference(reference)) {
        issues.push(issue('orphan_private_relation_reference', {
          relationId: row.id,
          tenantId: row.tenant_id,
          endpoint,
          reference,
          candidateIds: candidates.map((candidate) => candidate.row.id),
        }));
        referenceIsUnsafe = true;
      }
    }
    if (referencesPrivateEntity && !referenceIsUnsafe) {
      privateRelationPlans.push({
        id: row.id,
        tenantId: row.tenant_id,
        createdBy: row.created_by,
        contentHash: hash(row.content),
      });
    }
  }

  const sharedRows = db.prepare(`
    SELECT id, tenant_id, content, created_by
    FROM shared_memory
    WHERE LOWER(memory_type) = 'ai_message'
    ORDER BY tenant_id, id
  `).all();
  const sharedPlans = [];
  for (const row of sharedRows) {
    // Shared-row deletion requires the explicit migration provenance link.
    // Equality with ai_messages.id is not sufficient: unrelated rows can
    // legitimately collide on an opaque ID.
    const matches = findPrimaryLegacyMatches(db, row.id);
    if (matches.length !== 1) {
      issues.push(issue(matches.length === 0 ? 'unrepresented_shared_message' : 'ambiguous_shared_message', {
        sharedMemoryId: row.id, tenantId: row.tenant_id, primaryIds: matches.map((match) => match.id),
      }));
      continue;
    }
    const primary = matches[0];
    if (primary.tenant_id !== row.tenant_id) {
      issues.push(issue('shared_message_tenant_mismatch', {
        sharedMemoryId: row.id, tenantId: row.tenant_id, primaryId: primary.id,
        primaryTenantId: primary.tenant_id,
      }));
      continue;
    }
    const parsed = parseLegacySharedMessage(row);
    if (parsed.error) {
      issues.push(issue(parsed.error, { sharedMemoryId: row.id, tenantId: row.tenant_id }));
      continue;
    }
    if (
      primary.from_agent !== parsed.fromAgent
      || primary.to_agent !== parsed.toAgent
      || primary.content !== parsed.content
    ) {
      issues.push(issue('shared_message_payload_mismatch', {
        sharedMemoryId: row.id,
        tenantId: row.tenant_id,
        primaryId: primary.id,
      }));
      continue;
    }
    sharedPlans.push({
      sharedMemoryId: row.id,
      tenantId: row.tenant_id,
      primaryId: primary.id,
      sharedCreatedBy: row.created_by,
      parsedFromAgent: parsed.fromAgent,
      parsedToAgent: parsed.toAgent,
      parsedContentHash: hash(parsed.content),
      primaryLegacySharedMemoryId: primary.legacy_shared_memory_id,
      primaryTenantId: primary.tenant_id,
      primaryFromAgent: primary.from_agent,
      primaryToAgent: primary.to_agent,
      sharedContentHash: hash(row.content),
      primaryContentHash: hash(primary.content),
    });
  }

  const vectorPlans = [];
  if (tableExists(db, vectorStorage.indexTable)) {
    const detailByKey = new Map(parsedDetails.map(({ row }) => [
      `${row.tenant_id}\u0000${row.id}`,
      row,
    ]));
    const privateObservationByKey = new Map(privateObservationPlans.map((row) => [
      `${row.tenantId}\u0000${row.id}`,
      row,
    ]));
    const privateRelationByKey = new Map(privateRelationPlans.map((row) => [
      `${row.tenantId}\u0000${row.id}`,
      row,
    ]));
    const vectorRowReferences = new Map();
    const targetVectorRowIds = new Map();
    const vectorTablePresent = tableExists(db, vectorStorage.vectorTable);
    const vecExistsStatement = vectorTablePresent
      ? db.prepare(`SELECT 1 FROM ${vectorStorage.vectorTable} WHERE rowid = ?`)
      : null;
    const rows = db.prepare(`
      SELECT memory_id, tenant_id, memory_type, content, vector_rowid
      FROM ${vectorStorage.indexTable}
      ORDER BY tenant_id, memory_id
    `).all();
    for (const row of rows) {
      const rowKey = `${row.tenant_id}\u0000${row.memory_id}`;
      if (row.vector_rowid != null) {
        const references = vectorRowReferences.get(row.vector_rowid) || [];
        references.push({ rowKey, memoryId: row.memory_id });
        vectorRowReferences.set(row.vector_rowid, references);
      }

      let isTarget = false;
      let targetKind = null;
      let primaryMatch = null;
      if (detailByKey.has(rowKey)) {
        isTarget = true;
        targetKind = 'detail_entity';
      } else if (privateObservationByKey.has(rowKey)) {
        isTarget = true;
        targetKind = 'private_observation';
      } else if (privateRelationByKey.has(rowKey)) {
        isTarget = true;
        targetKind = 'private_relation';
      } else if (['ai_message', 'message_detail'].includes(String(row.memory_type).trim().toLowerCase())) {
        isTarget = true;
        targetKind = 'message_storage_type';
        const matches = findPrimaryMatches(db, row.memory_id);
        if (matches.length !== 1) {
          issues.push(issue(matches.length === 0 ? 'unrepresented_message_vector' : 'ambiguous_message_vector', {
            memoryId: row.memory_id,
            tenantId: row.tenant_id,
            primaryIds: matches.map((match) => match.id),
          }));
          continue;
        }
        if (matches[0].tenant_id !== row.tenant_id) {
          issues.push(issue('message_vector_tenant_mismatch', {
            memoryId: row.memory_id,
            tenantId: row.tenant_id,
            primaryId: matches[0].id,
            primaryTenantId: matches[0].tenant_id,
          }));
          continue;
        }
        primaryMatch = matches[0];
      } else {
        const classification = classifyUnlinkedVector(row, entityDirectory);
        if (classification.private) {
          issues.push(issue('unrepresented_private_vector', {
            memoryId: row.memory_id,
            tenantId: row.tenant_id,
            memoryType: row.memory_type,
            reason: classification.reason,
          }));
          continue;
        }
      }
      if (!isTarget) continue;

      if (row.vector_rowid != null) {
        if (!vecExistsStatement) {
          issues.push(issue('missing_vec0_table', {
            memoryId: row.memory_id,
            vectorRowId: row.vector_rowid,
            table: vectorStorage.vectorTable,
          }));
          continue;
        }
        if (!vecExistsStatement.get(row.vector_rowid)) {
          issues.push(issue('missing_vec0_row', {
            memoryId: row.memory_id,
            vectorRowId: row.vector_rowid,
            table: vectorStorage.vectorTable,
          }));
          continue;
        }
        const prior = targetVectorRowIds.get(row.vector_rowid);
        if (prior && prior.rowKey !== rowKey) {
          issues.push(issue('shared_vec0_row', {
            memoryId: row.memory_id,
            otherMemoryId: prior.memoryId,
            vectorRowId: row.vector_rowid,
          }));
          continue;
        }
        targetVectorRowIds.set(row.vector_rowid, { rowKey, memoryId: row.memory_id });
      }
      vectorPlans.push({
        memory_id: row.memory_id,
        tenant_id: row.tenant_id,
        memory_type: row.memory_type,
        vector_rowid: row.vector_rowid,
        contentHash: hash(row.content),
        targetKind,
        primaryMatch: primaryMatch ? {
          id: primaryMatch.id,
          legacySharedMemoryId: primaryMatch.legacy_shared_memory_id,
          tenantId: primaryMatch.tenant_id,
          fromAgent: primaryMatch.from_agent,
          toAgent: primaryMatch.to_agent,
          contentHash: hash(primaryMatch.content),
        } : null,
      });
    }

    for (const [vectorRowId, target] of targetVectorRowIds) {
      const external = (vectorRowReferences.get(vectorRowId) || [])
        .find((reference) => reference.rowKey !== target.rowKey);
      if (external) {
        issues.push(issue('vec0_row_referenced_by_non_target', {
          memoryId: target.memoryId,
          otherMemoryId: external.memoryId,
          vectorRowId,
        }));
      }
    }
  }

  const detailEntities = parsedDetails.map(({ row }) => ({
    id: row.id,
    tenantId: row.tenant_id,
    memoryType: row.memory_type,
    createdBy: row.created_by,
    contentHash: hash(row.content),
  }));
  const indexedRows = [
    ...detailEntities.map(({ id, tenantId }) => ({ id, tenantId })),
    ...privateObservationPlans.map(({ id, tenantId }) => ({ id, tenantId })),
    ...privateRelationPlans.map(({ id, tenantId }) => ({ id, tenantId })),
    ...sharedPlans.map(({ sharedMemoryId, tenantId }) => ({ id: sharedMemoryId, tenantId })),
  ];
  const uniqueIndexedRows = Array.from(new Map(
    indexedRows.map((row) => [`${row.tenantId}\u0000${row.id}`, row])
  ).values());
  const relatedIndexes = [];
  for (const [table, idColumn] of [
    ['graph_lookup_keys', 'memory_id'],
    ['entity_lookup_identity_links', 'memory_id'],
    ['entity_context_facets', 'source_row_id'],
  ]) {
    if (!tableExists(db, table)) continue;
    const statement = db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND ${idColumn} = ?`);
    for (const row of uniqueIndexedRows) {
      const matches = statement.all(row.tenantId, row.id);
      relatedIndexes.push({
        table,
        tenantId: row.tenantId,
        id: row.id,
        count: matches.length,
        rowsHash: hash(stableStringify(matches)),
      });
    }
  }

  return finalizeAnalysis({
    issues,
    pointers: pointerPlans,
    detailEntities,
    privateObservations: privateObservationPlans,
    privateRelations: privateRelationPlans,
    sharedMessages: sharedPlans,
    vectors: vectorPlans,
    relatedIndexes,
    vectorStorage,
  });
}

function finalizeAnalysis(analysis) {
  const fingerprintMaterial = {
    pointers: analysis.pointers.map(({
      messageId, tenantId, fromAgent, toAgent, entityId, entityName, bodyHash, pointerHash,
    }) => ({
      messageId, tenantId, fromAgent, toAgent, entityId, entityName, bodyHash, pointerHash,
    })),
    detailEntities: analysis.detailEntities,
    privateObservations: analysis.privateObservations,
    privateRelations: analysis.privateRelations,
    sharedMessages: analysis.sharedMessages,
    vectors: analysis.vectors,
    relatedIndexes: analysis.relatedIndexes || [],
    vectorStorage: analysis.vectorStorage,
    issues: analysis.issues,
  };
  const fingerprint = hash(stableStringify(fingerprintMaterial));
  return {
    ...analysis,
    ready: analysis.issues.length === 0,
    fingerprint,
    confirmationToken: `RESTORE-PRIVATE-MESSAGES-${fingerprint.slice(0, 16).toUpperCase()}`,
    counts: {
      pointers: analysis.pointers.length,
      detailEntities: analysis.detailEntities.length,
      privateObservations: analysis.privateObservations.length,
      privateRelations: analysis.privateRelations.length,
      sharedMessages: analysis.sharedMessages.length,
      vectorIndexRows: analysis.vectors.length,
      vec0Rows: new Set(analysis.vectors.map((row) => row.vector_rowid).filter((id) => id != null)).size,
      issues: analysis.issues.length,
    },
  };
}

function publicAnalysis(analysis) {
  return {
    ready: analysis.ready,
    fingerprint: analysis.fingerprint,
    confirmationToken: analysis.confirmationToken,
    counts: analysis.counts,
    vectorStorage: analysis.vectorStorage,
    issues: analysis.issues,
  };
}

function ensureNewOutputPath(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} path already exists: ${absolute}`);
  mkdirSync(dirname(absolute), { recursive: true });
  const fd = openSync(absolute, 'wx', 0o600);
  closeSync(fd);
  fsyncFileAndParent(absolute);
  return absolute;
}

function validateNewOutputPath(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} path already exists: ${absolute}`);
  mkdirSync(dirname(absolute), { recursive: true });
  return absolute;
}

function reportOwnership(path) {
  if (!path) return null;
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  const stats = fstatSync(fd, { bigint: true });
  return {
    fd,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    hash: hash(Buffer.alloc(0)),
  };
}

function writeReport(path, report, ownership) {
  if (!path) return;
  if (!ownership) throw new Error('report ownership evidence is required');
  const content = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const fd = ownership.fd;
  {
    const before = fstatSync(fd, { bigint: true });
    if (before.dev.toString() !== ownership.device || before.ino.toString() !== ownership.inode
        || before.ctimeNs.toString() !== ownership.ctimeNs) {
      throw new Error('report path ownership changed; refusing to overwrite it');
    }
    const pathBefore = lstatSync(path, { bigint: true });
    if (pathBefore.dev.toString() !== ownership.device || pathBefore.ino.toString() !== ownership.inode) {
      throw new Error('report path ownership changed; refusing to overwrite it');
    }
    const existing = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < existing.length) {
      const bytesRead = readSync(fd, existing, offset, existing.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== existing.length || hash(existing) !== ownership.hash) {
      throw new Error('report content changed outside this migration; refusing to overwrite it');
    }
    ftruncateSync(fd, 0);
    let written = 0;
    while (written < content.length) {
      written += writeSync(fd, content, written, content.length - written, written);
    }
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (after.dev.toString() !== ownership.device || after.ino.toString() !== ownership.inode) {
      throw new Error('report file identity changed during write');
    }
    const pathStats = lstatSync(path, { bigint: true });
    if (pathStats.dev.toString() !== ownership.device || pathStats.ino.toString() !== ownership.inode) {
      throw new Error('report path was independently replaced; replacement was preserved');
    }
    ownership.hash = hash(content);
    ownership.ctimeNs = after.ctimeNs.toString();
  }
}

function closeReportOwnership(ownership) {
  if (!ownership) return;
  closeSync(ownership.fd);
  ownership.fd = null;
}

function deleteScopedIndexRows(db, table, tenantColumn, idColumn, rows) {
  if (!tableExists(db, table)) return 0;
  const statement = db.prepare(`DELETE FROM ${table} WHERE ${tenantColumn} = ? AND ${idColumn} = ?`);
  let deleted = 0;
  for (const row of rows) deleted += statement.run(row.tenantId, row.id).changes;
  return deleted;
}

function applyAnalysis(db, analysis, options = {}) {
  const counts = {
    restoredMessages: 0,
    sharedMessagesDeleted: 0,
    detailEntitiesDeleted: 0,
    privateObservationsDeleted: 0,
    privateRelationsDeleted: 0,
    vectorIndexRowsDeleted: 0,
    vec0RowsDeleted: 0,
    graphLookupRowsDeleted: 0,
    identityLinkRowsDeleted: 0,
    contextFacetRowsDeleted: 0,
  };
  let step = 0;
  const failPoint = () => {
    step += 1;
    if (options.failAfterStep === step) throw new Error(`injected failure after step ${step}`);
  };

  const updateMessage = db.prepare(
    'UPDATE ai_messages SET content = ? WHERE id = ? AND tenant_id = ? AND content LIKE ?'
  );
  for (const pointer of analysis.pointers) {
    const result = updateMessage.run(pointer.body, pointer.messageId, pointer.tenantId, `${POINTER_PREFIX}%`);
    if (result.changes !== 1) throw new Error(`message changed during migration: ${pointer.messageId}`);
    counts.restoredMessages += 1;
  }
  failPoint();

  const detailRows = analysis.detailEntities;
  const privateObservationRows = analysis.privateObservations;
  const privateRelationRows = analysis.privateRelations;
  const sharedRows = analysis.sharedMessages.map((row) => ({ id: row.sharedMemoryId, tenantId: row.tenantId }));
  const allSharedRows = [
    ...detailRows,
    ...privateObservationRows,
    ...privateRelationRows,
    ...sharedRows,
  ];
  counts.graphLookupRowsDeleted += deleteScopedIndexRows(
    db, 'graph_lookup_keys', 'tenant_id', 'memory_id', allSharedRows
  );
  counts.identityLinkRowsDeleted += deleteScopedIndexRows(
    db, 'entity_lookup_identity_links', 'tenant_id', 'memory_id', allSharedRows
  );
  counts.contextFacetRowsDeleted += deleteScopedIndexRows(
    db, 'entity_context_facets', 'tenant_id', 'source_row_id', allSharedRows
  );
  failPoint();

  if (tableExists(db, analysis.vectorStorage.indexTable)) {
    const deleteVec = tableExists(db, analysis.vectorStorage.vectorTable)
      ? db.prepare(`DELETE FROM ${analysis.vectorStorage.vectorTable} WHERE rowid = ?`)
      : null;
    const deleteIndex = db.prepare(
      `DELETE FROM ${analysis.vectorStorage.indexTable} WHERE memory_id = ? AND tenant_id = ?`
    );
    const seenVec = new Set();
    for (const row of analysis.vectors) {
      if (row.vector_rowid != null && !seenVec.has(row.vector_rowid)) {
        if (!deleteVec) throw new Error(`vec0 table disappeared: ${analysis.vectorStorage.vectorTable}`);
        const result = deleteVec.run(row.vector_rowid);
        if (result.changes !== 1) throw new Error(`vec0 row changed during migration: ${row.vector_rowid}`);
        seenVec.add(row.vector_rowid);
        counts.vec0RowsDeleted += 1;
      }
      const result = deleteIndex.run(row.memory_id, row.tenant_id);
      if (result.changes !== 1) throw new Error(`vector index row changed during migration: ${row.memory_id}`);
      counts.vectorIndexRowsDeleted += 1;
    }
  }
  failPoint();

  const deleteShared = db.prepare('DELETE FROM shared_memory WHERE id = ? AND tenant_id = ?');
  for (const row of detailRows) {
    const result = deleteShared.run(row.id, row.tenantId);
    if (result.changes !== 1) throw new Error(`detail entity changed during migration: ${row.id}`);
    counts.detailEntitiesDeleted += 1;
  }
  for (const row of privateObservationRows) {
    const result = deleteShared.run(row.id, row.tenantId);
    if (result.changes !== 1) throw new Error(`private observation changed during migration: ${row.id}`);
    counts.privateObservationsDeleted += 1;
  }
  for (const row of privateRelationRows) {
    const result = deleteShared.run(row.id, row.tenantId);
    if (result.changes !== 1) throw new Error(`private relation changed during migration: ${row.id}`);
    counts.privateRelationsDeleted += 1;
  }
  for (const row of sharedRows) {
    const result = deleteShared.run(row.id, row.tenantId);
    if (result.changes !== 1) throw new Error(`shared message changed during migration: ${row.id}`);
    counts.sharedMessagesDeleted += 1;
  }
  failPoint();

  for (const pointer of analysis.pointers) {
    const restored = db.prepare(
      'SELECT content FROM ai_messages WHERE id = ? AND tenant_id = ?'
    ).get(pointer.messageId, pointer.tenantId);
    if (!restored || hash(restored.content) !== pointer.bodyHash) {
      throw new Error(`restored message verification failed: ${pointer.messageId}`);
    }
  }
  for (const row of allSharedRows) {
    if (db.prepare('SELECT 1 FROM shared_memory WHERE id = ? AND tenant_id = ?').get(row.id, row.tenantId)) {
      throw new Error(`shared residue verification failed: ${row.id}`);
    }
  }
  for (const row of analysis.vectors) {
    if (db.prepare(`SELECT 1 FROM ${analysis.vectorStorage.indexTable} WHERE memory_id = ? AND tenant_id = ?`)
      .get(row.memory_id, row.tenant_id)) {
      throw new Error(`vector residue verification failed: ${row.memory_id}`);
    }
  }
  failPoint();
  return counts;
}

export async function runPrivateMessageResidueMigration(options) {
  const dbPath = resolve(options.dbPath);
  const execute = options.execute === true;
  let reportPath;
  let backupPath;
  if (execute) {
    if (!options.confirm) throw new Error('--confirm is required with --execute');
    if (!options.backupPath) throw new Error('--backup is required with --execute');
    if (!options.reportPath) throw new Error('--report is required with --execute');
    const requestedBackup = resolve(options.backupPath);
    const requestedReport = resolve(options.reportPath);
    validateArtifactPaths(dbPath, requestedBackup, requestedReport);
    const canonicalDatabasePath = realpathSync(dbPath);
    if (canonicalDatabasePath !== dbPath) {
      validateArtifactPaths(canonicalDatabasePath, requestedBackup, requestedReport);
    }
    backupPath = validateNewOutputPath(requestedBackup, 'backup');
    reportPath = ensureNewOutputPath(requestedReport, 'report');
  } else if (options.reportPath) {
    const requestedReport = resolve(options.reportPath);
    validateReportPath(dbPath, requestedReport);
    const canonicalDatabasePath = realpathSync(dbPath);
    if (canonicalDatabasePath !== dbPath) validateReportPath(canonicalDatabasePath, requestedReport);
    reportPath = ensureNewOutputPath(requestedReport, 'report');
  }
  const startedAt = new Date().toISOString();
  const reportFileOwnership = reportOwnership(reportPath);
  let db;
  let sourceIdentity;
  let analysis;
  let report;
  try {
    db = new Database(dbPath, { readonly: !execute, fileMustExist: true });
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    sourceIdentity = pathIdentity(databasePathFromConnection(db));
    analysis = analyzePrivateMessageResidue(db);
    report = {
      migration: '007-private-message-residue',
      mode: execute ? 'execute' : 'dry-run',
      database: dbPath,
      startedAt,
      ...publicAnalysis(analysis),
      status: execute ? 'pending' : (analysis.ready ? 'ready' : 'refused'),
    };
    if (!execute) {
      report.completedAt = new Date().toISOString();
      writeReport(reportPath, report, reportFileOwnership);
      return report;
    }
    if (!analysis.ready) {
      report.status = 'refused';
      report.completedAt = new Date().toISOString();
      writeReport(reportPath, report, reportFileOwnership);
      return report;
    }
    if (options.confirm !== analysis.confirmationToken) {
      report.status = 'refused';
      report.issues = [...report.issues, issue('confirmation_token_mismatch')];
      report.completedAt = new Date().toISOString();
      writeReport(reportPath, report, reportFileOwnership);
      return report;
    }

    // Persist the reviewed preflight before the transaction. Every later
    // update is bound to this reserved report inode and prior content hash, so
    // an independently replaced path is never overwritten.
    if (typeof options.beforePendingReportWrite === 'function') options.beforePendingReportWrite();
    writeReport(reportPath, report, reportFileOwnership);
    let backupTemporaryPath = null;
    let backupTemporaryIdentity = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedAnalysis = analyzePrivateMessageResidue(db);
      if (!lockedAnalysis.ready || lockedAnalysis.fingerprint !== analysis.fingerprint) {
        throw new Error('database changed after preflight; confirmation token is stale');
      }
      const lockedSourceIdentity = pathIdentity(dbPath);
      if (!sameFileObject(lockedSourceIdentity, sourceIdentity)
          || lockedSourceIdentity.realpath !== sourceIdentity.realpath) {
        throw new Error('database path no longer names the locked source database');
      }
      const lockedLogical = logicalDatabaseSnapshot(db);

      // better-sqlite3 intentionally makes backup() a no-op on a connection
      // that already owns a write transaction. Hold the IMMEDIATE lock here,
      // but take the backup through a second read-only connection. This keeps
      // the backup and all following mutations on one stable logical snapshot.
      backupTemporaryPath = uniqueSiblingPath(backupPath);
      const placeholder = openSync(backupTemporaryPath, 'wx', 0o600);
      closeSync(placeholder);
      backupTemporaryIdentity = pathIdentity(backupTemporaryPath);
      const backupSource = new Database(sourceIdentity.realpath, { readonly: true, fileMustExist: true });
      try {
        const backupSourceIdentity = pathIdentity(databasePathFromConnection(backupSource));
        if (!sameFileObject(backupSourceIdentity, sourceIdentity)) {
          throw new Error('backup source does not match the locked database object');
        }
        await backupSource.backup(backupTemporaryPath);
      } finally {
        backupSource.close();
      }
      chmodSync(backupTemporaryPath, 0o600);
      if (!sameFileObject(pathIdentity(backupTemporaryPath), backupTemporaryIdentity)
          || !sameFileObject(pathIdentity(dbPath), sourceIdentity)) {
        throw new Error('database or temporary backup path changed during backup');
      }

      const backupDb = new Database(backupTemporaryPath, { readonly: true, fileMustExist: true });
      let backupChecks;
      let backupAnalysis;
      let backupLogical;
      try {
        backupDb.pragma('foreign_keys = ON');
        loadVecExtensionIfNeeded(backupDb, lockedAnalysis.vectorStorage.vectorTable);
        backupChecks = databaseChecks(backupDb);
        backupAnalysis = analyzePrivateMessageResidue(backupDb);
        backupLogical = logicalDatabaseSnapshot(backupDb);
      } finally {
        backupDb.close();
      }
      if (backupChecks.quickCheck !== 'ok' || backupChecks.integrityCheck !== 'ok'
          || backupChecks.foreignKeyViolations !== 0
          || backupAnalysis.fingerprint !== lockedAnalysis.fingerprint
          || backupLogical.digest !== lockedLogical.digest) {
        throw new Error('backup integrity or full logical snapshot does not match locked preflight');
      }
      fsyncFileAndParent(backupTemporaryPath);
      const backupSha256 = await fileHash(backupTemporaryPath);
      const backupBytes = statSync(backupTemporaryPath).size;
      if (options.failAfterBackupVerification) {
        throw new Error('injected failure after migration backup verification');
      }
      if (typeof options.beforeBackupPromotion === 'function') options.beforeBackupPromotion();
      publishNoClobber(backupTemporaryPath, backupPath);
      backupTemporaryPath = null;
      const backupIdentity = pathIdentity(backupPath);
      if (!sameFileObject(backupIdentity, backupTemporaryIdentity)
          || !await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        throw new Error('verified backup changed during no-clobber publication');
      }
      if (typeof options.afterBackupPromotion === 'function') options.afterBackupPromotion();
      if (!await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        throw new Error('verified backup is missing or changed before migration mutation');
      }
      report.backup = {
        path: backupPath,
        bytes: backupBytes,
        sha256: backupSha256,
        pathIdentity: backupIdentity,
        checks: backupChecks,
        fingerprint: backupAnalysis.fingerprint,
        logicalDigest: backupLogical.digest,
      };

      const counts = applyAnalysis(db, lockedAnalysis, { failAfterStep: options.failAfterStep });
      const postCheck = db.pragma('quick_check', { simple: true });
      if (postCheck !== 'ok') throw new Error(`post-migration quick_check failed: ${postCheck}`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
          run_id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL,
          preflight_fingerprint TEXT NOT NULL,
          backup_path TEXT NOT NULL,
          backup_sha256 TEXT NOT NULL,
          backup_bytes INTEGER NOT NULL,
          backup_identity_json TEXT NOT NULL,
          report_path TEXT NOT NULL,
          counts_json TEXT NOT NULL
        )
      `);
      const auditColumns = tableColumns(db, AUDIT_TABLE);
      for (const [column, declaration] of [
        ['backup_sha256', 'TEXT'],
        ['backup_bytes', 'INTEGER'],
        ['backup_identity_json', 'TEXT'],
      ]) {
        if (!auditColumns.has(column)) db.exec(`ALTER TABLE ${AUDIT_TABLE} ADD COLUMN ${column} ${declaration}`);
      }
      const runId = hash(`${analysis.fingerprint}\n${startedAt}\n${reportPath}`).slice(0, 32);
      db.prepare(`
        INSERT INTO ${AUDIT_TABLE}
          (run_id, applied_at, preflight_fingerprint, backup_path, backup_sha256,
           backup_bytes, backup_identity_json, report_path, counts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        new Date().toISOString(),
        analysis.fingerprint,
        backupPath,
        backupSha256,
        backupBytes,
        JSON.stringify(backupIdentity),
        reportPath,
        JSON.stringify(counts)
      );
      if (typeof options.beforeCommit === 'function') options.beforeCommit();
      if (!await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        throw new Error('verified backup is missing or changed before commit');
      }
      writeReport(reportPath, report, reportFileOwnership);
      db.exec('COMMIT');
      report.runId = runId;
      report.quickCheck = postCheck;
      if (typeof options.afterCommit === 'function') options.afterCommit();
      if (!await verifyArtifact(backupPath, backupIdentity, backupSha256, backupBytes)) {
        markCommittedBackupVerificationFailure(report, counts);
      } else {
        report.status = 'applied';
        report.applied = counts;
      }
    } catch (error) {
      if (backupTemporaryPath && backupTemporaryIdentity) {
        unlinkIfSameObject(backupTemporaryPath, backupTemporaryIdentity);
      }
      if (db.inTransaction) db.exec('ROLLBACK');
      const afterRollback = analyzePrivateMessageResidue(db);
      report.status = 'rolled-back';
      report.rolledBack = afterRollback.fingerprint === analysis.fingerprint;
      report.error = error.message;
      report.completedAt = new Date().toISOString();
      writeReport(reportPath, report, reportFileOwnership);
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
      writeReport(reportPath, report, reportFileOwnership);
      if (report.status === 'applied'
          && !await verifyArtifact(
            report.backup.path,
            report.backup.pathIdentity,
            report.backup.sha256,
            report.backup.bytes
          )) {
        markCommittedBackupVerificationFailure(report, report.applied);
        writeReport(reportPath, report, reportFileOwnership);
      }
    } catch (error) {
      report.reportWriteError = error.message;
      if (report.status === 'applied') report.status = 'applied-report-write-failed';
    }
    return report;
  } catch (error) {
    if (db?.inTransaction) db.exec('ROLLBACK');
    const failureReport = report || {
      migration: '007-private-message-residue',
      mode: execute ? 'execute' : 'dry-run',
      database: dbPath,
      startedAt,
      ready: false,
      issues: [],
    };
    failureReport.status = 'aborted';
    failureReport.error = error.message;
    failureReport.completedAt = new Date().toISOString();
    writeReport(reportPath, failureReport, reportFileOwnership);
    return failureReport;
  } finally {
    closeReportOwnership(reportFileOwnership);
    if (db) db.close();
  }
}

function parseArgs(argv) {
  const options = { execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!options.dbPath && !arg.startsWith('--')) options.dbPath = arg;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--confirm') options.confirm = argv[++i];
    else if (arg === '--backup') options.backupPath = argv[++i];
    else if (arg === '--report') options.reportPath = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!options.dbPath) {
    throw new Error('usage: node 007-private-message-residue.mjs <db-path> [--report <new-path>] [--execute --confirm <token> --backup <new-path> --report <new-path>]');
  }
  return options;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const report = await runPrivateMessageResidueMigration(parseArgs(process.argv.slice(2)));
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
