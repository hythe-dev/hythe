import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
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
import { createHash } from 'node:crypto';
import {
  inventoryPrivateMessageResidue,
  planPrivateMessageResidueAdjudication,
  runPrivateMessageResidueAdjudication,
} from './private-message-residue-adjudication.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function testCanonical(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) };
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (Array.isArray(value)) return value.map(testCanonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, testCanonical(value[key])]));
}

function testHash(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(testCanonical(value));
  return createHash('sha256').update(serialized).digest('hex');
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hythe-residue-adjudication-'));
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
      created_by TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE graph_lookup_keys (tenant_id TEXT NOT NULL, memory_id TEXT NOT NULL);
    CREATE TABLE entity_lookup_identity_links (tenant_id TEXT NOT NULL, memory_id TEXT NOT NULL);
    CREATE TABLE entity_context_facets (tenant_id TEXT NOT NULL, source_row_id TEXT NOT NULL);
    CREATE TABLE neural_vec_index (
      memory_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      vector_rowid INTEGER
    );
    CREATE TABLE shared_memory_vec (embedding TEXT);
  `);
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES (?, ?, 'entity', ?, ?)
  `).run('public-entity', 'tenant-a', JSON.stringify({
    name: 'public-entity', type: 'project', observations: [],
  }), 'public-agent');
  const secretBody = 'PRIVATE-ADJUDICATION-BODY '.repeat(180);
  const orphan = JSON.stringify({
    entityName: 'lost-private-parent',
    contents: [secretBody],
    metadata: { source: 'create_entities_inline' },
  });
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('orphan-observation', 'tenant-a', 'observation', ?, 'sender-a')
  `).run(orphan);
  db.prepare("INSERT INTO graph_lookup_keys VALUES ('tenant-a', 'orphan-observation')").run();
  db.prepare("INSERT INTO entity_lookup_identity_links VALUES ('tenant-a', 'orphan-observation')").run();
  db.prepare("INSERT INTO entity_context_facets VALUES ('tenant-a', 'orphan-observation')").run();
  db.prepare("INSERT INTO shared_memory_vec (rowid, embedding) VALUES (41, '[4,1]')").run();
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES ('orphan-observation', 'tenant-a', 'observation', ?, 41)
  `).run(orphan);
  const vectorOnly = JSON.stringify({
    entityName: 'lost-vector-parent',
    contents: ['PRIVATE-VECTOR-ONLY-BODY'],
    metadata: { source: 'add_observations' },
  });
  db.prepare("INSERT INTO shared_memory_vec (rowid, embedding) VALUES (42, '[4,2]')").run();
  db.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES ('vector-only', 'tenant-a', 'observation', ?, 42)
  `).run(vectorOnly);
  db.close();
  return { directory, dbPath, secretBody };
}

function inventoryFor(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const inventory = inventoryPrivateMessageResidue(db);
  db.close();
  return inventory;
}

function completeQuarantineManifest(inventory) {
  return {
    schemaVersion: inventory.schemaVersion,
    inventoryFingerprint: inventory.inventoryFingerprint,
    approval: {
      reviewer: 'data-owner@example.test',
      rationale: 'Reviewed each hash-bound residue candidate for protected quarantine.',
      approvedAt: '2026-08-14T00:00:00.000Z',
      reference: 'approval://hythe/test-review-001',
      signatureHash: 'a'.repeat(64),
    },
    decisions: inventory.findings.map((finding) => ({
      findingId: finding.findingId,
      locator: finding.locator,
      rowHash: finding.rowHash,
      contentHash: finding.contentHash,
      evidenceHash: finding.evidenceHash,
      disposition: finding.locator.table === 'shared_memory'
        ? 'quarantine'
        : 'stale_vector_remove',
    })),
  };
}

const BACKING_OBSERVATION_DISPOSITION = 'quarantine_backing_observation';

function findingFor(inventory, issueCode, id) {
  const finding = inventory.findings.find(({ issue, locator }) =>
    issue.code === issueCode && locator.id === id);
  assert.ok(finding, `missing ${issueCode} finding for ${id}`);
  return finding;
}

function decisionFor(manifest, finding) {
  const decision = manifest.decisions.find(({ findingId }) => findingId === finding.findingId);
  assert.ok(decision, `missing manifest decision for ${finding.findingId}`);
  return decision;
}

function targetFor(descriptor) {
  return {
    table: descriptor.locator.table,
    tenantId: descriptor.locator.tenantId,
    id: descriptor.locator.id,
    rowHash: descriptor.rowHash,
    contentHash: descriptor.contentHash,
  };
}

function backingObservationFor(finding) {
  const matches = finding.vectorOwnership?.backingRows?.filter(({ locator }) =>
    locator.table === 'shared_memory') || [];
  assert.equal(matches.length, 1, `expected one shared_memory backing row for ${finding.findingId}`);
  return matches[0];
}

function quarantineBackingObservation(manifest, finding, target = null) {
  const decision = decisionFor(manifest, finding);
  decision.disposition = BACKING_OBSERVATION_DISPOSITION;
  decision.target = target || targetFor(backingObservationFor(finding));
  return decision;
}

function assertBackingPolicyRejection(plan, expectedCode) {
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code }) => code === expectedCode), JSON.stringify(plan.errors));
  assert.equal(plan.errors.some(({ code }) => code === 'invalid_disposition'), false,
    JSON.stringify(plan.errors));
  assert.equal(plan.errors.some(({ code }) => code === 'disposition_not_supported_for_finding'), false,
    JSON.stringify(plan.errors));
}

function rebindInventoryFingerprint(inventory) {
  inventory.contentFingerprint = testHash({
    schemaVersion: inventory.schemaVersion,
    sourceMigration: inventory.sourceMigration,
    sourceFingerprint: inventory.sourceFingerprint,
    vectorStorage: inventory.vectorStorage,
    logicalDatabase: inventory.database.logical,
    findings: inventory.findings,
  });
  inventory.inventoryFingerprint = testHash({
    contentFingerprint: inventory.contentFingerprint,
    pathIdentity: inventory.database.pathIdentity,
  });
}

function actionFor(plan, disposition, table, id) {
  const matches = plan.actions.filter((action) =>
    action.disposition === disposition
    && action.source?.table === table
    && action.source?.id === id);
  assert.equal(matches.length, 1, JSON.stringify(plan.actions));
  return matches[0];
}

test('inventory is read-only, hash-bound, and body-free', async () => {
  const fixture = makeFixture();
  const before = statSync(fixture.dbPath).size;
  const reportPath = join(fixture.directory, 'inventory.json');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    reportPath,
  });
  assert.equal(report.mode, 'inventory');
  assert.equal(report.status, 'inventoried');
  assert.equal(report.counts.findings, 3);
  assert.deepEqual(report.counts.byIssueCode, {
    orphan_private_observation: 1,
    unrepresented_private_vector: 2,
  });
  assert.equal(statSync(fixture.dbPath).size, before);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  const text = readFileSync(reportPath, 'utf8');
  assert.equal(text.includes(fixture.secretBody), false);
  assert.equal(text.includes('PRIVATE-VECTOR-ONLY-BODY'), false);
  for (const finding of report.findings) {
    assert.match(finding.rowHash, /^[a-f0-9]{64}$/);
    assert.match(finding.contentHash, /^[a-f0-9]{64}$/);
    assert.match(finding.evidenceHash, /^[a-f0-9]{64}$/);
  }
});

test('plan rejects missing, extra, duplicate, and stale decisions', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath, { readonly: true });
  const inventory = inventoryPrivateMessageResidue(db);
  const manifest = completeQuarantineManifest(inventory);

  const missing = structuredClone(manifest);
  missing.decisions.pop();
  assert.ok(planPrivateMessageResidueAdjudication(db, inventory, missing).errors
    .some(({ code }) => code === 'missing_decision'));

  const extra = structuredClone(manifest);
  extra.decisions.push({ ...extra.decisions[0], findingId: 'PMRA-NOT-IN-INVENTORY' });
  assert.ok(planPrivateMessageResidueAdjudication(db, inventory, extra).errors
    .some(({ code }) => code === 'extra_decision'));

  const duplicate = structuredClone(manifest);
  duplicate.decisions.push(structuredClone(duplicate.decisions[0]));
  assert.ok(planPrivateMessageResidueAdjudication(db, inventory, duplicate).errors
    .some(({ code }) => code === 'duplicate_decision'));

  const stale = structuredClone(manifest);
  stale.decisions[0].rowHash = '0'.repeat(64);
  assert.ok(planPrivateMessageResidueAdjudication(db, inventory, stale).errors
    .some(({ code }) => code === 'stale_or_incomplete_evidence'));
  db.close();
});

test('plan requires hash-bound data-owner approval metadata', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath, { readonly: true });
  const inventory = inventoryPrivateMessageResidue(db);
  const missing = completeQuarantineManifest(inventory);
  delete missing.approval;
  const missingPlan = planPrivateMessageResidueAdjudication(db, inventory, missing);
  assert.equal(missingPlan.ready, false);
  assert.ok(missingPlan.errors.some(({ code }) => code === 'invalid_object'));

  const malformed = completeQuarantineManifest(inventory);
  malformed.approval.signatureHash = 'not-a-sha256';
  const malformedPlan = planPrivateMessageResidueAdjudication(db, inventory, malformed);
  assert.equal(malformedPlan.ready, false);
  assert.ok(malformedPlan.errors.some(({ code }) => code === 'invalid_approval_signature_hash'));
  db.close();
});

test('confirmation token is bound to the canonical database object, not reusable on a copy', () => {
  const fixture = makeFixture();
  const originalInventory = inventoryFor(fixture.dbPath);
  const originalDb = new Database(fixture.dbPath, { readonly: true });
  const originalPlan = planPrivateMessageResidueAdjudication(
    originalDb,
    originalInventory,
    completeQuarantineManifest(originalInventory)
  );
  originalDb.close();

  const copyPath = join(fixture.directory, 'copy.db');
  copyFileSync(fixture.dbPath, copyPath);
  const copyInventory = inventoryFor(copyPath);
  const copyDb = new Database(copyPath, { readonly: true });
  const copyPlan = planPrivateMessageResidueAdjudication(
    copyDb,
    copyInventory,
    completeQuarantineManifest(copyInventory)
  );
  const replay = planPrivateMessageResidueAdjudication(
    copyDb,
    copyInventory,
    completeQuarantineManifest(originalInventory)
  );
  copyDb.close();
  assert.notEqual(copyInventory.database.pathIdentity.inode, originalInventory.database.pathIdentity.inode);
  assert.notEqual(copyPlan.confirmationToken, originalPlan.confirmationToken);
  assert.equal(replay.ready, false);
  assert.ok(replay.errors.some(({ code }) => code === 'inventory_fingerprint_mismatch'));
});

test('logical evidence binds implicit rowid to payload for non-finding vector rows', () => {
  const fixture = makeFixture();
  const setup = new Database(fixture.dbPath);
  setup.exec(`
    INSERT INTO shared_memory_vec (rowid, embedding) VALUES (91, '[9,1]'), (92, '[9,2]');
  `);
  setup.close();
  const before = inventoryFor(fixture.dbPath);

  const swap = new Database(fixture.dbPath);
  swap.exec(`
    UPDATE shared_memory_vec
    SET embedding = CASE rowid WHEN 91 THEN '[9,2]' WHEN 92 THEN '[9,1]' END
    WHERE rowid IN (91, 92);
  `);
  swap.close();
  const after = inventoryFor(fixture.dbPath);

  assert.deepEqual(after.counts, before.counts, 'the swapped rows are outside the adjudication findings');
  assert.notEqual(after.database.logical.digest, before.database.logical.digest);
  assert.notEqual(after.contentFingerprint, before.contentFingerprint);
});

test('plan refuses a vec0 deletion while an unscheduled public vector still owns the row', () => {
  const fixture = makeFixture();
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    SELECT id, tenant_id, memory_type, content, 42 FROM shared_memory WHERE id = 'public-entity'
  `).run();
  setup.close();
  const db = new Database(fixture.dbPath, { readonly: true });
  const inventory = inventoryPrivateMessageResidue(db);
  const plan = planPrivateMessageResidueAdjudication(
    db,
    inventory,
    completeQuarantineManifest(inventory)
  );
  db.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code }) => code === 'vec0_row_has_unscheduled_owner'));
});

