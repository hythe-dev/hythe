/**
 * ENG-4 H4 — the resultVersion 3 READ MODEL for facts and loops (design note
 * docs/design/ENG4-HEAD-RECONCILIATION.md §6.3–§6.5, §7 row H4; internal
 * increment of resultVersion 3). READ-ONLY: every statement is a SELECT.
 *
 * WHAT CHANGES (§6.1): the in-place fact/loop tables are last-writer-wins
 * across lineages and remain the frozen v1/v2 view. Under v3 an accepted
 * value comes ONLY from a verified `materialized` version whose writing
 * snapshot is on the ACCEPTED LINEAGE (the pointed head's parent chain).
 *
 * RULES (executable-tested in tests/contract-eng4-h4-read-model.test.ts):
 * - Selection per (kind, id): the newest coverage tuple on the accepted
 *   lineage by (snapshot revision, change ordinal) — an order used only
 *   WITHIN the lineage, never across lineages. `materialized` → the version
 *   is the accepted value, with provenance {stateId, revision, ordinal,
 *   outsideAcceptedLineage:false}. `unversioned` → the id is SUPPRESSED
 *   (§6.4): never authoritative, never a fallback to an older value; it is
 *   exposed only in the non-authoritative `legacyValues` section as the
 *   in-place row with provenance null, and accounted in the section's
 *   coverage as omittedReason 'unversioned'.
 * - An id with NO change on the accepted lineage at all (written only on
 *   other lineages, or pre-ledger) is likewise suppressed to legacyValues.
 * - A scope without a pointer (legacy, never reconciled) or with an invalid
 *   designation has NO accepted lineage (§6.5): currentFacts/openLoops are
 *   empty with omittedReason 'undesignated'; every in-place row goes to
 *   legacyValues; nothing is "divergent" because nothing is accepted.
 * - divergentValues (§6.3): every materialized divergent TERMINAL — the
 *   newest tuple per (kind, id) on each divergent lineage (live non-current
 *   heads and retired snapshots off the lineage, from their fork points) —
 *   with lineageHead, provenance, the value, whether the frozen v1 view
 *   currently shows exactly this value (isV1CurrentValue), and whether a
 *   reconcile ON the accepted lineage has resolved it. Interior versions are
 *   history; opaque (unversioned) terminals have no truthful value to show
 *   and are therefore not listed (they surface in legacyValues when the
 *   in-place row holds them, and a reconcile must reject them).
 * - Loops follow the same rule (§6.3): a close written off the lineage
 *   leaves the loop OPEN in v3 and lists the close as a divergent value.
 * - Revision numbers never decide anything across lineages.
 */
import type DatabaseType from 'better-sqlite3';
import type { CurrentFact, OpenLoop } from './contracts.js';
import { canonicalize } from './canonical.js';
import { CheckpointIntegrityError } from './checkpoint.js';
import { comparableFact, comparableLoop, divergentTerminalsFor, lineageOf, terminalKey } from './reconcile.js';

export interface Provenance {
  stateId: string;
  revision: number;
  ordinal: number;
  outsideAcceptedLineage: boolean;
}

export type AcceptedFact = CurrentFact & { provenance: Provenance };
export type AcceptedLoop = OpenLoop & { provenance: Provenance };

export interface FactValueView {
  assertion: { subject: string; predicate: string; object: string };
  status: string;
  effectiveAt?: string;
  evidenceRefs: string[];
  sourceRefs: string[];
  contradicts: string[];
  author: string;
  recordedAt: string;
}

export interface LoopValueView {
  owner: string;
  status: string;
  nextAction: string;
  dueAt?: string;
  blockedOn?: string;
  closeEvent?: { closedAt: string; closedBy: string; outcome: string };
  author: string;
  recordedAt: string;
}

export interface DivergentValue {
  kind: 'fact' | 'loop';
  id: string;
  lineageHead: string;
  stateId: string;
  revision: number;
  ordinal: number;
  value: FactValueView | LoopValueView;
  isV1CurrentValue: boolean;
  resolved: boolean;
}

export interface LegacyValue {
  kind: 'fact' | 'loop';
  id: string;
  value: CurrentFact | OpenLoop;
  provenance: null;
  accepted: false;
}

