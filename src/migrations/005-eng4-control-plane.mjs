/**
 * Migration 005 — ENG-4 control plane (INERT — DO NOT EXECUTE).
 *
 * Additive-only DDL for the ENG-4 resume/checkpoint surface (spec: neural
 * entity engram-eng4-spec, frozen 2026-07-15; amended per engram-sol Track B
 * review 4179250c). This file is a reviewable migration PLAN shipped as
 * code: it exports the DDL and refuses direct execution. Execution is a
 * Phase-2 action, gated on review + owner GO + a fresh backup per
 * BACKUP-AND-RESTORE.md. Nothing here drops, rewrites, or migrates existing
 * rows; msg-detail cleanup is explicitly NOT part of this migration.
 *
 * Identity model (review #1/#2 fixes, executable proofs in
 * tests/contract-eng4-p0.test.ts):
 * - scope_key is NOT NULL and deterministic, derived from exact-resolved
 *   stable entity UUIDs (p:<uuid> | t:<uuid> | p:<uuid>|t:<uuid>). NULLs
 *   never participate in uniqueness (SQLite UNIQUE treats NULLs as distinct,
 *   which silently broke idempotency in the unamended draft).
 * - Scope identity is a ROW in eng4_scopes (deterministic-key CHECK);
 *   snapshots/loops/facts FK it and carry NO project/task columns, so
 *   mismatched or orphaned scope rows are structurally impossible.
 * - unique(scope_key, idempotency_key): retries replay, never duplicate.
 * - unique(scope_key, revision): fetch-by-revision is deterministic even
 *   with concurrent heads; branches stay distinguishable via parent links.
 * - Parents can never reference a snapshot from another scope (trigger).
 */