test('quarantine_backing_observation merges with source quarantine and removes its vector', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  const sourceFinding = findingFor(
    inventory,
    'orphan_private_observation',
    'orphan-observation'
  );
  const backing = backingObservationFor(vectorFinding);
  assert.equal(backing.memoryType, 'observation');
  assert.equal(backing.locator.tenantId, vectorFinding.locator.tenantId);
  assert.equal(backing.locator.id, vectorFinding.locator.id);
  assert.equal(backing.contentHash, vectorFinding.contentHash);

  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.ok(vectorFinding.supportedDispositions.includes(BACKING_OBSERVATION_DISPOSITION));
  assert.equal(plan.ready, true, JSON.stringify(plan.errors));
  assert.equal(plan.counts.byDisposition[BACKING_OBSERVATION_DISPOSITION], 1);
  const sourceAction = actionFor(plan, 'quarantine', 'shared_memory', 'orphan-observation');
  assert.deepEqual(sourceAction.authorizingDispositions, [
    'quarantine',
    BACKING_OBSERVATION_DISPOSITION,
  ]);
  assert.deepEqual(sourceAction.findingIds, [sourceFinding.findingId, vectorFinding.findingId]);
  const vectorAction = actionFor(
    plan,
    'stale_vector_remove',
    'neural_vec_index',
    'orphan-observation'
  );
  assert.deepEqual(vectorAction.authorizingDispositions, [BACKING_OBSERVATION_DISPOSITION]);
  assert.deepEqual(vectorAction.findingIds, [vectorFinding.findingId]);

  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath: join(fixture.directory, 'backing-observation-backup.db'),
    reportPath: join(fixture.directory, 'backing-observation-report.json'),
  });
  assert.equal(report.status, 'applied', JSON.stringify(report));
  assert.equal(report.applied.quarantinedRows, 1);
  assert.equal(report.applied.sharedRowsDeleted, 1);
  assert.equal(report.applied.vectorIndexRowsDeleted, 2);
  assert.equal(report.applied.vec0RowsDeleted, 2);

  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM shared_memory
    WHERE tenant_id = 'tenant-a' AND id = 'orphan-observation'
  `).get().count, 0);
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM neural_vec_index
    WHERE tenant_id = 'tenant-a' AND memory_id = 'orphan-observation'
  `).get().count, 0);
  const quarantine = after.prepare(`
    SELECT finding_ids_json, disposition
    FROM private_message_residue_quarantine
    WHERE tenant_id = 'tenant-a' AND row_id = 'orphan-observation'
  `).get();
  assert.equal(quarantine.disposition, 'quarantine');
  assert.deepEqual(
    JSON.parse(quarantine.finding_ids_json).sort(),
    [sourceFinding.findingId, vectorFinding.findingId].sort()
  );
  after.close();
});

