/**
 * ENG-4 H3 — atomic, integrity-bound reconciliation (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §4, §6.3; internal increment of
 * resultVersion 3). This module evaluates and verifies; checkpoint.ts owns
 * the transaction and the writes.
 *
 * WHAT A RECONCILE IS (§4.2): a checkpoint that names the EXACT live-head set
 * and the pointer (both CAS), chooses one survivor (its parent), retires every
 * other head, records them as merge inputs, sets the pointer to itself, and
 * resolves every divergent terminal value CAUSALLY — never by revision.
 *
 * INVARIANTS (executable-tested in tests/contract-eng4-h3-reconcile.test.ts):
 * - Two ancestries (§6.3): the ACCEPTED lineage is the survivor and its
 *   parent chain (plus what the reconcile itself writes); every snapshot
 *   outside it is causal history and a potential source of DIVERGENT values,
 *   never of accepted ones.
 * - A divergent TERMINAL is, per (kind, id) and per divergent lineage (a
 *   live or retired head's chain from its fork point forward), the newest
 *   coverage tuple for that id on that chain. Interior versions are history.
 * - A terminal is RESOLVED iff a reconcile snapshot on the accepted lineage
 *   carries, in its hash-verified payload, a resolution for exactly that
 *   (kind, id, divergentStateId). Table rows are an index; the payload is
 *   the authority. Revision numbers play no part.
 * - `accept` must name a same-request change at `acceptedOrdinal` whose
 *   comparable value EQUALS the divergent terminal value; `reject` needs no
 *   change. Opaque (unversioned) terminals can only be rejected and may not
 *   remain unresolved even under strict:false. rejectLineages expands
 *   deterministically to per-terminal rejects; overlaps/contradictions with
 *   explicit resolutions are refused.
 * - strict (default) refuses the call while any materialized terminal is
 *   unresolved; strict:false commits and reports the counts.
 * - Replay (§4.3) and ordinary v3 resume re-derive the expected merge-input,
 *   retirement and resolution rows from the payload record and compare
 *   BIDIRECTIONALLY; any difference is CheckpointIntegrityError.
 */
import type DatabaseType from 'better-sqlite3';
import type {
  CheckpointParams,
  DivergenceResolutionRequest,
  FactChange,
  LoopChange,
  ReconciliationRecord,
  ResolutionRecord,
} from './contracts.js';
import { canonicalize } from './canonical.js';
import { CheckpointIntegrityError, readSnapshotChanges, verifyPayloadIntegrity } from './checkpoint.js';
import { factVersionValue, verifyVersionParity, type LoopVersionValue } from './versions.js';
import { memoGet, memoSet } from './memo.js';

/** A malformed or inadmissible reconcile request — typed, nothing written. */
export class CheckpointReconcileError extends Error {
  readonly unresolved: Array<{ kind: 'fact' | 'loop'; id: string; divergentStateId: string; reason: string }>;
  constructor(message: string, unresolved: CheckpointReconcileError['unresolved'] = []) {
    super(message);
    this.name = 'CheckpointReconcileError';
    this.unresolved = unresolved;
  }
}

/** A v3 `write` extending a retired parent without acknowledgeRetired (§4.5). */
export class CheckpointRetiredParentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointRetiredParentError';
  }
}

// ---------------------------------------------------------------------------
// Normalization (request → fingerprint-bound, deterministic form)
// ---------------------------------------------------------------------------

export interface NormalizedReconcile {
  expectedHeads: string[];
  expectedPointer: string | null;
  survivor: string;
  reason: string;
  strict: boolean;
  resolutions: DivergenceResolutionRequest[];
  rejectLineages: string[];
  /**
   * Required when the survivor's own chain contains RETIRED snapshots (the
   * survivor is a resurrection): choosing it re-adopts values that an earlier,
   * now off-lineage reconcile may have rejected. The re-adopted snapshots are
   * recorded in the reconciliation record (`adoptedRetired`) so the audit
   * trail shows the act (independent review of PR #13, finding 4).
   */
  acknowledgeRetired: boolean;
}

const resolutionKey = (r: { kind: string; id: string; divergentStateId: string }) => `${r.kind}|${r.id}|${r.divergentStateId}`;
const byResolutionKey = (a: { kind: string; id: string; divergentStateId: string }, b: typeof a) =>
  a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.divergentStateId < b.divergentStateId ? -1 : a.divergentStateId > b.divergentStateId ? 1 : 0;

