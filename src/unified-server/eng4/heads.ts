/**
 * ENG-4 H1 — live heads, the current-head POINTER, and the ONE resolver of
 * "current" (design note docs/design/ENG4-HEAD-RECONCILIATION.md §3, merged
 * as 3429000; internal increment of resultVersion 3).
 *
 * THE DEFECT THIS CLOSES (§0): resume used to pick the max-revision live
 * head as current, so any writer extending an OLDER parent produced a higher
 * revision and silently became "current" (four displacements on one scope on
 * 2026-09-03). Revision numbers no longer enter the decision once a pointer
 * exists.
 *
 * INVARIANTS (executable-tested in tests/contract-eng4-h1-head-pointer.test.ts):
 * - eng4_scope_current holds at most one row per (tenant, scope): the current
 *   head ITSELF, same-scope by composite FK (never an anchor, never a guess).
 * - Advance rule (§3.2a), unconditional on operation and result version:
 *   inside every checkpoint transaction, after the snapshot insert, the
 *   pointer moves to the new snapshot IFF the new snapshot's parent IS the
 *   pointed head. Otherwise a branch was written — live, but NOT current.
 *   The first snapshot in a scope sets the pointer to itself (§3.4).
 * - A→B / A→C (89c01374): pointer at A; A→B advances to B; a stale A→C
 *   leaves the pointer at B — C is a live divergent head with a HIGHER
 *   revision that is not current.
 * - effectiveCurrentHead (§3.3) is the single definition of "current" for
 *   resume (all bundle versions) and for the H5 record/patch parent rule:
 *     no pointer, no heads      → 'empty-scope'
 *     no pointer, heads         → 'max-revision' (legacy scopes only; a scope
 *                                 that predates H1 and never reconciled)
 *     pointer ∈ live heads      → 'pointer'
 *     pointer ∉ live heads      → 'invalid-designation' (fail closed: head
 *                                 null, never an automatic fallback)
 * - Nothing here ever consults revision once a pointer exists, and nothing
 *   here writes outside the checkpoint transaction that calls it.
 */
import type DatabaseType from 'better-sqlite3';

export interface LiveHead {
  stateId: string;
  revision: number;
  author: string;
  recordedAt: string;
}

/**
 * Heads = snapshots no other snapshot in the scope claims as parent, revision
 * ASC. (H3 additionally excludes retired snapshots — §4.4; not yet.)
 */
export function liveHeads(db: DatabaseType.Database, tenantId: string, scopeKey: string): LiveHead[] {
  return db.prepare(
    `SELECT s.state_id, s.revision, s.author, s.recorded_at
       FROM eng4_state_snapshots s
      WHERE s.tenant_id = ? AND s.scope_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM eng4_state_snapshots c
           WHERE c.tenant_id = s.tenant_id AND c.scope_key = s.scope_key
             AND c.parent_state_id = s.state_id)
      ORDER BY s.revision ASC`
  ).all(tenantId, scopeKey).map((r: any) => ({
    stateId: String(r.state_id),
    revision: Number(r.revision),
    author: String(r.author),
    recordedAt: String(r.recorded_at),
  }));
}

export type PointerReason = 'first-write' | 'advance' | 'reconcile';

/** The pointer row joined to its snapshot's revision (fixed-size, for asOf). */
export interface ScopePointer {
  stateId: string;
  revision: number;
  advancedAt: string;
  advancedBy: string;
  reason: PointerReason;
}

export function readScopePointer(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string
): ScopePointer | null {
  const row = db.prepare(
    `SELECT p.state_id, p.advanced_at, p.advanced_by, p.reason, s.revision
       FROM eng4_scope_current p
       JOIN eng4_state_snapshots s
         ON s.tenant_id = p.tenant_id AND s.scope_key = p.scope_key AND s.state_id = p.state_id
      WHERE p.tenant_id = ? AND p.scope_key = ?`
  ).get(tenantId, scopeKey) as any;
  if (!row) return null;
  return {
    stateId: String(row.state_id),
    revision: Number(row.revision),
    advancedAt: String(row.advanced_at),
    advancedBy: String(row.advanced_by),
    reason: row.reason as PointerReason,
  };
}

export type HeadSelection = 'empty-scope' | 'max-revision' | 'pointer' | 'invalid-designation';