test('quarantine_backing_observation handles the production-shaped ambiguous public-parent case', async () => {
  const fixture = makeFixture();
  const secretBody = 'PRODUCTION-229-PRIVATE-OBSERVATION-BODY '.repeat(120);
  const observationContent = JSON.stringify({
    entityName: 'Ambiguous Public Parent',
    contents: [secretBody],
    metadata: { source: 'add_observations' },
  });
  const setup = new Database(fixture.dbPath);
  setup.exec(`
    DELETE FROM graph_lookup_keys WHERE memory_id = 'orphan-observation';
    DELETE FROM entity_lookup_identity_links WHERE memory_id = 'orphan-observation';
    DELETE FROM entity_context_facets WHERE source_row_id = 'orphan-observation';
    DELETE FROM neural_vec_index;
    DELETE FROM shared_memory_vec;
    DELETE FROM shared_memory WHERE id = 'orphan-observation';
  `);
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('public-parent-one', 'tenant-a', 'entity', ?, 'public-agent')
  `).run(JSON.stringify({
    name: 'Ambiguous Public Parent',
    type: 'project',
    observations: [],
  }));
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('public-parent-two', 'tenant-a', 'entity', ?, 'public-agent')
  `).run(JSON.stringify({
    name: 'Ambiguous Public Parent LLC',
    type: 'project',
    observations: [],
  }));
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('production-229-observation', 'tenant-a', 'observation', ?, 'sender-a')
  `).run(observationContent);
  setup.exec(`
    INSERT INTO graph_lookup_keys VALUES ('tenant-a', 'production-229-observation');
    INSERT INTO entity_lookup_identity_links VALUES ('tenant-a', 'production-229-observation');
    INSERT INTO entity_context_facets VALUES ('tenant-a', 'production-229-observation');
    INSERT INTO shared_memory_vec (rowid, embedding) VALUES (229, '[2,2,9]');
  `);
  setup.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES ('production-229-observation', 'tenant-a', 'observation', ?, 229)
  `).run(observationContent);
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  assert.equal(inventory.counts.findings, 1);
  assert.deepEqual(inventory.counts.byIssueCode, { unrepresented_private_vector: 1 });
  assert.equal(inventory.findings.some(({ locator }) =>
    locator.table === 'shared_memory' && locator.id === 'production-229-observation'), false);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'production-229-observation'
  );
  const backing = backingObservationFor(vectorFinding);
  assert.equal(backing.memoryType, 'observation');
  assert.equal(backing.contentHash, vectorFinding.contentHash);
  assert.deepEqual(
    backing.ancillaryRows.map(({ table }) => table).sort(),
    ['entity_context_facets', 'entity_lookup_identity_links', 'graph_lookup_keys']
  );
  assert.ok(backing.ancillaryRows.every(({ rows }) => rows.length === 1));

  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.equal(plan.ready, true, JSON.stringify(plan.errors));
  const sourceAction = actionFor(
    plan,
    'quarantine',
    'shared_memory',
    'production-229-observation'
  );
  assert.deepEqual(sourceAction.authorizingDispositions, [BACKING_OBSERVATION_DISPOSITION]);
  assert.deepEqual(sourceAction.findingIds, [vectorFinding.findingId]);
  const vectorAction = actionFor(
    plan,
    'stale_vector_remove',
    'neural_vec_index',
    'production-229-observation'
  );
  assert.deepEqual(vectorAction.authorizingDispositions, [BACKING_OBSERVATION_DISPOSITION]);
  assert.deepEqual(vectorAction.findingIds, [vectorFinding.findingId]);

  const reportPath = join(fixture.directory, 'production-229-report.json');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath: join(fixture.directory, 'production-229-backup.db'),
    reportPath,
  });
  assert.equal(report.status, 'applied', JSON.stringify(report));
  assert.equal(report.applied.quarantinedRows, 1);
  assert.equal(report.applied.sharedRowsDeleted, 1);
  assert.equal(report.applied.vectorIndexRowsDeleted, 1);
  assert.equal(report.applied.vec0RowsDeleted, 1);
  assert.equal(report.applied.graphLookupRowsDeleted, 1);
  assert.equal(report.applied.identityLinkRowsDeleted, 1);
  assert.equal(report.applied.contextFacetRowsDeleted, 1);
  assert.equal(JSON.stringify(report).includes(secretBody), false);
  assert.equal(readFileSync(reportPath, 'utf8').includes(secretBody), false);

  const after = new Database(fixture.dbPath, { readonly: true });
  const quarantine = after.prepare(`
    SELECT finding_ids_json, row_json
    FROM private_message_residue_quarantine
    WHERE tenant_id = 'tenant-a' AND row_id = 'production-229-observation'
  `).all();
  assert.equal(quarantine.length, 1);
  assert.deepEqual(JSON.parse(quarantine[0].finding_ids_json), [vectorFinding.findingId]);
  assert.ok(quarantine[0].row_json.includes(secretBody));
  for (const [table, column] of [
    ['graph_lookup_keys', 'memory_id'],
    ['entity_lookup_identity_links', 'memory_id'],
    ['entity_context_facets', 'source_row_id'],
  ]) {
    assert.equal(after.prepare(`
      SELECT COUNT(*) AS count FROM ${table}
      WHERE tenant_id = 'tenant-a' AND ${column} = 'production-229-observation'
    `).get().count, 0);
  }
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM neural_vec_index
    WHERE tenant_id = 'tenant-a' AND memory_id = 'production-229-observation'
  `).get().count, 0);
  assert.equal(after.prepare('SELECT COUNT(*) AS count FROM shared_memory_vec WHERE rowid = 229')
    .get().count, 0);
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM shared_memory
    WHERE tenant_id = 'tenant-a' AND id = 'production-229-observation'
  `).get().count, 0);
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM shared_memory
    WHERE tenant_id = 'tenant-a' AND id IN ('public-parent-one', 'public-parent-two')
  `).get().count, 2);
  after.close();
});

test('quarantine merge rejects conflicting composite vector ownership evidence', () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const sourceFinding = findingFor(
    inventory,
    'orphan_private_observation',
    'orphan-observation'
  );
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  assert.deepEqual(sourceFinding.vectorOwnership, vectorFinding.vectorOwnership);
  const backing = backingObservationFor(vectorFinding);
  backing.parentTopology = {
    ...backing.parentTopology,
    tamperedCompositeEvidence: true,
  };
  assert.notDeepEqual(sourceFinding.vectorOwnership, vectorFinding.vectorOwnership);
  vectorFinding.evidenceHash = testHash({
    priorEvidenceHash: vectorFinding.evidenceHash,
    vectorOwnership: vectorFinding.vectorOwnership,
  });
  rebindInventoryFingerprint(inventory);

  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code, findingId }) =>
    code === 'conflicting_source_evidence' && findingId === vectorFinding.findingId),
  JSON.stringify(plan.errors));
  const retainedAction = actionFor(plan, 'quarantine', 'shared_memory', 'orphan-observation');
  assert.deepEqual(retainedAction.authorizingDispositions, ['quarantine']);
  assert.deepEqual(retainedAction.findingIds, [sourceFinding.findingId]);
});

test('quarantine_backing_observation rejects a missing explicit target', () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  const manifest = completeQuarantineManifest(inventory);
  decisionFor(manifest, vectorFinding).disposition = BACKING_OBSERVATION_DISPOSITION;
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'backing_observation_identity_mismatch');
});

test('quarantine_backing_observation rejects unknown target fields before normalization', () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  decisionFor(manifest, vectorFinding).target.unexpected = 'must-not-be-normalized-away';
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code, field }) =>
    code === 'unknown_field' && field === 'decision.target.unexpected'), JSON.stringify(plan.errors));
});

test('stale_vector_remove and quarantine reject unexpected targets', () => {
  for (const disposition of ['stale_vector_remove', 'quarantine']) {
    const fixture = makeFixture();
    const inventory = inventoryFor(fixture.dbPath);
    const vectorFinding = findingFor(
      inventory,
      'unrepresented_private_vector',
      'orphan-observation'
    );
    const sourceFinding = findingFor(
      inventory,
      'orphan_private_observation',
      'orphan-observation'
    );
    const manifest = completeQuarantineManifest(inventory);
    const finding = disposition === 'stale_vector_remove' ? vectorFinding : sourceFinding;
    const decision = decisionFor(manifest, finding);
    assert.equal(decision.disposition, disposition);
    decision.target = targetFor(backingObservationFor(vectorFinding));
    const db = new Database(fixture.dbPath, { readonly: true });
    const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
    db.close();
    assert.equal(plan.ready, false, disposition);
    assert.ok(plan.errors.some(({ code, findingId }) =>
      code === 'unexpected_target' && findingId === finding.findingId), JSON.stringify(plan.errors));
  }
});

test('quarantine_backing_observation rejects ambiguous or multiple backing rows', () => {
  const fixture = makeFixture();
  const setup = new Database(fixture.dbPath);
  setup.exec(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES
      ('orphan-observation', NULL, 'tenant-a', 'sender-a', 'recipient-a', 'same opaque id'),
      ('other-mailbox', 'orphan-observation', 'tenant-a', 'sender-a', 'recipient-a', 'legacy link');
  `);
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  assert.equal(vectorFinding.vectorOwnership.backingRows.length, 3);
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'backing_observation_not_unique');
});