export interface V3Selection {
  currentFacts: AcceptedFact[];
  openLoops: AcceptedLoop[];
  /** In-place fact/loop ids NOT authoritative under v3 (unversioned newest tuple, or no accepted-lineage change). */
  suppressedFacts: number;
  suppressedLoops: number;
  /** Why the suppressed ids are suppressed: no accepted lineage at all, or no proven version on it. */
  suppressedReason: 'undesignated' | 'unversioned';
  divergentValues: DivergentValue[];
  legacyValues: LegacyValue[];
}

interface FactVersionRow {
  fact_id: string; state_id: string; ordinal: number; subject: string; predicate: string; object: string;
  status: string; effective_at: string | null; refs_json: string; author: string; recorded_at: string;
}
interface LoopVersionRow {
  loop_id: string; state_id: string; ordinal: number; owner: string; status: string; next_action: string;
  due_at: string | null; blocked_on: string | null; close_json: string | null; author: string; recorded_at: string;
}

function parseRefs(refsJson: string): { evidenceRefs: string[]; sourceRefs: string[]; contradicts: string[] } {
  try {
    const r = JSON.parse(refsJson);
    return { evidenceRefs: r.evidenceRefs ?? [], sourceRefs: r.sourceRefs ?? [], contradicts: r.contradicts ?? [] };
  } catch {
    throw new CheckpointIntegrityError('eng4: fact version refs_json is not parseable');
  }
}

function factView(v: FactVersionRow): FactValueView {
  const refs = parseRefs(v.refs_json);
  const out: FactValueView = {
    assertion: { subject: v.subject, predicate: v.predicate, object: v.object },
    status: v.status,
    evidenceRefs: refs.evidenceRefs, sourceRefs: refs.sourceRefs, contradicts: refs.contradicts,
    author: v.author, recordedAt: v.recorded_at,
  };
  if (v.effective_at) out.effectiveAt = v.effective_at;
  return out;
}

function loopView(v: LoopVersionRow): LoopValueView {
  const out: LoopValueView = { owner: v.owner, status: v.status, nextAction: v.next_action, author: v.author, recordedAt: v.recorded_at };
  if (v.due_at) out.dueAt = v.due_at;
  if (v.blocked_on) out.blockedOn = v.blocked_on;
  if (v.close_json) { try { out.closeEvent = JSON.parse(v.close_json); } catch { throw new CheckpointIntegrityError('eng4: loop version close_json is not parseable'); } }
  return out;
}

/**
 * §6.3 historicalAncestry(head): everything reachable backwards through
 * parent_state_id AND eng4_snapshot_merge_inputs — causal history, never a
 * source of accepted values. One deduplicating recursive CTE, on demand.
 */
export function historicalAncestry(db: DatabaseType.Database, tenantId: string, scopeKey: string, headStateId: string): string[] {
  return (db.prepare(
    `WITH RECURSIVE anc(state_id) AS (
       SELECT ? UNION
       SELECT s.parent_state_id FROM eng4_state_snapshots s JOIN anc ON s.state_id = anc.state_id
        WHERE s.tenant_id = ? AND s.scope_key = ? AND s.parent_state_id IS NOT NULL
       UNION
       SELECT m.input_state_id FROM eng4_snapshot_merge_inputs m JOIN anc ON m.state_id = anc.state_id
        WHERE m.tenant_id = ? AND m.scope_key = ?
     )
     SELECT state_id FROM anc`
  ).all(headStateId, tenantId, scopeKey, tenantId, scopeKey) as Array<{ state_id: string }>).map((r) => String(r.state_id));
}

/** §6.3 acceptedLineage(head): the pointed head and its parent chain only. */
export function acceptedLineage(db: DatabaseType.Database, tenantId: string, scopeKey: string, headStateId: string): Array<{ stateId: string; revision: number }> {
  return lineageOf(db, tenantId, scopeKey, headStateId).map((s) => ({ stateId: s.state_id, revision: s.revision }));
}

const factStmt = `SELECT fact_id, state_id, ordinal, subject, predicate, object, status, effective_at, refs_json, author, recorded_at
                    FROM eng4_fact_versions WHERE tenant_id = ? AND scope_key = ? AND fact_id = ? AND state_id = ? AND ordinal = ?`;
const loopStmt = `SELECT loop_id, state_id, ordinal, owner, status, next_action, due_at, blocked_on, close_json, author, recorded_at
                    FROM eng4_loop_versions WHERE tenant_id = ? AND scope_key = ? AND loop_id = ? AND state_id = ? AND ordinal = ?`;