/** Sort and validate what can be validated WITHOUT the database. */
export function normalizeReconcileRequest(params: CheckpointParams): NormalizedReconcile {
  const heads = [...new Set(params.expectedHeads ?? [])].sort();
  if (heads.length === 0) throw new CheckpointReconcileError('eng4: reconcile requires a non-empty expectedHeads set');
  if ((params.expectedHeads ?? []).length !== heads.length) throw new CheckpointReconcileError('eng4: expectedHeads contains duplicates');
  const survivor = params.survivor ?? '';
  if (!heads.includes(survivor)) throw new CheckpointReconcileError('eng4: survivor must be one of expectedHeads');
  const reason = params.reason ?? '';
  if (!reason) throw new CheckpointReconcileError('eng4: reconcile requires a reason');
  const resolutions = [...(params.resolutions ?? [])].sort(byResolutionKey);
  const seen = new Set<string>();
  for (const r of resolutions) {
    const k = resolutionKey(r);
    if (seen.has(k)) throw new CheckpointReconcileError(`eng4: duplicate resolution for ${r.kind} ${r.id} @ ${r.divergentStateId}`);
    seen.add(k);
    if (r.decision === 'accept' && (r.acceptedOrdinal === undefined || r.acceptedOrdinal < 0)) {
      throw new CheckpointReconcileError(`eng4: accept for ${r.kind} ${r.id} requires acceptedOrdinal`);
    }
    if (r.decision === 'reject' && r.acceptedOrdinal !== undefined) {
      throw new CheckpointReconcileError(`eng4: reject for ${r.kind} ${r.id} must not carry acceptedOrdinal`);
    }
  }
  const rejectLineages = [...new Set(params.rejectLineages ?? [])].sort();
  if ((params.rejectLineages ?? []).length !== rejectLineages.length) throw new CheckpointReconcileError('eng4: rejectLineages contains duplicates');
  if (rejectLineages.includes(survivor)) throw new CheckpointReconcileError('eng4: rejectLineages must not name the survivor');
  return {
    expectedHeads: heads,
    expectedPointer: params.expectedPointer ?? null,
    survivor,
    reason,
    strict: params.strict !== false,
    resolutions,
    rejectLineages,
    acknowledgeRetired: params.acknowledgeRetired === true,
  };
}

// ---------------------------------------------------------------------------
// Lineages
// ---------------------------------------------------------------------------

interface SnapRow { state_id: string; parent_state_id: string | null; revision: number; content_hash: string }

const snapshotRow = (db: DatabaseType.Database, tenantId: string, scopeKey: string, stateId: string): SnapRow | undefined =>
  db.prepare(
    `SELECT state_id, parent_state_id, revision, content_hash FROM eng4_state_snapshots
      WHERE tenant_id = ? AND scope_key = ? AND state_id = ?`
  ).get(tenantId, scopeKey, stateId) as SnapRow | undefined;

/** The head and its parent chain, head first (§6.3 acceptedLineage). */
export function lineageOf(db: DatabaseType.Database, tenantId: string, scopeKey: string, headStateId: string): SnapRow[] {
  const out: SnapRow[] = [];
  let cursor: string | null = headStateId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const row = snapshotRow(db, tenantId, scopeKey, cursor);
    if (!row) break;
    out.push(row);
    cursor = row.parent_state_id;
  }
  return out;
}

/** The chain from `head` back to (excluding) the first snapshot in `accepted`. */
function divergentChain(db: DatabaseType.Database, tenantId: string, scopeKey: string, head: string, accepted: Set<string>): SnapRow[] {
  const out: SnapRow[] = [];
  let cursor: string | null = head;
  const guard = new Set<string>();
  while (cursor && !accepted.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const row = snapshotRow(db, tenantId, scopeKey, cursor);
    if (!row) break;
    out.push(row);
    cursor = row.parent_state_id;
  }
  return out;
}

function retiredHeads(db: DatabaseType.Database, tenantId: string, scopeKey: string): string[] {
  return (db.prepare(`SELECT state_id FROM eng4_head_retirements WHERE tenant_id = ? AND scope_key = ? ORDER BY state_id`)
    .all(tenantId, scopeKey) as Array<{ state_id: string }>).map((r) => String(r.state_id));
}

// ---------------------------------------------------------------------------
// Payload reconciliation records (the authority)
// ---------------------------------------------------------------------------

export function readReconciliation(db: DatabaseType.Database, tenantId: string, contentHash: string): ReconciliationRecord | null {
  verifyPayloadIntegrity(db, tenantId, contentHash);
  const memoKey = `reconciliation|${tenantId}|${contentHash}`;
  const cached = memoGet<{ rec: ReconciliationRecord | null }>(memoKey);
  if (cached) return cached.rec;
  const payload = db.prepare(`SELECT body FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`).get(tenantId, contentHash) as { body: Buffer };
  let env: any;
  try { env = JSON.parse(payload.body.toString('utf-8')); } catch { throw new CheckpointIntegrityError(`eng4: persisted envelope ${contentHash} is not parseable`); }
  const rec = env.reconciliation;
  if (rec === undefined || rec === null) { memoSet(memoKey, { rec: null }); return null; }
  // Shape check — a malformed record is corruption, not a TypeError later.
  const ok = typeof rec === 'object' && !Array.isArray(rec)
    && Array.isArray(rec.expectedHeads) && typeof rec.survivor === 'string' && Array.isArray(rec.retired)
    && (typeof rec.expectedPointer === 'string' || rec.expectedPointer === null) && typeof rec.reason === 'string'
    && typeof rec.strict === 'boolean' && Array.isArray(rec.resolutions) && Array.isArray(rec.adoptedRetired)
    && rec.unresolvedDivergent && typeof rec.unresolvedDivergent.facts === 'number' && typeof rec.unresolvedDivergent.loops === 'number'
    && rec.resolutions.every((r: any) => r && (r.kind === 'fact' || r.kind === 'loop') && typeof r.id === 'string'
      && typeof r.divergentStateId === 'string' && (r.decision === 'accept' || r.decision === 'reject')
      && (r.acceptedOrdinal === null || Number.isInteger(r.acceptedOrdinal)));
  if (!ok) throw new CheckpointIntegrityError(`eng4: persisted envelope ${contentHash} carries a malformed reconciliation record`);
  memoSet(memoKey, { rec });
  return rec as ReconciliationRecord;
}