test('quarantine_backing_observation requires exact backing tenant and id parity', () => {
  for (const [field, value] of [
    ['tenantId', 'tenant-b'],
    ['id', 'different-observation'],
  ]) {
    const fixture = makeFixture();
    const inventory = inventoryFor(fixture.dbPath);
    const vectorFinding = findingFor(
      inventory,
      'unrepresented_private_vector',
      'orphan-observation'
    );
    const manifest = completeQuarantineManifest(inventory);
    const target = targetFor(backingObservationFor(vectorFinding));
    target[field] = value;
    quarantineBackingObservation(manifest, vectorFinding, target);
    const db = new Database(fixture.dbPath, { readonly: true });
    const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
    db.close();
    assertBackingPolicyRejection(plan, 'backing_observation_identity_mismatch');
  }
});

test('quarantine_backing_observation requires exact vector and backing content parity', () => {
  const fixture = makeFixture();
  const mismatchedVectorContent = JSON.stringify({
    entityName: 'lost-private-parent',
    contents: ['DIFFERENT-PRIVATE-VECTOR-CONTENT'],
    metadata: { source: 'add_observations' },
  });
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    UPDATE neural_vec_index SET content = ?
    WHERE tenant_id = 'tenant-a' AND memory_id = 'orphan-observation'
  `).run(mismatchedVectorContent);
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  const backing = backingObservationFor(vectorFinding);
  assert.notEqual(backing.contentHash, vectorFinding.contentHash);
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'backing_observation_content_mismatch');
});

test('quarantine_backing_observation requires current hash-bound target evidence', () => {
  for (const field of ['rowHash', 'contentHash']) {
    const fixture = makeFixture();
    const inventory = inventoryFor(fixture.dbPath);
    const vectorFinding = findingFor(
      inventory,
      'unrepresented_private_vector',
      'orphan-observation'
    );
    const manifest = completeQuarantineManifest(inventory);
    const target = targetFor(backingObservationFor(vectorFinding));
    target[field] = '0'.repeat(64);
    quarantineBackingObservation(manifest, vectorFinding, target);
    const db = new Database(fixture.dbPath, { readonly: true });
    const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
    db.close();
    assertBackingPolicyRejection(plan, 'backing_observation_hash_mismatch');
  }
});

test('quarantine_backing_observation refuses a vec0 row with an unscheduled owner', () => {
  const fixture = makeFixture();
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    SELECT id, tenant_id, memory_type, content, 41 FROM shared_memory WHERE id = 'public-entity'
  `).run();
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'vec0_row_has_unscheduled_owner');
});