/**
 * Build the v3 read model. `inPlaceFacts` / `inPlaceLoops` are the frozen
 * v1 views already assembled by resume (used for legacyValues and for
 * isV1CurrentValue). `acceptedHead` is null for an undesignated scope or an
 * invalid designation.
 */
export function selectV3Values(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  acceptedHead: string | null,
  inPlaceFacts: CurrentFact[],
  inPlaceLoops: OpenLoop[]
): V3Selection {
  const legacyOf = (): LegacyValue[] => [
    ...inPlaceFacts.map((f): LegacyValue => ({ kind: 'fact', id: f.factId, value: f, provenance: null, accepted: false })),
    ...inPlaceLoops.map((l): LegacyValue => ({ kind: 'loop', id: l.loopId, value: l, provenance: null, accepted: false })),
  ];
  if (acceptedHead === null) {
    return {
      currentFacts: [], openLoops: [],
      suppressedFacts: inPlaceFacts.length, suppressedLoops: inPlaceLoops.length, suppressedReason: 'undesignated',
      divergentValues: [], legacyValues: legacyOf(),
    };
  }

  const lineage = lineageOf(db, tenantId, scopeKey, acceptedHead);
  const revisionOf = new Map(lineage.map((s) => [s.state_id, s.revision]));
  const lineageIds = lineage.map((s) => s.state_id);

  // Newest coverage tuple per (kind, id) on the accepted lineage.
  const placeholders = lineageIds.map(() => '?').join(',');
  const tuples = lineageIds.length === 0 ? [] : db.prepare(
    `SELECT v.kind, v.change_id, v.state_id, v.ordinal, v.disposition
       FROM eng4_version_coverage v WHERE v.tenant_id = ? AND v.scope_key = ? AND v.state_id IN (${placeholders})`
  ).all(tenantId, scopeKey, ...lineageIds) as Array<{ kind: 'fact' | 'loop'; change_id: string; state_id: string; ordinal: number; disposition: string }>;
  const newest = new Map<string, { kind: 'fact' | 'loop'; id: string; stateId: string; ordinal: number; revision: number; disposition: string }>();
  for (const t of tuples) {
    const key = `${t.kind}|${t.change_id}`;
    const rev = revisionOf.get(t.state_id) ?? -1;
    const cur = newest.get(key);
    if (!cur || rev > cur.revision || (rev === cur.revision && t.ordinal > cur.ordinal)) {
      newest.set(key, { kind: t.kind, id: t.change_id, stateId: t.state_id, ordinal: t.ordinal, revision: rev, disposition: t.disposition });
    }
  }

  const factQ = db.prepare(factStmt);
  const loopQ = db.prepare(loopStmt);
  const currentFacts: AcceptedFact[] = [];
  const openLoops: AcceptedLoop[] = [];
  const selectedFactIds = new Set<string>();
  const selectedLoopIds = new Set<string>();
  const inPlaceLoopById = new Map(inPlaceLoops.map((l) => [l.loopId, l]));
  for (const t of newest.values()) {
    if (t.disposition !== 'materialized') continue; // suppressed (§6.4) — never a fallback
    const provenance: Provenance = { stateId: t.stateId, revision: t.revision, ordinal: t.ordinal, outsideAcceptedLineage: false };
    if (t.kind === 'fact') {
      const v = factQ.get(tenantId, scopeKey, t.id, t.stateId, t.ordinal) as FactVersionRow | undefined;
      if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a fact version for ${t.id} @ ${t.stateId}`);
      selectedFactIds.add(t.id);
      if (v.status === 'superseded') continue; // v1 rule: superseded facts are not current
      const view = factView(v);
      const item: AcceptedFact = {
        factId: t.id, assertion: view.assertion, status: view.status as CurrentFact['status'],
        evidenceRefs: view.evidenceRefs, sourceRefs: view.sourceRefs, author: view.author, recordedAt: view.recordedAt,
        contradicts: view.contradicts, provenance,
      };
      if (view.effectiveAt) item.effectiveAt = view.effectiveAt;
      currentFacts.push(item);
    } else {
      const v = loopQ.get(tenantId, scopeKey, t.id, t.stateId, t.ordinal) as LoopVersionRow | undefined;
      if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a loop version for ${t.id} @ ${t.stateId}`);
      selectedLoopIds.add(t.id);
      const view = loopView(v);
      const inPlace = inPlaceLoopById.get(t.id);
      // openedAt is creation metadata: the loop's earliest version on any lineage, else the in-place row.
      const opened = db.prepare(`SELECT MIN(recorded_at) AS o FROM eng4_loop_versions WHERE tenant_id = ? AND scope_key = ? AND loop_id = ?`)
        .get(tenantId, scopeKey, t.id) as { o: string | null };
      const item: AcceptedLoop = {
        loopId: t.id, scopeKey, projectId: inPlace?.projectId ?? null, taskId: inPlace?.taskId ?? null,
        owner: view.owner, status: view.status as OpenLoop['status'],
        openedAt: opened.o ?? inPlace?.openedAt ?? view.recordedAt, updatedAt: view.recordedAt,
        nextAction: view.nextAction, revision: inPlace?.revision ?? 0, provenance,
      };
      if (view.dueAt) item.dueAt = view.dueAt;
      if (view.blockedOn) item.blockedOn = view.blockedOn;
      if (view.closeEvent) item.closeEvent = view.closeEvent;
      openLoops.push(item);
    }
  }
  currentFacts.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : a.factId < b.factId ? -1 : 1));
  openLoops.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.loopId < b.loopId ? -1 : 1));

  // Suppressed: in-place rows without an accepted materialized selection.
  const legacyValues: LegacyValue[] = [];
  for (const f of inPlaceFacts) if (!selectedFactIds.has(f.factId)) legacyValues.push({ kind: 'fact', id: f.factId, value: f, provenance: null, accepted: false });
  for (const l of inPlaceLoops) if (!selectedLoopIds.has(l.loopId)) legacyValues.push({ kind: 'loop', id: l.loopId, value: l, provenance: null, accepted: false });
  const suppressedFacts = inPlaceFacts.filter((f) => !selectedFactIds.has(f.factId)).length;
  const suppressedLoops = inPlaceLoops.filter((l) => !selectedLoopIds.has(l.loopId)).length;

  // Divergent terminals (the reconcile's own enumeration).
  const { terminals, resolvedKeys } = divergentTerminalsFor(db, tenantId, scopeKey, acceptedHead);
  const inPlaceFactById = new Map(inPlaceFacts.map((f) => [f.factId, f]));
  const divergentValues: DivergentValue[] = [];
  for (const t of terminals.values()) {
    if (t.comparable === null) continue; // opaque: no truthful value to show; reconcile must reject it
    const lineageHead = [...t.heads].sort()[0];
    let value: FactValueView | LoopValueView;
    let isV1CurrentValue = false;
    if (t.kind === 'fact') {
      const v = factQ.get(tenantId, scopeKey, t.id, t.stateId, t.ordinal) as FactVersionRow | undefined;
      if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a fact version for ${t.id} @ ${t.stateId}`);
      value = factView(v);
      const ip = inPlaceFactById.get(t.id);
      if (ip) {
        isV1CurrentValue = comparableFact({ subject: ip.assertion.subject, predicate: ip.assertion.predicate, object: ip.assertion.object, status: ip.status, effectiveAt: ip.effectiveAt ?? null,
          refsJson: canonicalize({ evidenceRefs: ip.evidenceRefs, sourceRefs: ip.sourceRefs, contradicts: ip.contradicts }) }) === t.comparable;
      }
    } else {
      const v = loopQ.get(tenantId, scopeKey, t.id, t.stateId, t.ordinal) as LoopVersionRow | undefined;
      if (!v) throw new CheckpointIntegrityError(`eng4: materialized coverage without a loop version for ${t.id} @ ${t.stateId}`);
      value = loopView(v);
      const ip = inPlaceLoopById.get(t.id);
      if (ip) {
        isV1CurrentValue = comparableLoop({ owner: ip.owner, status: ip.status, nextAction: ip.nextAction, dueAt: ip.dueAt ?? null, blockedOn: ip.blockedOn ?? null,
          closeJson: ip.closeEvent ? JSON.stringify(ip.closeEvent) : null }) === t.comparable;
      }
    }
    divergentValues.push({ kind: t.kind, id: t.id, lineageHead, stateId: t.stateId, revision: t.revision, ordinal: t.ordinal, value, isV1CurrentValue, resolved: resolvedKeys.has(terminalKey(t)) });
  }
  divergentValues.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.stateId < b.stateId ? -1 : 1));

  return { currentFacts, openLoops, suppressedFacts, suppressedLoops, suppressedReason: 'unversioned', divergentValues, legacyValues };
}