export const DDL = [
  // 0. FK enforcement is a per-connection pragma in SQLite; the runtime MUST
  // set it on every connection, OUTSIDE any transaction, BEFORE applying the
  // DDL below atomically and idempotently (review b2e6fc7c #6). Only the
  // extracted repo's isolated DB may ever be targeted — never the live DB.
  `PRAGMA foreign_keys = ON`,

  // 1. Scope registry (reviews e0d81d4d #3 + b2e6fc7c #3): scope identity is
  // a TENANT-OWNED ROW. Composite PK (tenant_id, scope_key) makes every
  // dependent row tenant-isolated: knowing another tenant's scopeKey grants
  // nothing. The deterministic-key CHECK still kills mismatched keys.
  `CREATE TABLE IF NOT EXISTS eng4_scopes (
     tenant_id  TEXT NOT NULL,
     scope_key  TEXT NOT NULL,
     project_id TEXT,
     task_id    TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (tenant_id, scope_key),
     CHECK (project_id IS NOT NULL OR task_id IS NOT NULL),
     CHECK (scope_key = CASE
       WHEN task_id IS NULL THEN 'p:' || project_id
       WHEN project_id IS NULL THEN 't:' || task_id
       ELSE 'p:' || project_id || '|t:' || task_id
     END)
   )`,

  // 2. Checkpoint snapshots (immutable rows). Tenant + scope identity live
  // ONLY in the composite FK. ONE AUTHOR RULE (5868b61b #2): author is the
  // exact opaque agent principal; asserted_agent_id preserves the raw asserted
  // caller id as audit metadata only. request_fingerprint stores the
  // operation-idempotency fingerprint (canonical author + CAS position +
  // content); content_hash stays the resource-content hash — distinct.
  `CREATE TABLE IF NOT EXISTS eng4_state_snapshots (
     tenant_id       TEXT NOT NULL,
     state_id        TEXT NOT NULL,
     scope_key       TEXT NOT NULL,
     revision        INTEGER NOT NULL,
     parent_state_id TEXT,
     content_hash        TEXT NOT NULL,
     request_fingerprint TEXT NOT NULL,
     idempotency_key     TEXT NOT NULL,
     author              TEXT NOT NULL,
     asserted_agent_id   TEXT NOT NULL,
     recorded_at         TEXT NOT NULL DEFAULT (datetime('now')),
     state_json          TEXT NOT NULL,
     PRIMARY KEY (tenant_id, state_id),
     FOREIGN KEY (tenant_id, scope_key) REFERENCES eng4_scopes(tenant_id, scope_key),
     FOREIGN KEY (tenant_id, parent_state_id) REFERENCES eng4_state_snapshots(tenant_id, state_id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_snapshots_idempotency
     ON eng4_state_snapshots (tenant_id, scope_key, idempotency_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_snapshots_revision
     ON eng4_state_snapshots (tenant_id, scope_key, revision)`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_snapshots_parent
     ON eng4_state_snapshots (tenant_id, parent_state_id)`,
  // Cross-tenant parents are structurally impossible (composite parent FK);
  // this trigger adds the same-SCOPE guarantee, comparing columns directly.
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_parent_scope
     BEFORE INSERT ON eng4_state_snapshots
     WHEN NEW.parent_state_id IS NOT NULL
       AND (SELECT scope_key FROM eng4_state_snapshots
             WHERE tenant_id = NEW.tenant_id AND state_id = NEW.parent_state_id)
           IS NOT NEW.scope_key
     BEGIN
       SELECT RAISE(ABORT, 'eng4: parent_state_id must belong to the same tenant and scope_key');
     END`,

  // 3. Content plane: full payloads by hash; the graph/census never counts
  // these, embeddings never index them. TWO structural invariants (reviews
  // e0d81d4d #4 + 2a88cecb #3): body must actually BE a blob — SQLite type
  // affinity would otherwise accept TEXT, where length() counts CHARACTERS
  // (the 'é' bypass: 1 char, 2 bytes) — and byte_length must equal the true
  // byte count.
  // Payloads are TENANT-OWNED (b2e6fc7c #3): PK (tenant_id, content_hash),
  // so cross-tenant knowledge of a hash/URI cannot read another tenant's
  // bytes; dedup happens within a tenant only — a deliberate isolation>dedup
  // trade.
  `CREATE TABLE IF NOT EXISTS eng4_payloads (
     tenant_id    TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     kind         TEXT NOT NULL,
     media_type   TEXT NOT NULL,
     encoding     TEXT,
     byte_length  INTEGER NOT NULL CHECK (byte_length = length(body)),
     recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
     body         BLOB NOT NULL CHECK (typeof(body) = 'blob'),
     PRIMARY KEY (tenant_id, content_hash)
   )`,

  // 4. Explicit, per-agent handoff acknowledgement.
  // CONTRACT (review 07b3906e #5): the ack write MUST be preceded, in the
  // SAME transaction, by a same-tenant existence check against
  // session_handoffs — arbitrary/future handoff IDs cannot be pre-acked.
  // (A cross-table FK is not used: session_handoffs is a legacy table that
  // does not exist in bare test databases.)
  `CREATE TABLE IF NOT EXISTS eng4_handoff_acks (
     tenant_id   TEXT NOT NULL,
     handoff_id  TEXT NOT NULL,
     agent_id    TEXT NOT NULL,
     acked_at    TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (tenant_id, handoff_id, agent_id)
   )`,

  // 5. Structured open loops (a resume SECTION in v1 — no alias tool).
  `CREATE TABLE IF NOT EXISTS eng4_open_loops (
     tenant_id     TEXT NOT NULL,
     loop_id       TEXT NOT NULL,
     scope_key     TEXT NOT NULL,
     owner         TEXT NOT NULL,
     status        TEXT NOT NULL CHECK (status IN ('open','blocked','closed')),
     opened_at     TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
     due_at        TEXT,
     blocked_on    TEXT,
     next_action   TEXT NOT NULL,
     close_json    TEXT,
     revision      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, loop_id),
     FOREIGN KEY (tenant_id, scope_key) REFERENCES eng4_scopes(tenant_id, scope_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_loops_status
     ON eng4_open_loops (tenant_id, status, scope_key)`,

  // 6. Facts control plane (review #3): typed subject/predicate/object
  // assertions with status lifecycle; refs live in a side table so a fact can
  // carry evidence, sources, and contradiction links without JSON blobs.
  // scope_key is FK'd (review e0d81d4d #5) — no fact without a scope row.
  // CONTRADICTS DEFERRED-RESOLUTION RULE (documented, tested): a
  // ref_kind='contradicts' ref MAY cite a fact_id not (yet) present — cross-
  // agent contradiction is often recorded before the other fact syncs.
  // Dangling contradicts refs are LEGAL AT WRITE and surface at read time as
  // unresolved contradictions; they are never silently dropped, and readers
  // must render them as "unresolved", not as errors.
  `CREATE TABLE IF NOT EXISTS eng4_facts (
     tenant_id    TEXT NOT NULL,
     fact_id      TEXT NOT NULL,
     scope_key    TEXT NOT NULL,
     subject      TEXT NOT NULL,
     predicate    TEXT NOT NULL,
     object       TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (status IN ('asserted','verified','disputed','superseded')),
     author       TEXT NOT NULL,
     recorded_at  TEXT NOT NULL DEFAULT (datetime('now')),
     effective_at TEXT,
     PRIMARY KEY (tenant_id, fact_id),
     FOREIGN KEY (tenant_id, scope_key) REFERENCES eng4_scopes(tenant_id, scope_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_facts_scope
     ON eng4_facts (tenant_id, scope_key, status)`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_facts_subject
     ON eng4_facts (tenant_id, scope_key, subject, predicate)`,
  `CREATE TABLE IF NOT EXISTS eng4_fact_refs (
     tenant_id TEXT NOT NULL,
     fact_id   TEXT NOT NULL,
     ref_kind  TEXT NOT NULL CHECK (ref_kind IN ('evidence','source','contradicts')),
     ref       TEXT NOT NULL,
     PRIMARY KEY (tenant_id, fact_id, ref_kind, ref),
     FOREIGN KEY (tenant_id, fact_id) REFERENCES eng4_facts(tenant_id, fact_id)
   )`,

  // 6b. Per-snapshot change ledger (2026-09-03, field-report response PR A):
  // which fact/loop row each factChanges[i] / loopChanges[i] materialized
  // to, and whether the row was CREATED by that checkpoint. Written in the
  // checkpoint transaction so idempotent-replay can return the SAME ids the
  // original write did without recomputation. Result-side only: it is NOT
  // part of the canonical envelope, so content hashes and request
  // fingerprints are untouched. Snapshots recorded before this table
  // existed have no rows; replay reports changes=null for them when the
  // envelope carried changes (never guesses).
  `CREATE TABLE IF NOT EXISTS eng4_snapshot_changes (
     tenant_id TEXT NOT NULL,
     state_id  TEXT NOT NULL,
     kind      TEXT NOT NULL CHECK (kind IN ('fact','loop')),
     ordinal   INTEGER NOT NULL CHECK (ordinal >= 0),
     change_id TEXT NOT NULL,
     created   INTEGER NOT NULL CHECK (created IN (0,1)),
     PRIMARY KEY (tenant_id, state_id, kind, ordinal),
     FOREIGN KEY (tenant_id, state_id) REFERENCES eng4_state_snapshots(tenant_id, state_id)
   )`,
  // Integrity binding for the ledger: sha256 of the canonical (RFC 8785)
  // changes object, stored on the snapshot row in the same transaction.
  // Replay recomputes from the ledger rows and fails CLOSED on mismatch,
  // partial rows, or non-contiguous ordinals. NULL + zero rows is accepted as
  // a pre-ledger snapshot ONLY on a matched v1 replay; under resultVersion=2
  // (fingerprint-bound, hence ledger-aware) it is corruption and fails closed.
  // Additive, duplicate-column-guarded like the ai_messages ALTERs.
  `ALTER TABLE eng4_state_snapshots ADD COLUMN changes_hash TEXT`,

  // 8. ENG-4 H1 — advancing current-head pointer (design note
  // docs/design/ENG4-HEAD-RECONCILIATION.md §3, merged 3429000).
  //
  // 8a. Referenced target for every same-scope composite FK: a pointer (and,
  // in later H-series steps, retirements/merge inputs/versions) can only name
  // a snapshot that is in the SAME tenant AND scope by structure, never by
  // convention (aad3973c finding 1).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_snapshots_scope_state
     ON eng4_state_snapshots (tenant_id, scope_key, state_id)`,
  // 8b. Snapshots are immutable. Exactly ONE post-insert transition is legal:
  // PR #8's in-transaction digest write (changes_hash NULL → NOT NULL) with
  // every other column byte-identical. Every other UPDATE, and every DELETE,
  // is rejected (19826044 finding 3). The column list below MUST equal
  // PRAGMA table_info(eng4_state_snapshots); a contract test asserts it, so a
  // future column cannot slip past the trigger.
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_immutable
     BEFORE UPDATE ON eng4_state_snapshots
     WHEN NOT (
          OLD.changes_hash IS NULL AND NEW.changes_hash IS NOT NULL
      AND NEW.tenant_id = OLD.tenant_id AND NEW.state_id = OLD.state_id
      AND NEW.scope_key = OLD.scope_key AND NEW.revision = OLD.revision
      AND NEW.parent_state_id IS OLD.parent_state_id
      AND NEW.content_hash = OLD.content_hash AND NEW.request_fingerprint = OLD.request_fingerprint
      AND NEW.idempotency_key = OLD.idempotency_key AND NEW.author = OLD.author
      AND NEW.asserted_agent_id IS OLD.asserted_agent_id AND NEW.recorded_at = OLD.recorded_at
      AND NEW.state_json = OLD.state_json)
     BEGIN SELECT RAISE(ABORT, 'eng4: snapshots are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_snapshots_no_delete
     BEFORE DELETE ON eng4_state_snapshots
     BEGIN SELECT RAISE(ABORT, 'eng4: snapshots are never deleted'); END`,
  // 8c. The current-head POINTER (one row per scope). It names the current
  // head ITSELF — not an anchor of a lineage — and it moves in exactly three
  // ways (§3.2a/§3.4/§4): the first write in a scope sets it; a write whose
  // parent IS the pointed head advances it; a reconcile (H3) sets it. A write
  // from any other parent keeps its branch but never moves the pointer.
  // The composite FK makes (scope P, state from scope Q) unrepresentable.
  `CREATE TABLE IF NOT EXISTS eng4_scope_current (
     tenant_id   TEXT NOT NULL,
     scope_key   TEXT NOT NULL,
     state_id    TEXT NOT NULL,
     advanced_at TEXT NOT NULL,
     advanced_by TEXT NOT NULL,
     reason      TEXT NOT NULL CHECK (reason IN ('first-write','advance','reconcile')),
     PRIMARY KEY (tenant_id, scope_key),
     FOREIGN KEY (tenant_id, scope_key)           REFERENCES eng4_scopes(tenant_id, scope_key),
     FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,

  // 9. ENG-4 H2 — version foundation (design §6.2, merged 3429000).
  //
  // 9a. Same-scope parent targets: a fact/loop belongs to exactly one scope,
  // so a version in scope P can never reference a fact owned by scope Q.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_facts_scope_id
     ON eng4_facts (tenant_id, scope_key, fact_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_eng4_loops_scope_id
     ON eng4_open_loops (tenant_id, scope_key, loop_id)`,
  // 9b. Append-only fact/loop versions keyed by the writing snapshot AND the
  // change ordinal (= eng4_snapshot_changes (state_id, kind, ordinal)). The
  // in-place tables stay the frozen v1/v2 last-writer-wins view; versions are
  // the v3 view (H4 reads them; H2 only writes and verifies them).
  `CREATE TABLE IF NOT EXISTS eng4_fact_versions (
     tenant_id    TEXT NOT NULL,
     scope_key    TEXT NOT NULL,
     fact_id      TEXT NOT NULL,
     state_id     TEXT NOT NULL,
     ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
     subject      TEXT NOT NULL,
     predicate    TEXT NOT NULL,
     object       TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (status IN ('asserted','verified','disputed','superseded')),
     effective_at TEXT,
     refs_json    TEXT NOT NULL,
     author       TEXT NOT NULL,
     recorded_at  TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, fact_id, state_id, ordinal),
     FOREIGN KEY (tenant_id, scope_key, fact_id)  REFERENCES eng4_facts(tenant_id, scope_key, fact_id),
     FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_fact_versions_immutable
     BEFORE UPDATE ON eng4_fact_versions
     BEGIN SELECT RAISE(ABORT, 'eng4: fact versions are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_fact_versions_no_delete
     BEFORE DELETE ON eng4_fact_versions
     BEGIN SELECT RAISE(ABORT, 'eng4: fact versions are append-only'); END`,
  `CREATE TABLE IF NOT EXISTS eng4_loop_versions (
     tenant_id    TEXT NOT NULL,
     scope_key    TEXT NOT NULL,
     loop_id      TEXT NOT NULL,
     state_id     TEXT NOT NULL,
     ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
     owner        TEXT NOT NULL,
     status       TEXT NOT NULL CHECK (status IN ('open','blocked','closed')),
     next_action  TEXT NOT NULL,
     due_at       TEXT,
     blocked_on   TEXT,
     close_json   TEXT,
     author       TEXT NOT NULL,
     recorded_at  TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, loop_id, state_id, ordinal),
     FOREIGN KEY (tenant_id, scope_key, loop_id)  REFERENCES eng4_open_loops(tenant_id, scope_key, loop_id),
     FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_loop_versions_immutable
     BEFORE UPDATE ON eng4_loop_versions
     BEGIN SELECT RAISE(ABORT, 'eng4: loop versions are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_loop_versions_no_delete
     BEFORE DELETE ON eng4_loop_versions
     BEGIN SELECT RAISE(ABORT, 'eng4: loop versions are append-only'); END`,
  // 9c. Coverage manifest: exactly one explicit disposition per digest-bound
  // ledger tuple, so an intentionally unversioned historical change is
  // distinguishable from a deleted or missing version row. `source` records
  // whether the row was emitted by the writer that KNEW the materialized
  // result ('write') or reconstructed by the H2 backfill ('backfill'); only a
  // backfill may declare a tuple unversioned, and only for the one reason the
  // design names (a historical loop update that omitted `owner` whose exact
  // inherited value cannot be proven from immutable data).
  `CREATE TABLE IF NOT EXISTS eng4_version_coverage (
     tenant_id   TEXT NOT NULL,
     scope_key   TEXT NOT NULL,
     state_id    TEXT NOT NULL,
     kind        TEXT NOT NULL CHECK (kind IN ('fact','loop')),
     ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
     change_id   TEXT NOT NULL,
     disposition TEXT NOT NULL CHECK (disposition IN ('materialized','unversioned')),
     reason      TEXT CHECK (reason IS NULL OR reason IN ('pre-h2-inherited-owner')),
     source      TEXT NOT NULL CHECK (source IN ('write','backfill')),
     CHECK ((disposition = 'materialized' AND reason IS NULL) OR
            (disposition = 'unversioned' AND reason IS NOT NULL AND source = 'backfill')),
     PRIMARY KEY (tenant_id, state_id, kind, ordinal),
     FOREIGN KEY (tenant_id, state_id, kind, ordinal)
       REFERENCES eng4_snapshot_changes(tenant_id, state_id, kind, ordinal),
     FOREIGN KEY (tenant_id, scope_key, state_id)
       REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_coverage_immutable
     BEFORE UPDATE ON eng4_version_coverage
     BEGIN SELECT RAISE(ABORT, 'eng4: version coverage is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_coverage_no_delete
     BEFORE DELETE ON eng4_version_coverage
     BEGIN SELECT RAISE(ABORT, 'eng4: version coverage is append-only'); END`,
  // 9d. Immutable H2 cutover evidence (independent review of PR #12,
  // findings 2 and 3). The backfill runs at every schema apply, so it needs
  // to know, from rows it cannot infer from mutable state, (a) which
  // snapshots' coverage came from a backfill and (b) up to which revision a
  // scope is already covered.
  //  - eng4_version_backfills: one append-only row per BACKFILLED snapshot.
  //    The verifier derives the expected coverage `source` from it (row
  //    present → 'backfill', absent → 'write'), so relabelling a backfilled
  //    unversioned tuple as a writer's materialized value is detected.
  //  - eng4_version_cutover: append-only per-scope "covered through this
  //    revision" marks (effective = MAX). An uncovered ledger-bound snapshot
  //    at or below the mark is erased coverage → the apply refuses; only
  //    snapshots above it (written by a pre-H2 binary after a rollback) are
  //    legitimately backfilled.
  `CREATE TABLE IF NOT EXISTS eng4_version_backfills (
     tenant_id  TEXT NOT NULL,
     scope_key  TEXT NOT NULL,
     state_id   TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, scope_key, state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_backfills_immutable
     BEFORE UPDATE ON eng4_version_backfills
     BEGIN SELECT RAISE(ABORT, 'eng4: backfill marks are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_backfills_no_delete
     BEFORE DELETE ON eng4_version_backfills
     BEGIN SELECT RAISE(ABORT, 'eng4: backfill marks are append-only'); END`,
  `CREATE TABLE IF NOT EXISTS eng4_version_cutover (
     tenant_id        TEXT NOT NULL,
     scope_key        TEXT NOT NULL,
     through_revision INTEGER NOT NULL CHECK (through_revision >= 1),
     applied_at       TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, through_revision),
     FOREIGN KEY (tenant_id, scope_key) REFERENCES eng4_scopes(tenant_id, scope_key)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_cutover_immutable
     BEFORE UPDATE ON eng4_version_cutover
     BEGIN SELECT RAISE(ABORT, 'eng4: cutover marks are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_version_cutover_no_delete
     BEFORE DELETE ON eng4_version_cutover
     BEGIN SELECT RAISE(ABORT, 'eng4: cutover marks are append-only'); END`,
  // 9e. Predecessor lookups (inherited-owner provenance) scan the ledger by
  // change id.
  `CREATE INDEX IF NOT EXISTS idx_eng4_changes_by_id
     ON eng4_snapshot_changes (tenant_id, kind, change_id)`,

  // 10. ENG-4 H3 — atomic, integrity-bound reconciliation (design §4, §6.3).
  // A reconcile snapshot names the exact live-head set and the pointer (both
  // CAS), chooses one survivor (its parent), RETIRES the other heads and
  // records them as merge inputs, and resolves every divergent terminal
  // value causally. Snapshots are never deleted: retirement is a recorded
  // act. All three tables are same-scope by composite FK and append-only by
  // trigger; the envelope of the reconcile snapshot carries the normalized
  // reconciliation record, so the hash-verified payload — not these rows —
  // is the authority and replay/resume verify exact parity against it.
  `CREATE TABLE IF NOT EXISTS eng4_snapshot_merge_inputs (
     tenant_id      TEXT NOT NULL,
     scope_key      TEXT NOT NULL,
     state_id       TEXT NOT NULL,
     input_state_id TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, state_id, input_state_id),
     FOREIGN KEY (tenant_id, scope_key, state_id)       REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, scope_key, input_state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_merge_inputs_immutable
     BEFORE UPDATE ON eng4_snapshot_merge_inputs
     BEGIN SELECT RAISE(ABORT, 'eng4: merge inputs are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_merge_inputs_no_delete
     BEFORE DELETE ON eng4_snapshot_merge_inputs
     BEGIN SELECT RAISE(ABORT, 'eng4: merge inputs are append-only'); END`,
  `CREATE TABLE IF NOT EXISTS eng4_head_retirements (
     tenant_id           TEXT NOT NULL,
     scope_key           TEXT NOT NULL,
     state_id            TEXT NOT NULL,
     retired_by_state_id TEXT NOT NULL,
     retired_at          TEXT NOT NULL,
     retired_by          TEXT NOT NULL,
     reason              TEXT NOT NULL,
     PRIMARY KEY (tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, scope_key, state_id)            REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, scope_key, retired_by_state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_retirements_by
     ON eng4_head_retirements (tenant_id, scope_key, retired_by_state_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_retirements_immutable
     BEFORE UPDATE ON eng4_head_retirements
     BEGIN SELECT RAISE(ABORT, 'eng4: head retirements are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_retirements_no_delete
     BEFORE DELETE ON eng4_head_retirements
     BEGIN SELECT RAISE(ABORT, 'eng4: head retirements are append-only'); END`,
  // Resolution of one divergent terminal change (kind, id, its snapshot) by
  // one reconcile snapshot on the accepted lineage. `accept` MUST name the
  // reconcile's own re-asserting change (FK into the ledger); `reject` has
  // no change. Both are bound into the reconcile payload as well.
  // The resolving snapshot is PART OF THE KEY (codex-hythe review of PR #13,
  // finding 3): a resolution only counts while its resolver is on the
  // accepted lineage, so after a survivor switch moves that resolver off the
  // lineage the same terminal must be resolvable again by a later reconcile.
  `CREATE TABLE IF NOT EXISTS eng4_divergence_resolutions (
     tenant_id            TEXT NOT NULL,
     scope_key            TEXT NOT NULL,
     kind                 TEXT NOT NULL CHECK (kind IN ('fact','loop')),
     change_id            TEXT NOT NULL,
     divergent_state_id   TEXT NOT NULL,
     resolved_by_state_id TEXT NOT NULL,
     decision             TEXT NOT NULL CHECK (decision IN ('accept','reject')),
     accepted_ordinal     INTEGER,
     CHECK ((decision = 'accept' AND accepted_ordinal IS NOT NULL) OR
            (decision = 'reject' AND accepted_ordinal IS NULL)),
     PRIMARY KEY (tenant_id, scope_key, kind, change_id, divergent_state_id, resolved_by_state_id),
     FOREIGN KEY (tenant_id, scope_key, divergent_state_id)   REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, scope_key, resolved_by_state_id) REFERENCES eng4_state_snapshots(tenant_id, scope_key, state_id),
     FOREIGN KEY (tenant_id, resolved_by_state_id, kind, accepted_ordinal)
       REFERENCES eng4_snapshot_changes(tenant_id, state_id, kind, ordinal)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_eng4_resolutions_by
     ON eng4_divergence_resolutions (tenant_id, scope_key, resolved_by_state_id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_resolutions_immutable
     BEFORE UPDATE ON eng4_divergence_resolutions
     BEGIN SELECT RAISE(ABORT, 'eng4: divergence resolutions are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_eng4_resolutions_no_delete
     BEFORE DELETE ON eng4_divergence_resolutions
     BEGIN SELECT RAISE(ABORT, 'eng4: divergence resolutions are append-only'); END`,

  // 7. ai_messages scoping — additive columns + index (A6). SQLite ALTER ADD
  // COLUMN is cheap and non-rewriting; existing rows get NULLs (= unscoped).
  `ALTER TABLE ai_messages ADD COLUMN project_id TEXT`,
  `ALTER TABLE ai_messages ADD COLUMN task_id TEXT`,
  `ALTER TABLE ai_messages ADD COLUMN thread_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_ai_messages_scope
     ON ai_messages (project_id, task_id, thread_id)`,
];

/**
 * Statements safe to apply to a bare test database (everything except the
 * ai_messages ALTERs, which require the live ai_messages table). Used by the
 * executable invariant tests; keep in sync with DDL ordering above.
 */
export const DDL_STANDALONE = DDL.filter((s) => !s.startsWith('ALTER TABLE ai_messages') && !s.includes('idx_ai_messages_scope'));

// INERT GUARD: this migration is a plan, not an executable, until Phase 2.
// Importing DDL (for review/tests) is safe; direct execution refuses. The
// guard is removed in a dedicated, reviewed commit — never edited around.
// Review gate: engram-sol approval + owner GO + fresh backup per
// BACKUP-AND-RESTORE.md.
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error(
    '005-eng4-control-plane: INERT scaffold migration. Execution is gated on ' +
      'Phase-2 review (engram-sol) + owner GO + fresh backup per BACKUP-AND-RESTORE.md. Refusing to run.'
  );
  process.exit(2);
}