test('quarantine_backing_observation rejects a non-observation shared-memory backing row', () => {
  const fixture = makeFixture();
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    UPDATE shared_memory SET memory_type = 'entity'
    WHERE tenant_id = 'tenant-a' AND id = 'orphan-observation'
  `).run();
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  assert.equal(backingObservationFor(vectorFinding).memoryType, 'entity');
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'backing_observation_wrong_type');
});

test('quarantine_backing_observation rejects a missing backing row', () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(inventory, 'unrepresented_private_vector', 'vector-only');
  assert.deepEqual(vectorFinding.vectorOwnership.backingRows, []);
  const manifest = completeQuarantineManifest(inventory);
  quarantineBackingObservation(manifest, vectorFinding, {
    table: 'shared_memory',
    tenantId: vectorFinding.locator.tenantId,
    id: vectorFinding.locator.id,
    rowHash: 'b'.repeat(64),
    contentHash: vectorFinding.contentHash,
  });
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'backing_observation_missing');
});

test('quarantine_backing_observation rejects a conflicting source action', () => {
  const fixture = makeFixture();
  const body = 'CONFLICTING-RESTORE-BODY '.repeat(180);
  const content = JSON.stringify({
    name: 'msg-detail-conflict-mail',
    type: 'message_detail',
    observations: [body],
    createdBy: 'sender-a',
  });
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    INSERT INTO ai_messages
      (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES ('conflict-mail', NULL, 'tenant-a', 'sender-a', 'recipient-a', ?)
  `).run(body);
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('conflict-observation', 'tenant-a', 'observation', ?, 'sender-a')
  `).run(content);
  setup.prepare("INSERT INTO shared_memory_vec (rowid, embedding) VALUES (77, '[7,7]')").run();
  setup.prepare(`
    INSERT INTO neural_vec_index (memory_id, tenant_id, memory_type, content, vector_rowid)
    VALUES ('conflict-observation', 'tenant-a', 'observation', ?, 77)
  `).run(content);
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const detailFinding = findingFor(inventory, 'orphan_message_detail', 'conflict-observation');
  const mailbox = detailFinding.parentTopology.bodyMatchMessages.find(({ locator }) =>
    locator.id === 'conflict-mail');
  assert.ok(mailbox);
  const vectorTemplate = findingFor(inventory, 'unrepresented_private_vector', 'vector-only');
  const vectorEvidence = detailFinding.vectorOwnership.index;
  assert.ok(vectorEvidence);
  const vectorFinding = {
    ...structuredClone(vectorTemplate),
    findingId: `PMRA-${testHash({ conflict: vectorEvidence }).slice(0, 24)}`,
    issue: {
      code: 'unrepresented_private_vector',
      memoryType: 'observation',
      reason: 'unresolved_private_shaped_observation',
    },
    locator: vectorEvidence.locator,
    rowHash: vectorEvidence.rowHash,
    contentHash: vectorEvidence.contentHash,
    parentTopology: null,
    vectorOwnership: structuredClone(detailFinding.vectorOwnership),
    ancillaryRows: [],
    evidenceHash: testHash({
      conflict: vectorEvidence,
      backingRows: detailFinding.vectorOwnership.backingRows,
    }),
    supportedDispositions: [
      ...new Set([
        ...vectorTemplate.supportedDispositions,
        BACKING_OBSERVATION_DISPOSITION,
      ]),
    ],
  };
  inventory.findings.push(vectorFinding);
  rebindInventoryFingerprint(inventory);
  const manifest = completeQuarantineManifest(inventory);
  const detailDecision = decisionFor(manifest, detailFinding);
  detailDecision.disposition = 'restore_mailbox';
  detailDecision.target = targetFor(mailbox);
  quarantineBackingObservation(manifest, vectorFinding);
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assertBackingPolicyRejection(plan, 'conflicting_source_dispositions');
});

test('stale_vector_remove remains strict for a live unscheduled backing observation', () => {
  const fixture = makeFixture();
  const safePublicObservation = JSON.stringify({
    entityName: 'public-entity',
    contents: ['public observation'],
    metadata: { entityId: 'public-entity', source: 'add_observations' },
  });
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    UPDATE shared_memory SET content = ?
    WHERE tenant_id = 'tenant-a' AND id = 'orphan-observation'
  `).run(safePublicObservation);
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const vectorFinding = findingFor(
    inventory,
    'unrepresented_private_vector',
    'orphan-observation'
  );
  assert.equal(inventory.findings.some(({ locator }) =>
    locator.table === 'shared_memory' && locator.id === 'orphan-observation'), false);
  assert.equal(backingObservationFor(vectorFinding).memoryType, 'observation');
  const manifest = completeQuarantineManifest(inventory);
  assert.equal(decisionFor(manifest, vectorFinding).disposition, 'stale_vector_remove');
  const db = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code }) =>
    code === 'vector_not_stale_or_source_not_scheduled_for_removal'), JSON.stringify(plan.errors));
});