/** Every resolution recorded by reconcile snapshots ON the given lineage, keyed. */
export function verifiedResolutionKeys(db: DatabaseType.Database, tenantId: string, lineage: SnapRow[]): Set<string> {
  const keys = new Set<string>();
  for (const s of lineage) {
    const rec = readReconciliation(db, tenantId, s.content_hash);
    if (!rec) continue;
    for (const r of rec.resolutions) keys.add(resolutionKey(r));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export interface Terminal {
  kind: 'fact' | 'loop';
  id: string;
  stateId: string;
  ordinal: number;
  revision: number;
  /** null = opaque (unversioned coverage). */
  comparable: string | null;
  /** Which divergent head(s) this terminal belongs to. */
  heads: Set<string>;
}

/** Sorted resolution-key string for a terminal (the same key the payload records use). */
export const terminalKey = (t: { kind: string; id: string; stateId: string }) => resolutionKey({ kind: t.kind, id: t.id, divergentStateId: t.stateId });

/**
 * H4 read-model entry point: every divergent terminal relative to the given
 * accepted head — the chains of every live head other than `acceptedHead`
 * and of every retired snapshot not on its lineage, from their fork points —
 * plus the verified resolution keys on that lineage. Shares the exact
 * enumeration a reconcile uses: the materialized terminals resume lists and
 * the opaque ones it counts are together what a reconcile would demand a
 * resolution for.
 */
export function divergentTerminalsFor(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  acceptedHead: string
): { terminals: Map<string, Terminal>; chains: Map<string, Set<string>>; resolvedKeys: Set<string>; accepted: Set<string> } {
  const acceptedRows = lineageOf(db, tenantId, scopeKey, acceptedHead);
  const accepted = new Set(acceptedRows.map((s) => s.state_id));
  const resolvedKeys = verifiedResolutionKeys(db, tenantId, acceptedRows);
  const live = (db.prepare(
    `SELECT s.state_id FROM eng4_state_snapshots s
      WHERE s.tenant_id = ? AND s.scope_key = ? AND s.state_id != ?
        AND NOT EXISTS (SELECT 1 FROM eng4_state_snapshots c WHERE c.tenant_id = s.tenant_id AND c.scope_key = s.scope_key AND c.parent_state_id = s.state_id)
        AND NOT EXISTS (SELECT 1 FROM eng4_head_retirements r WHERE r.tenant_id = s.tenant_id AND r.scope_key = s.scope_key AND r.state_id = s.state_id)`
  ).all(tenantId, scopeKey, acceptedHead) as Array<{ state_id: string }>).map((r) => String(r.state_id));
  const retired = retiredHeads(db, tenantId, scopeKey).filter((h) => !accepted.has(h));
  const heads = [...new Set([...live, ...retired])].sort();
  const { terminals, chains } = terminalsFor(db, tenantId, scopeKey, heads, accepted);
  return { terminals, chains, resolvedKeys, accepted };
}

/** The comparable value of a version (RFC 8785 over the fields the version stores; loop close timestamps excluded). */
export function comparableFact(v: { subject: string; predicate: string; object: string; status: string; effectiveAt: string | null; refsJson: string }): string {
  return canonicalize({ subject: v.subject, predicate: v.predicate, object: v.object, status: v.status, effectiveAt: v.effectiveAt, refsJson: v.refsJson });
}
export function comparableLoop(v: LoopVersionValue): string {
  let closeOutcome: string | null = null;
  if (v.closeJson) { try { closeOutcome = JSON.parse(v.closeJson).outcome ?? null; } catch { closeOutcome = null; } }
  return canonicalize({ owner: v.owner, status: v.status, nextAction: v.nextAction, dueAt: v.dueAt, blockedOn: v.blockedOn, closeOutcome });
}

function terminalsFor(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  divergentHeadIds: string[],
  accepted: Set<string>
): { terminals: Map<string, Terminal>; chains: Map<string, Set<string>> } {
  const terminals = new Map<string, Terminal>();
  const chains = new Map<string, Set<string>>();
  // Terminals are derived from the DIGEST-VERIFIED LEDGER joined to coverage,
  // never from coverage alone: a ledger tuple without a coverage row is
  // corruption and fails closed (independent review of PR #13, finding 1).
  const ledgerOf = db.prepare(
    `SELECT c.kind, c.ordinal, c.change_id, v.disposition
       FROM eng4_snapshot_changes c
       LEFT JOIN eng4_version_coverage v
         ON v.tenant_id = c.tenant_id AND v.state_id = c.state_id AND v.kind = c.kind AND v.ordinal = c.ordinal
      WHERE c.tenant_id = ? AND c.state_id = ? ORDER BY c.kind, c.ordinal`
  );
  const factVersion = db.prepare(
    `SELECT subject, predicate, object, status, effective_at, refs_json FROM eng4_fact_versions
      WHERE tenant_id = ? AND scope_key = ? AND fact_id = ? AND state_id = ? AND ordinal = ?`
  );
  const loopVersion = db.prepare(
    `SELECT owner, status, next_action, due_at, blocked_on, close_json FROM eng4_loop_versions
      WHERE tenant_id = ? AND scope_key = ? AND loop_id = ? AND state_id = ? AND ordinal = ?`
  );
  for (const head of divergentHeadIds) {
    const chain = divergentChain(db, tenantId, scopeKey, head, accepted);
    chains.set(head, new Set(chain.map((s) => s.state_id)));
    // Newest per (kind, id) on THIS chain: walk from head (newest) down.
    const seenOnChain = new Set<string>();
    for (const s of chain) {
      const rows = ledgerOf.all(tenantId, s.state_id) as Array<{ kind: 'fact' | 'loop'; ordinal: number; change_id: string; disposition: string | null }>;
      for (const c of rows) {
        if (c.disposition === null) throw new CheckpointIntegrityError(`eng4: ledger tuple ${c.kind}[${c.ordinal}] of ${s.state_id} has no coverage row`);
      }
      // Within one snapshot, the higher ordinal is newer.
      for (const c of [...rows].sort((a, b) => b.ordinal - a.ordinal)) {
        const idKey = `${c.kind}|${c.change_id}`;
        if (seenOnChain.has(idKey)) continue;
        seenOnChain.add(idKey);
        const key = `${idKey}|${s.state_id}`;
        const existing = terminals.get(key);
        if (existing) { existing.heads.add(head); continue; }
        let comparable: string | null = null;
        if (c.disposition === 'materialized') {
          if (c.kind === 'fact') {
            const v = factVersion.get(tenantId, scopeKey, c.change_id, s.state_id, c.ordinal) as any;
            if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a fact version for ${c.change_id} @ ${s.state_id}`);
            comparable = comparableFact({ subject: v.subject, predicate: v.predicate, object: v.object, status: v.status, effectiveAt: v.effective_at ?? null, refsJson: v.refs_json });
          } else {
            const v = loopVersion.get(tenantId, scopeKey, c.change_id, s.state_id, c.ordinal) as any;
            if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a loop version for ${c.change_id} @ ${s.state_id}`);
            comparable = comparableLoop({ owner: v.owner, status: v.status, nextAction: v.next_action, dueAt: v.due_at ?? null, blockedOn: v.blocked_on ?? null, closeJson: v.close_json ?? null });
          }
        }
        terminals.set(key, { kind: c.kind, id: c.change_id, stateId: s.state_id, ordinal: c.ordinal, revision: s.revision, comparable, heads: new Set([head]) });
      }
    }
  }
  return { terminals, chains };
}

// ---------------------------------------------------------------------------
// Evaluation (inside the checkpoint transaction, before any write)
// ---------------------------------------------------------------------------

export interface DivergenceOutcome {
  resolutions: ResolutionRecord[];
  unresolvedDivergent: { facts: number; loops: number };
  /** The heads being retired (expectedHeads minus survivor), sorted. */
  retired: string[];
  /** Retired snapshots on the survivor's own chain that this reconcile re-adopts, sorted. */
  adoptedRetired: string[];
}

/** Retired snapshots among `rows`, sorted. */
function retiredAmong(db: DatabaseType.Database, tenantId: string, scopeKey: string, rows: SnapRow[]): string[] {
  const retired = new Set(retiredHeads(db, tenantId, scopeKey));
  return rows.map((s) => s.state_id).filter((id) => retired.has(id)).sort();
}

/**
 * The owner `applyLoopChanges` will record for loopChanges[ordinal]: the
 * in-place owner before the request, then each earlier change for the SAME
 * loop in this request applied in order (`change.owner ?? previous`). An
 * accept must compare against exactly this value or the committed reconcile
 * would fail its own parity (independent review of PR #13, finding 2).
 */
function effectiveLoopOwnerAt(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  loopChanges: LoopChange[],
  ordinal: number,
  author: string
): string {
  const loopId = loopChanges[ordinal].loopId;
  const inPlace = loopId
    ? (db.prepare(`SELECT owner FROM eng4_open_loops WHERE tenant_id = ? AND scope_key = ? AND loop_id = ?`).get(tenantId, scopeKey, loopId) as { owner: string } | undefined)
    : undefined;
  let owner: string = inPlace?.owner ?? author;
  for (let j = 0; j <= ordinal; j++) {
    const c = loopChanges[j];
    if (c.loopId !== loopId) continue;
    owner = c.owner ?? owner;
  }
  return owner;
}

/** The highest ordinal in `list` that names `id` (facts by factId, loops by loopId), or -1. */
function lastOrdinalNaming(list: Array<FactChange | LoopChange>, kind: 'fact' | 'loop', id: string): number {
  let last = -1;
  list.forEach((c, i) => {
    const named = kind === 'fact' ? (c as FactChange).factId : (c as LoopChange).loopId;
    if (named === id) last = i;
  });
  return last;
}

/**
 * §6.3 — enumerate every unresolved divergent terminal across the heads
 * being merged (and previously retired heads whose terminals were left
 * unresolved), match the request's resolutions, expand rejectLineages,
 * validate every accept against the request's own changes, and apply the
 * strict rule. Throws CheckpointReconcileError; writes nothing.
 */
export function evaluateDivergence(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  req: NormalizedReconcile,
  changes: { factChanges: FactChange[]; loopChanges: LoopChange[] },
  author: string
): DivergenceOutcome {
  // Nothing below is trusted until the stored evidence checks out: version
  // foundation (coverage/version rows vs payload + ledger), every retirement
  // row's attribution, and every prior reconcile on the survivor's lineage.
  verifyVersionParity(db, tenantId, scopeKey);
  verifyRetirementAttribution(db, tenantId, scopeKey);
  verifyReconcileRowsScopeWide(db, tenantId, scopeKey);
  verifyResolutionRowsOnLineage(db, tenantId, scopeKey, req.survivor);

  const acceptedRows = lineageOf(db, tenantId, scopeKey, req.survivor);
  const accepted = new Set(acceptedRows.map((s) => s.state_id));
  const resolvedKeys = verifiedResolutionKeys(db, tenantId, acceptedRows);
  const retired = req.expectedHeads.filter((h) => h !== req.survivor);
  const previouslyRetired = retiredHeads(db, tenantId, scopeKey).filter((h) => !accepted.has(h));
  const divergentHeadIds = [...new Set([...retired, ...previouslyRetired])].sort();
  // A resurrected survivor re-adopts retired history (finding 4): explicit, recorded.
  const adoptedRetired = retiredAmong(db, tenantId, scopeKey, acceptedRows);
  if (adoptedRetired.length > 0 && !req.acknowledgeRetired) {
    throw new CheckpointReconcileError(
      `eng4: survivor ${req.survivor} descends from retired snapshot(s) ${adoptedRetired.join(', ')}; re-adopting them requires acknowledgeRetired: true (values an earlier reconcile rejected would become accepted)`
    );
  }
  for (const l of req.rejectLineages) {
    if (!divergentHeadIds.includes(l)) throw new CheckpointReconcileError(`eng4: rejectLineages names ${l}, which is not a divergent head (live non-survivor or retired)`);
  }

  const { terminals, chains } = terminalsFor(db, tenantId, scopeKey, divergentHeadIds, accepted);
  const unresolved = new Map<string, Terminal>();
  for (const [key, t] of terminals) if (!resolvedKeys.has(key)) unresolved.set(key, t);

  const outcome = new Map<string, ResolutionRecord>();
  const problems: CheckpointReconcileError['unresolved'] = [];

  // Explicit resolutions.
  for (const r of req.resolutions) {
    const key = resolutionKey(r);
    const t = unresolved.get(key);
    if (!t) throw new CheckpointReconcileError(`eng4: resolution targets ${r.kind} ${r.id} @ ${r.divergentStateId}, which is not an unresolved divergent terminal`);
    if (r.decision === 'reject') {
      outcome.set(key, { kind: r.kind, id: r.id, divergentStateId: r.divergentStateId, decision: 'reject', acceptedOrdinal: null });
      continue;
    }
    if (t.comparable === null) throw new CheckpointReconcileError(`eng4: ${r.kind} ${r.id} @ ${r.divergentStateId} is an opaque (unversioned) terminal and can only be rejected`);
    const ordinal = r.acceptedOrdinal as number;
    const list = r.kind === 'fact' ? changes.factChanges : changes.loopChanges;
    const change = list[ordinal];
    if (!change) throw new CheckpointReconcileError(`eng4: accept for ${r.kind} ${r.id} names ordinal ${ordinal}, which this request does not contain`);
    const namedId = r.kind === 'fact' ? (change as FactChange).factId : (change as LoopChange).loopId;
    if (namedId !== r.id) throw new CheckpointReconcileError(`eng4: accept for ${r.kind} ${r.id} names ordinal ${ordinal}, which changes ${namedId ?? '(a new row)'}`);
    // "Accept with amendment" is reject + a fresh change (§9.2): the accepted
    // change must be the LAST one for this id in the request, so the accepted
    // lineage's newest value IS the divergent value (finding 3).
    const last = lastOrdinalNaming(list, r.kind, r.id);
    if (last !== ordinal) {
      throw new CheckpointReconcileError(`eng4: accept for ${r.kind} ${r.id} names ordinal ${ordinal} but ordinal ${last} changes the same id later in this request — accept must name the final change (amend via reject + a fresh change)`);
    }
    let requested: string;
    if (r.kind === 'fact') {
      const v = factVersionValue(change as FactChange);
      requested = comparableFact(v);
    } else {
      const lc = change as LoopChange;
      const owner = effectiveLoopOwnerAt(db, tenantId, scopeKey, changes.loopChanges, ordinal, author);
      requested = comparableLoop({
        owner, status: lc.status, nextAction: lc.nextAction, dueAt: lc.dueAt ?? null, blockedOn: lc.blockedOn ?? null,
        closeJson: lc.status === 'closed' ? JSON.stringify({ outcome: lc.closeOutcome }) : null,
      });
    }
    if (requested !== t.comparable) {
      throw new CheckpointReconcileError(`eng4: accept for ${r.kind} ${r.id} @ ${r.divergentStateId}: the change at ordinal ${ordinal} does not equal the divergent terminal value`);
    }
    outcome.set(key, { kind: r.kind, id: r.id, divergentStateId: r.divergentStateId, decision: 'accept', acceptedOrdinal: ordinal });
  }

  // rejectLineages expansion: every still-unresolved terminal on the named
  // chains. Overlapping an EXPLICIT resolution is a contradiction (refused);
  // two lineages that share a prefix legitimately name the same terminal and
  // simply agree (one reject row).
  const explicitKeys = new Set(req.resolutions.map(resolutionKey));
  for (const head of req.rejectLineages) {
    const chain = chains.get(head) ?? new Set<string>();
    for (const [key, t] of unresolved) {
      if (!chain.has(t.stateId)) continue;
      if (explicitKeys.has(key)) throw new CheckpointReconcileError(`eng4: rejectLineages ${head} overlaps an explicit resolution for ${t.kind} ${t.id} @ ${t.stateId}`);
      if (outcome.has(key)) continue;
      outcome.set(key, { kind: t.kind, id: t.id, divergentStateId: t.stateId, decision: 'reject', acceptedOrdinal: null });
    }
  }

  // What remains.
  const counts = { facts: 0, loops: 0 };
  for (const [key, t] of unresolved) {
    if (outcome.has(key)) continue;
    if (t.comparable === null) {
      problems.push({ kind: t.kind, id: t.id, divergentStateId: t.stateId, reason: 'opaque terminal (unversioned) must be rejected' });
      continue;
    }
    if (req.strict) problems.push({ kind: t.kind, id: t.id, divergentStateId: t.stateId, reason: 'unresolved divergent terminal under strict' });
    else counts[t.kind === 'fact' ? 'facts' : 'loops']++;
  }
  if (problems.length > 0) {
    throw new CheckpointReconcileError(
      `eng4: reconcile refused — ${problems.length} divergent terminal(s) unresolved: ` +
        problems.map((p) => `${p.kind} ${p.id} @ ${p.divergentStateId} (${p.reason})`).join('; '),
      problems
    );
  }
  return {
    resolutions: [...outcome.values()].sort(byResolutionKey),
    unresolvedDivergent: counts,
    retired,
    adoptedRetired,
  };
}

/**
 * Every retirement row must be attributed to a reconcile snapshot whose
 * hash-verified payload record names that snapshot as retired — otherwise a
 * live head could be hidden by one out-of-band row (independent review of
 * PR #13, finding 6). Scope-wide, because retirements are legitimately
 * attributed to reconciles that are not on the current accepted lineage.
 */
export function verifyRetirementAttribution(db: DatabaseType.Database, tenantId: string, scopeKey: string): { retirementsVerified: number } {
  const rows = db.prepare(
    `SELECT r.state_id, r.retired_by_state_id, s.content_hash
       FROM eng4_head_retirements r
       LEFT JOIN eng4_state_snapshots s
         ON s.tenant_id = r.tenant_id AND s.scope_key = r.scope_key AND s.state_id = r.retired_by_state_id
      WHERE r.tenant_id = ? AND r.scope_key = ? ORDER BY r.retired_by_state_id, r.state_id`
  ).all(tenantId, scopeKey) as Array<{ state_id: string; retired_by_state_id: string; content_hash: string | null }>;
  const cache = new Map<string, ReconciliationRecord | null>();
  for (const r of rows) {
    if (!r.content_hash) throw new CheckpointIntegrityError(`eng4: retirement of ${r.state_id} is attributed to unknown snapshot ${r.retired_by_state_id}`);
    let rec = cache.get(r.retired_by_state_id);
    if (rec === undefined) { rec = readReconciliation(db, tenantId, r.content_hash); cache.set(r.retired_by_state_id, rec); }
    if (!rec || !rec.retired.includes(r.state_id)) {
      throw new CheckpointIntegrityError(`eng4: retirement of ${r.state_id} is attributed to ${r.retired_by_state_id}, whose payload does not record retiring it`);
    }
  }
  return { retirementsVerified: rows.length };
}

// ---------------------------------------------------------------------------
// Row writers and parity
// ---------------------------------------------------------------------------

export function writeReconcileRows(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  stateId: string,
  record: ReconciliationRecord,
  author: string,
  recordedAt: string
): void {
  const input = db.prepare(`INSERT INTO eng4_snapshot_merge_inputs (tenant_id, scope_key, state_id, input_state_id) VALUES (?, ?, ?, ?)`);
  const retire = db.prepare(
    `INSERT INTO eng4_head_retirements (tenant_id, scope_key, state_id, retired_by_state_id, retired_at, retired_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const h of record.retired) {
    input.run(tenantId, scopeKey, stateId, h);
    retire.run(tenantId, scopeKey, h, stateId, recordedAt, author, record.reason);
  }
  const resolve = db.prepare(
    `INSERT INTO eng4_divergence_resolutions (tenant_id, scope_key, kind, change_id, divergent_state_id, resolved_by_state_id, decision, accepted_ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of record.resolutions) resolve.run(tenantId, scopeKey, r.kind, r.id, r.divergentStateId, stateId, r.decision, r.acceptedOrdinal);
}

function rowsFor(db: DatabaseType.Database, tenantId: string, scopeKey: string, stateId: string) {
  const inputs = (db.prepare(`SELECT input_state_id FROM eng4_snapshot_merge_inputs WHERE tenant_id = ? AND scope_key = ? AND state_id = ? ORDER BY input_state_id`)
    .all(tenantId, scopeKey, stateId) as any[]).map((r) => String(r.input_state_id));
  const retirements = db.prepare(`SELECT state_id, retired_by_state_id, retired_at, retired_by, reason FROM eng4_head_retirements WHERE tenant_id = ? AND scope_key = ? AND retired_by_state_id = ? ORDER BY state_id`)
    .all(tenantId, scopeKey, stateId) as Array<{ state_id: string; retired_by_state_id: string; retired_at: string; retired_by: string; reason: string }>;
  const resolutions = (db.prepare(
    `SELECT kind, change_id, divergent_state_id, decision, accepted_ordinal FROM eng4_divergence_resolutions
      WHERE tenant_id = ? AND scope_key = ? AND resolved_by_state_id = ?`
  ).all(tenantId, scopeKey, stateId) as any[]).map((r): ResolutionRecord => ({
    kind: r.kind, id: String(r.change_id), divergentStateId: String(r.divergent_state_id), decision: r.decision,
    acceptedOrdinal: r.accepted_ordinal === null ? null : Number(r.accepted_ordinal),
  })).sort(byResolutionKey);
  return { inputs, retirements, resolutions };
}

/**
 * §4.3 — exact parity between the hash-verified payload record and the
 * merge-input / retirement / resolution rows for one reconcile snapshot.
 * Also checks parent == survivor and, if the pointer points here, its reason.
 */
export function verifyReconcileParity(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  stateId: string,
  record: ReconciliationRecord
): void {
  const fail = (why: string): never => {
    throw new CheckpointIntegrityError(`eng4: reconcile parity failed for ${stateId}: ${why}`);
  };
  const snap = snapshotRow(db, tenantId, scopeKey, stateId);
  if (!snap) return fail('snapshot missing');
  if (snap.parent_state_id !== record.survivor) fail('parent is not the recorded survivor');
  // The reconcile's own ledger must verify against its digest before any
  // accept is checked against it (finding 7a).
  const digest = db.prepare(`SELECT changes_hash FROM eng4_state_snapshots WHERE tenant_id = ? AND state_id = ?`).get(tenantId, stateId) as { changes_hash: string | null };
  readSnapshotChanges(db, tenantId, stateId, snap.content_hash, digest.changes_hash, true);
  // The re-adopted retired snapshots on the parent chain must be exactly the recorded ones.
  const adoptedNow = retiredAmong(db, tenantId, scopeKey, lineageOf(db, tenantId, scopeKey, record.survivor));
  if (canonicalize(adoptedNow) !== canonicalize([...record.adoptedRetired].sort())) fail('re-adopted retired snapshots differ from the recorded adoptedRetired set');
  const { inputs, retirements, resolutions } = rowsFor(db, tenantId, scopeKey, stateId);
  const expectedRetired = [...record.retired].sort();
  if (canonicalize(inputs) !== canonicalize(expectedRetired)) fail('merge-input set differs from the recorded retired set');
  if (canonicalize(retirements.map((r) => r.state_id)) !== canonicalize(expectedRetired)) fail('retirement set differs from the recorded retired set');
  // Every retirement row's attribution, time, actor and reason must equal the
  // reconcile snapshot's own author/recorded_at and the recorded reason
  // (codex-hythe review of PR #13, finding 4).
  const who = db.prepare(`SELECT author, recorded_at FROM eng4_state_snapshots WHERE tenant_id = ? AND state_id = ?`).get(tenantId, stateId) as { author: string; recorded_at: string };
  for (const r of retirements) {
    if (r.retired_by_state_id !== stateId) fail(`retirement of ${r.state_id} is attributed to another snapshot`);
    if (r.retired_by !== who.author) fail(`retirement of ${r.state_id} names actor '${r.retired_by}', not the reconcile author`);
    if (r.retired_at !== who.recorded_at) fail(`retirement of ${r.state_id} is timed '${r.retired_at}', not at the reconcile`);
    if (r.reason !== record.reason) fail(`retirement of ${r.state_id} carries a reason that differs from the recorded one`);
  }
  const expectedResolutions = [...record.resolutions].sort(byResolutionKey);
  if (canonicalize(resolutions) !== canonicalize(expectedResolutions)) fail('resolution rows differ from the recorded resolution set');
  // Each accept must point at THIS snapshot's ledger row for the same id, and
  // the version written there must equal the divergent terminal value.
  for (const r of expectedResolutions) {
    if (r.decision !== 'accept') continue;
    const ledger = db.prepare(`SELECT change_id FROM eng4_snapshot_changes WHERE tenant_id = ? AND state_id = ? AND kind = ? AND ordinal = ?`)
      .get(tenantId, stateId, r.kind, r.acceptedOrdinal) as { change_id: string } | undefined;
    if (!ledger || String(ledger.change_id) !== r.id) fail(`accept for ${r.kind} ${r.id} does not point at a matching ledger row`);
    const later = db.prepare(`SELECT COUNT(*) AS n FROM eng4_snapshot_changes WHERE tenant_id = ? AND state_id = ? AND kind = ? AND change_id = ? AND ordinal > ?`)
      .get(tenantId, stateId, r.kind, r.id, r.acceptedOrdinal) as { n: number };
    if (later.n > 0) fail(`accept for ${r.kind} ${r.id} names ordinal ${r.acceptedOrdinal} but a later change for the same id exists in the snapshot`);
    const own = comparableAt(db, tenantId, scopeKey, r.kind, r.id, stateId, r.acceptedOrdinal as number);
    const divergent = comparableAtNewest(db, tenantId, scopeKey, r.kind, r.id, r.divergentStateId);
    if (own === null || divergent === null || own !== divergent) fail(`accepted value for ${r.kind} ${r.id} does not equal the divergent terminal value`);
  }
  const pointer = db.prepare(`SELECT state_id, reason FROM eng4_scope_current WHERE tenant_id = ? AND scope_key = ?`).get(tenantId, scopeKey) as { state_id: string; reason: string } | undefined;
  if (pointer && String(pointer.state_id) === stateId && pointer.reason !== 'reconcile') fail('pointer points here but was not set by reconcile');
}

function comparableAt(db: DatabaseType.Database, tenantId: string, scopeKey: string, kind: 'fact' | 'loop', id: string, stateId: string, ordinal: number): string | null {
  if (kind === 'fact') {
    const v = db.prepare(`SELECT subject, predicate, object, status, effective_at, refs_json FROM eng4_fact_versions WHERE tenant_id = ? AND scope_key = ? AND fact_id = ? AND state_id = ? AND ordinal = ?`)
      .get(tenantId, scopeKey, id, stateId, ordinal) as any;
    return v ? comparableFact({ subject: v.subject, predicate: v.predicate, object: v.object, status: v.status, effectiveAt: v.effective_at ?? null, refsJson: v.refs_json }) : null;
  }
  const v = db.prepare(`SELECT owner, status, next_action, due_at, blocked_on, close_json FROM eng4_loop_versions WHERE tenant_id = ? AND scope_key = ? AND loop_id = ? AND state_id = ? AND ordinal = ?`)
    .get(tenantId, scopeKey, id, stateId, ordinal) as any;
  return v ? comparableLoop({ owner: v.owner, status: v.status, nextAction: v.next_action, dueAt: v.due_at ?? null, blockedOn: v.blocked_on ?? null, closeJson: v.close_json ?? null }) : null;
}

/** The newest version of (kind, id) written by one snapshot (highest ordinal). */
function comparableAtNewest(db: DatabaseType.Database, tenantId: string, scopeKey: string, kind: 'fact' | 'loop', id: string, stateId: string): string | null {
  const row = db.prepare(`SELECT MAX(ordinal) AS o FROM eng4_snapshot_changes WHERE tenant_id = ? AND state_id = ? AND kind = ? AND change_id = ?`)
    .get(tenantId, stateId, kind, id) as { o: number | null };
  if (row.o === null) return null;
  return comparableAt(db, tenantId, scopeKey, kind, id, stateId, Number(row.o));
}

/**
 * Payload → row direction for EVERY reconcile in the scope, on or off the
 * accepted lineage (independent re-review of PR #13, LOW 1): each recorded
 * retired id must have exactly its retirement row attributed to that
 * snapshot, and the merge-input set must equal the recorded retired set.
 * Together with verifyRetirementAttribution (row → payload) this makes
 * retirement evidence bidirectional scope-wide, so a deleted retirement row
 * cannot quietly bring a retired head back to life.
 */
export function verifyReconcileRowsScopeWide(db: DatabaseType.Database, tenantId: string, scopeKey: string): { reconcilesVerified: number } {
  let n = 0;
  const rows = db.prepare(
    `SELECT state_id, content_hash, author, recorded_at FROM eng4_state_snapshots WHERE tenant_id = ? AND scope_key = ? ORDER BY revision ASC`
  ).all(tenantId, scopeKey) as Array<{ state_id: string; content_hash: string; author: string; recorded_at: string }>;
  for (const s of rows) {
    const rec = readReconciliation(db, tenantId, s.content_hash);
    if (!rec) continue;
    const { inputs, retirements } = rowsFor(db, tenantId, scopeKey, s.state_id);
    const expected = [...rec.retired].sort();
    if (canonicalize(inputs) !== canonicalize(expected)) {
      throw new CheckpointIntegrityError(`eng4: merge-input rows of reconcile ${s.state_id} differ from its recorded retired set`);
    }
    if (canonicalize(retirements.map((r) => r.state_id)) !== canonicalize(expected)) {
      throw new CheckpointIntegrityError(`eng4: retirement rows attributed to reconcile ${s.state_id} differ from its recorded retired set`);
    }
    // Actor, time and reason are bound off-lineage too (independent review of PR #14, finding 5).
    for (const r of retirements) {
      if (r.retired_by !== s.author || r.retired_at !== s.recorded_at || r.reason !== rec.reason) {
        throw new CheckpointIntegrityError(`eng4: retirement of ${r.state_id} attributed to reconcile ${s.state_id} carries an actor, time or reason that differs from the reconcile`);
      }
    }
    n++;
  }
  return { reconcilesVerified: n };
}

/**
 * §4.3 (second paragraph) — on ordinary v3 resume: for every reconcile
 * snapshot on the accepted lineage, the resolution rows attributed to it
 * must equal its payload record exactly, and every accept must be backed by
 * its own ledger row and equal version value. Rows attributed to snapshots
 * OFF the accepted lineage do not count and are not inspected.
 */
export function verifyResolutionRowsOnLineage(db: DatabaseType.Database, tenantId: string, scopeKey: string, headStateId: string): { reconcilesVerified: number } {
  let n = 0;
  for (const s of lineageOf(db, tenantId, scopeKey, headStateId)) {
    const rec = readReconciliation(db, tenantId, s.content_hash);
    if (!rec) {
      // A non-reconcile snapshot must own no reconcile rows at all.
      const { inputs, retirements, resolutions } = rowsFor(db, tenantId, scopeKey, s.state_id);
      if (inputs.length || retirements.length || resolutions.length) {
        throw new CheckpointIntegrityError(`eng4: snapshot ${s.state_id} carries reconcile rows but its payload records no reconciliation`);
      }
      continue;
    }
    verifyReconcileParity(db, tenantId, scopeKey, s.state_id, rec);
    n++;
  }
  return { reconcilesVerified: n };
}