export interface EffectiveHead {
  /** The current head, or null (empty scope / invalid designation). */
  head: LiveHead | null;
  selection: HeadSelection;
  pointer: ScopePointer | null;
  /** Every live head, revision ASC — the `heads` section's item source. */
  live: LiveHead[];
}

/**
 * §3.3 — the ONE resolver. Legacy `max-revision` exists only for scopes that
 * predate H1 and have never reconciled; it governs `working` only.
 * `invalid-designation` is an invariant failure (the pointer only ever moves
 * to a child of itself or to a reconcile snapshot, so a pointed head that is
 * not live cannot arise from correct operation): the caller sees head null
 * and the broken pointer row — repair is an explicit reconcile (H3), never a
 * fallback here (aad3973c finding 2).
 */
export function effectiveCurrentHead(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string
): EffectiveHead {
  const pointer = readScopePointer(db, tenantId, scopeKey);
  const live = liveHeads(db, tenantId, scopeKey);
  if (pointer === null) {
    if (live.length === 0) return { head: null, selection: 'empty-scope', pointer, live };
    return { head: live[live.length - 1], selection: 'max-revision', pointer, live };
  }
  const pointed = live.find((h) => h.stateId === pointer.stateId) ?? null;
  if (pointed) return { head: pointed, selection: 'pointer', pointer, live };
  return { head: null, selection: 'invalid-designation', pointer, live };
}

/**
 * §3.2a / §3.4 — run INSIDE the checkpoint transaction, immediately after the
 * snapshot insert. Returns what the pointer did, for callers/tests; the
 * checkpoint result shapes are unchanged by it.
 *
 *   no pointer AND first snapshot in scope → set to the new snapshot ('first-write')
 *   pointer exists AND parent == pointer
 *     AND the pointed head was LIVE immediately before this insert
 *                                          → move to the new snapshot ('advance')
 *   otherwise                              → unchanged (a branch was written,
 *                                            or the designation is invalid)
 *
 * The liveness precondition (codex-hythe review 186e1f91 HIGH 1): a pointer
 * that names a non-live snapshot is an INVALID designation (§3.3) and must
 * stay that way until an explicit reconcile with pointer CAS repairs it (§3.4,
 * §4.2). Without the check, a frozen legacy write extending the corrupt
 * pointer's target would silently "repair" the pointer onto its own branch.
 * "Live immediately before" = the pointed head had no child other than the
 * snapshot just inserted (H3 adds: and is not retired).
 *
 * A legacy scope (snapshots but no pointer) stays in legacy mode on ordinary
 * writes; only a reconcile (H3) gives it a pointer (§6.5).
 */
export function advancePointerAfterInsert(
  db: DatabaseType.Database,
  tenantId: string,
  scopeKey: string,
  inserted: { stateId: string; parentStateId: string | null; advancedBy: string; advancedAt: string }
): PointerReason | null {
  const pointer = db.prepare(
    `SELECT state_id FROM eng4_scope_current WHERE tenant_id = ? AND scope_key = ?`
  ).get(tenantId, scopeKey) as { state_id: string } | undefined;

  if (!pointer) {
    if (inserted.parentStateId !== null) return null; // legacy scope: stays undesignated
    db.prepare(
      `INSERT INTO eng4_scope_current (tenant_id, scope_key, state_id, advanced_at, advanced_by, reason)
       VALUES (?, ?, ?, ?, ?, 'first-write')`
    ).run(tenantId, scopeKey, inserted.stateId, inserted.advancedAt, inserted.advancedBy);
    return 'first-write';
  }
  if (String(pointer.state_id) !== inserted.parentStateId) return null; // branch: live, not current
  // Was the pointed head live immediately before this insert? Any OTHER child
  // means the designation was already invalid — fail closed, do not repair.
  const priorChildren = db.prepare(
    `SELECT COUNT(*) AS n FROM eng4_state_snapshots
      WHERE tenant_id = ? AND scope_key = ? AND parent_state_id = ? AND state_id != ?`
  ).get(tenantId, scopeKey, inserted.parentStateId, inserted.stateId) as { n: number };
  if (priorChildren.n > 0) return null; // invalid designation stays invalid until reconcile
  db.prepare(
    `UPDATE eng4_scope_current SET state_id = ?, advanced_at = ?, advanced_by = ?, reason = 'advance'
      WHERE tenant_id = ? AND scope_key = ?`
  ).run(inserted.stateId, inserted.advancedAt, inserted.advancedBy, tenantId, scopeKey);
  return 'advance';
}