test('ordinary orphan message-detail quarantine remains valid', async () => {
  const fixture = makeFixture();
  const body = 'QUARANTINED-DETAIL-BODY '.repeat(180);
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('detail-quarantine', 'tenant-a', 'entity', ?, 'sender-a')
  `).run(JSON.stringify({
    name: 'msg-detail-no-mailbox',
    type: 'message_detail',
    observations: [body],
    createdBy: 'sender-a',
  }));
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const detailFinding = findingFor(inventory, 'orphan_message_detail', 'detail-quarantine');
  const manifest = completeQuarantineManifest(inventory);
  assert.equal(decisionFor(manifest, detailFinding).disposition, 'quarantine');
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.equal(plan.ready, true, JSON.stringify(plan.errors));

  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath: join(fixture.directory, 'detail-quarantine-backup.db'),
    reportPath: join(fixture.directory, 'detail-quarantine-report.json'),
  });
  assert.equal(report.status, 'applied', JSON.stringify(report));
  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM private_message_residue_quarantine
    WHERE tenant_id = 'tenant-a' AND row_id = 'detail-quarantine'
  `).get().count, 1);
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM shared_memory
    WHERE tenant_id = 'tenant-a' AND id = 'detail-quarantine'
  `).get().count, 0);
  after.close();
});

test('plan explicitly refuses dispositions that need external adapters', () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath, { readonly: true });
  const inventory = inventoryPrivateMessageResidue(db);
  const manifest = completeQuarantineManifest(inventory);
  manifest.decisions[0].disposition = 'archive_then_remove_private';
  const plan = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code, disposition }) =>
    code === 'manual_adapter_required' && disposition === 'archive_then_remove_private'));
});

test('complete plan is deterministic and does not mutate the source', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const db = new Database(fixture.dbPath, { readonly: true });
  const first = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  const second = planPrivateMessageResidueAdjudication(db, inventory, manifest);
  db.close();
  assert.equal(first.ready, true);
  assert.equal(first.planFingerprint, second.planFingerprint);
  assert.equal(first.confirmationToken, second.confirmationToken);
  assert.match(first.confirmationToken, /^ADJUDICATE-PRIVATE-RESIDUE-[A-F0-9]{20}$/);

  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'plan',
    manifest,
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.plan.planFingerprint, first.planFingerprint);
});

test('execute refuses a wrong token without creating a backup', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const usableToken = planPrivateMessageResidueAdjudication(
    planningDb,
    inventory,
    manifest
  ).confirmationToken;
  planningDb.close();
  const backupPath = join(fixture.directory, 'wrong-token.db');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: 'ADJUDICATE-PRIVATE-RESIDUE-WRONG',
    backupPath,
    reportPath: join(fixture.directory, 'wrong-token.json'),
  });
  assert.equal(report.status, 'refused');
  assert.equal(existsSync(backupPath), false);
  assert.equal(report.plan.confirmationToken, null);
  assert.equal(JSON.stringify(report).includes(usableToken), false);
});

test('a malformed manifest cannot copy its private text into reports', async () => {
  const fixture = makeFixture();
  const secret = 'PRIVATE-MALFORMED-MANIFEST-BODY';
  const manifestPath = join(fixture.directory, 'malformed.json');
  const reportPath = join(fixture.directory, 'malformed-report.json');
  writeFileSync(manifestPath, `${secret} is not JSON`, { mode: 0o600 });
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'plan',
    manifestPath,
    reportPath,
  });
  assert.equal(report.status, 'aborted');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(readFileSync(reportPath, 'utf8').includes(secret), false);
});

test('ancillary index drift stales the reviewed plan before any backup or delete', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();

  const driftDb = new Database(fixture.dbPath);
  driftDb.prepare("INSERT INTO graph_lookup_keys VALUES ('tenant-a', 'orphan-observation')").run();
  driftDb.close();
  const backupPath = join(fixture.directory, 'drift-backup.db');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'drift-report.json'),
  });
  assert.equal(report.status, 'refused');
  assert.equal(existsSync(backupPath), false);
  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare(`
    SELECT COUNT(*) AS count FROM graph_lookup_keys
    WHERE tenant_id = 'tenant-a' AND memory_id = 'orphan-observation'
  `).get().count, 2);
  after.close();
});

test('a failed unverified backup leaves no final or temporary backup artifact', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'must-not-exist.db');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'backup-failure-report.json'),
    failAfterBackupVerification: true,
  });
  assert.equal(report.status, 'aborted');
  assert.equal(report.backupPromoted, false);
  assert.equal(existsSync(backupPath), false);
  assert.equal(readdirSync(fixture.directory).some((name) => name.includes('.unverified-')), false);
  assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
});

test('backup promotion refuses a destination race without overwriting the new file', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'raced-backup.db');
  const marker = 'INDEPENDENT-BACKUP-DESTINATION';
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath,
    reportPath: join(fixture.directory, 'backup-race-report.json'),
    beforeBackupPromotion() {
      writeFileSync(backupPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'rolled-back');
  assert.equal(report.rolledBack, true);
  assert.equal(report.backupPromoted, false);
  assert.equal(readFileSync(backupPath, 'utf8'), marker);
  assert.equal(readdirSync(fixture.directory).some((name) => name.includes('.unverified-')), false);
  assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
});

test('backup replacement immediately before adjudication commit rolls back and is preserved', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'precommit-replaced-backup.db');
  const marker = 'INDEPENDENT-ADJUDICATION-PRECOMMIT-BACKUP';
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
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
  assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
});

test('backup deletion immediately after adjudication commit can never report applied', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'postcommit-deleted-backup.db');
  const reportPath = join(fixture.directory, 'postcommit-deleted-report.json');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
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
  const db = new Database(fixture.dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM private_message_residue_adjudication_audit').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM private_message_residue_quarantine').get().count, 1);
  db.close();
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status,
    'committed-backup-verification-failed');
});

test('execute refuses backup and report paths in the source SQLite sidecar namespace', async () => {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    for (const collision of ['backup', 'report']) {
      const fixture = makeFixture();
      const inventory = inventoryFor(fixture.dbPath);
      const manifest = completeQuarantineManifest(inventory);
      const planningDb = new Database(fixture.dbPath, { readonly: true });
      const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
      planningDb.close();
      const sidecarPath = `${fixture.dbPath}${suffix}`;
      const backupPath = collision === 'backup'
        ? sidecarPath
        : join(fixture.directory, `safe-backup${suffix}.db`);
      const reportPath = collision === 'report'
        ? sidecarPath
        : join(fixture.directory, `safe-report${suffix}.json`);
      await assert.rejects(
        runPrivateMessageResidueAdjudication({
          dbPath: fixture.dbPath,
          mode: 'execute',
          manifest,
          confirm: plan.confirmationToken,
          backupPath,
          reportPath,
        }),
        /collides with the source database or SQLite sidecar namespace/,
        `${collision}:${suffix}`
      );
      assert.equal(existsSync(sidecarPath), false, `${collision}:${suffix}`);
      assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
    }
  }
});

test('symlinked artifact parents cannot bypass adjudication SQLite namespaces', async () => {
  for (const collision of ['backup', 'report']) {
    const fixture = makeFixture();
    const inventory = inventoryFor(fixture.dbPath);
    const manifest = completeQuarantineManifest(inventory);
    const planningDb = new Database(fixture.dbPath, { readonly: true });
    const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
    planningDb.close();
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
      runPrivateMessageResidueAdjudication({
        dbPath: fixture.dbPath,
        mode: 'execute',
        manifest,
        confirm: plan.confirmationToken,
        backupPath,
        reportPath,
      }),
      /path collides with the source database or SQLite sidecar namespace/
    );
    assert.equal(existsSync(sidecarAlias), false);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(reportPath), false);
    assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
  }
});

test('pending report replacement is preserved and aborts before backup or mutation', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'report-race-backup.db');
  const reportPath = join(fixture.directory, 'report-race.json');
  const marker = 'INDEPENDENT-ADJUDICATION-REPORT';
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath,
    reportPath,
    afterPendingReport() {
      unlinkSync(reportPath);
      writeFileSync(reportPath, marker, { flag: 'wx', mode: 0o600 });
    },
  });
  assert.equal(report.status, 'aborted');
  assert.match(report.reportWriteError, /report path ownership changed/);
  assert.equal(readFileSync(reportPath, 'utf8'), marker);
  assert.equal(existsSync(backupPath), false);
  assert.equal(inventoryFor(fixture.dbPath).contentFingerprint, inventory.contentFingerprint);
});

test('backup replacement at final adjudication reporting is preserved and downgrades status', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'final-replaced-backup.db');
  const reportPath = join(fixture.directory, 'final-replaced-backup-report.json');
  const marker = 'INDEPENDENT-ADJUDICATION-FINAL-BACKUP';
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
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
  const db = new Database(fixture.dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM private_message_residue_adjudication_audit').get().count, 1);
  db.close();
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).status,
    'committed-backup-verification-failed');
});

test('execute quarantines source rows, removes uniquely-owned vectors, and becomes 007-ready', async () => {
  const fixture = makeFixture();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  const backupPath = join(fixture.directory, 'backup.db');
  const reportPath = join(fixture.directory, 'execute.json');
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath,
    reportPath,
  });
  assert.equal(report.status, 'applied');
  assert.equal(report.checks.quickCheck, 'ok');
  assert.equal(report.checks.integrityCheck, 'ok');
  assert.equal(report.checks.foreignKeyViolations, 0);
  assert.equal(report.postMigration007.ready, true);
  assert.equal(report.applied.quarantinedRows, 1);
  assert.equal(report.applied.vectorIndexRowsDeleted, 2);
  assert.equal(report.applied.vec0RowsDeleted, 2);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.match(report.backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.backup.bytes, statSync(backupPath).size);
  assert.equal(report.backup.pathIdentity.inode, statSync(backupPath, { bigint: true }).ino.toString());
  assert.equal(readFileSync(reportPath, 'utf8').includes(fixture.secretBody), false);

  const db = new Database(fixture.dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id = 'orphan-observation'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM neural_vec_index').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_memory_vec').get().count, 0);
  const quarantine = db.prepare('SELECT row_json FROM private_message_residue_quarantine').get();
  assert.ok(quarantine.row_json.includes(fixture.secretBody));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM private_message_residue_adjudication_audit').get().count, 1);
  const audit = db.prepare(`
    SELECT approval_hash, approval_json, backup_sha256, backup_bytes, backup_identity_json
    FROM private_message_residue_adjudication_audit
  `).get();
  assert.match(audit.approval_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(audit.approval_json).reviewer, manifest.approval.reviewer);
  assert.equal(audit.backup_sha256, report.backup.sha256);
  assert.equal(audit.backup_bytes, report.backup.bytes);
  assert.equal(JSON.parse(audit.backup_identity_json).inode, report.backup.pathIdentity.inode);
  db.close();

  const backup = new Database(backupPath, { readonly: true });
  assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id = 'orphan-observation'").get().count, 1);
  backup.close();
});

test('an injected execution failure rolls back every database mutation', async () => {
  for (const failAfterStep of [1, 2, 3, 4]) {
    const fixture = makeFixture();
    const inventory = inventoryFor(fixture.dbPath);
    const manifest = completeQuarantineManifest(inventory);
    const planningDb = new Database(fixture.dbPath, { readonly: true });
    const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
    planningDb.close();
    const report = await runPrivateMessageResidueAdjudication({
      dbPath: fixture.dbPath,
      mode: 'execute',
      manifest,
      confirm: plan.confirmationToken,
      backupPath: join(fixture.directory, `rollback-backup-${failAfterStep}.db`),
      reportPath: join(fixture.directory, `rollback-report-${failAfterStep}.json`),
      failAfterStep,
    });
    assert.equal(report.status, 'rolled-back', `step ${failAfterStep}`);
    assert.equal(report.rolledBack, true, `step ${failAfterStep}`);
    const after = inventoryFor(fixture.dbPath);
    assert.equal(after.contentFingerprint, inventory.contentFingerprint, `step ${failAfterStep}`);
    const db = new Database(fixture.dbPath, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'private_message_residue_quarantine'").get().count, 0);
    db.close();
  }
});

test('restore_mailbox refuses unrelated target content and accepts exact body parity', async () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const body = 'RESTORED-PRIVATE-MAILBOX-BODY '.repeat(150);
  db.prepare(`
    INSERT INTO ai_messages (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES ('mail-1', NULL, 'tenant-a', 'sender-a', 'recipient-a', 'truncated historical body')
  `).run();
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('orphan-detail', 'tenant-a', 'entity', ?, 'sender-a')
  `).run(JSON.stringify({
    name: 'msg-detail-mail-1',
    type: 'message_detail',
    observations: [body],
    createdBy: 'sender-a',
  }));
  db.close();
  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const detailFinding = inventory.findings.find(({ issue }) => issue.code === 'orphan_message_detail');
  assert.ok(detailFinding);
  const target = detailFinding.parentTopology.encodedIdMessages[0];
  const decision = manifest.decisions.find(({ findingId }) => findingId === detailFinding.findingId);
  decision.disposition = 'restore_mailbox';
  decision.target = {
    table: target.locator.table,
    tenantId: target.locator.tenantId,
    id: target.locator.id,
    rowHash: target.rowHash,
    contentHash: target.contentHash,
  };
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.equal(plan.ready, false);
  assert.ok(plan.errors.some(({ code }) => code === 'restore_mailbox_content_mismatch'));

  const repairDb = new Database(fixture.dbPath);
  repairDb.prepare("UPDATE ai_messages SET content = ? WHERE id = 'mail-1'").run(body);
  repairDb.close();
  const exactInventory = inventoryFor(fixture.dbPath);
  const exactManifest = completeQuarantineManifest(exactInventory);
  const exactFinding = exactInventory.findings.find(({ issue }) => issue.code === 'orphan_message_detail');
  const exactTarget = exactFinding.parentTopology.bodyMatchMessages[0];
  const exactDecision = exactManifest.decisions.find(({ findingId }) => findingId === exactFinding.findingId);
  exactDecision.disposition = 'restore_mailbox';
  exactDecision.target = {
    table: exactTarget.locator.table,
    tenantId: exactTarget.locator.tenantId,
    id: exactTarget.locator.id,
    rowHash: exactTarget.rowHash,
    contentHash: exactTarget.contentHash,
  };
  const exactPlanningDb = new Database(fixture.dbPath, { readonly: true });
  const exactPlan = planPrivateMessageResidueAdjudication(exactPlanningDb, exactInventory, exactManifest);
  exactPlanningDb.close();
  assert.equal(exactPlan.ready, true);
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest: exactManifest,
    confirm: exactPlan.confirmationToken,
    backupPath: join(fixture.directory, 'restore-backup.db'),
    reportPath: join(fixture.directory, 'restore-report.json'),
  });
  assert.equal(report.status, 'applied');
  assert.equal(report.applied.restoredMailboxes, 1);
  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT content FROM ai_messages WHERE id = 'mail-1'").get().content, body);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id = 'orphan-detail'").get().count, 0);
  after.close();
});

test('restore_mailbox replaces an actual pointer and ignores post-validation manifest mutation', async () => {
  const fixture = makeFixture();
  const body = 'POINTER-RESTORED-PRIVATE-BODY '.repeat(140);
  const pointer = 'Full content stored as entity "msg-detail-mail-pointer".';
  const evilBody = 'unrelated cross-tenant mailbox body';
  const setup = new Database(fixture.dbPath);
  setup.prepare(`
    INSERT INTO ai_messages (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES ('mail-pointer', NULL, 'tenant-a', 'sender-a', 'recipient-a', ?)
  `).run(pointer);
  setup.prepare(`
    INSERT INTO ai_messages (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES ('mail-evil', NULL, 'tenant-b', 'evil-sender', 'evil-recipient', ?)
  `).run(evilBody);
  setup.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('pointer-detail', 'tenant-a', 'message_detail', ?, 'sender-a')
  `).run(JSON.stringify({
    name: 'msg-detail-mail-pointer',
    type: 'message_detail',
    observations: [body],
    createdBy: 'sender-a',
  }));
  const evilRow = setup.prepare("SELECT * FROM ai_messages WHERE id = 'mail-evil'").get();
  setup.close();

  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const detailFindings = inventory.findings.filter(({ locator }) => locator.id === 'pointer-detail');
  assert.ok(detailFindings.length >= 1);
  const target = detailFindings[0].parentTopology.pointerMessages[0];
  for (const finding of detailFindings) {
    const decision = manifest.decisions.find(({ findingId }) => findingId === finding.findingId);
    decision.disposition = 'restore_mailbox';
    decision.target = {
      table: target.locator.table,
      tenantId: target.locator.tenantId,
      id: target.locator.id,
      rowHash: target.rowHash,
      contentHash: target.contentHash,
    };
  }
  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.equal(plan.ready, true, JSON.stringify(plan.errors));

  const execution = runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath: join(fixture.directory, 'pointer-backup.db'),
    reportPath: join(fixture.directory, 'pointer-report.json'),
  });
  setImmediate(() => {
    for (const finding of detailFindings) {
      const decision = manifest.decisions.find(({ findingId }) => findingId === finding.findingId);
      decision.target = {
        table: 'ai_messages',
        tenantId: evilRow.tenant_id,
        id: evilRow.id,
        rowHash: testHash(evilRow),
        contentHash: testHash(evilRow.content),
      };
    }
  });
  const report = await execution;
  assert.equal(report.status, 'applied', JSON.stringify(report));
  assert.equal(report.applied.restoredMailboxes, 1);
  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT content FROM ai_messages WHERE id = 'mail-pointer'").get().content, body);
  assert.equal(after.prepare("SELECT content FROM ai_messages WHERE id = 'mail-evil'").get().content, evilBody);
  after.close();
});

test('private_duplicate requires exact tenant, sender, recipient, and body parity', async () => {
  const fixture = makeFixture();
  const db = new Database(fixture.dbPath);
  const body = 'exact private mailbox payload';
  db.prepare(`
    INSERT INTO ai_messages (id, legacy_shared_memory_id, tenant_id, from_agent, to_agent, content)
    VALUES ('primary-mail', NULL, 'tenant-a', 'sender-a', 'recipient-a', ?)
  `).run(body);
  db.prepare(`
    INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by)
    VALUES ('unlinked-shared-mail', 'tenant-a', 'ai_message', ?, 'sender-a')
  `).run(JSON.stringify({ from: 'sender-a', to: 'recipient-a', content: body }));
  db.close();

  const inventory = inventoryFor(fixture.dbPath);
  const manifest = completeQuarantineManifest(inventory);
  const sharedFinding = inventory.findings.find(({ issue }) => issue.code === 'unrepresented_shared_message');
  assert.ok(sharedFinding);
  const target = sharedFinding.parentTopology.exactMailboxMatches[0];
  const decision = manifest.decisions.find(({ findingId }) => findingId === sharedFinding.findingId);
  decision.disposition = 'private_duplicate';
  decision.target = {
    table: target.locator.table,
    tenantId: target.locator.tenantId,
    id: target.locator.id,
    rowHash: target.rowHash,
    contentHash: target.contentHash,
  };

  const planningDb = new Database(fixture.dbPath, { readonly: true });
  const plan = planPrivateMessageResidueAdjudication(planningDb, inventory, manifest);
  planningDb.close();
  assert.equal(plan.ready, true);
  const report = await runPrivateMessageResidueAdjudication({
    dbPath: fixture.dbPath,
    mode: 'execute',
    manifest,
    confirm: plan.confirmationToken,
    backupPath: join(fixture.directory, 'duplicate-backup.db'),
    reportPath: join(fixture.directory, 'duplicate-report.json'),
  });
  assert.equal(report.status, 'applied');
  assert.equal(report.applied.privateDuplicatesRemoved, 1);
  const after = new Database(fixture.dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT content FROM ai_messages WHERE id = 'primary-mail'").get().content, body);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM shared_memory WHERE id = 'unlinked-shared-mail'").get().count, 0);
  after.close();
});
