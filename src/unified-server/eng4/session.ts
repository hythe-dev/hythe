/**
 * ENG-4 session lifecycle wrappers (sub-step 2(d), authorized b21bccde) —
 * TARGET modules only, nothing MCP-registered.
 *
 * begin_session is an OPTIONAL wrapper over resume, never an alternate
 * bootstrap primitive (b2e6fc7c #2): it NEVER auto-consumes handoffs —
 * acknowledgement happens ONLY for the ids the caller explicitly lists in
 * ackHandoffIds, owned by the CANONICAL agent family. end_session is the
 * corresponding thin wrapper over checkpoint.
 *
 * Ack fail-closed contract (07b3906e #5): the ack write is preceded, in
 * the SAME transaction, by a same-tenant existence check against
 * session_handoffs — arbitrary/future/foreign-tenant handoff ids cannot
 * be pre-acked, and one bad id rolls back the whole batch.
 */
import type DatabaseType from 'better-sqlite3';
import type { BeginSessionWrapperParams, CheckpointParams, CheckpointResult, ResumeBundle } from './contracts.js';
import { performCheckpoint } from './checkpoint.js';
import { performResume, type ResumeDirectory } from './resume.js';

export class HandoffAckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffAckError';
  }
}

/** Explicit, per-agent (canonical family), per-tenant handoff acks. Atomic. */
export function ackHandoffs(
  db: DatabaseType.Database,
  tenantId: string,
  canonicalAgentId: string,
  handoffIds: readonly string[]
): { acked: number } {
  const exists = db.prepare(
    `SELECT id FROM session_handoffs WHERE tenant_id = ? AND id = ?`
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO eng4_handoff_acks (tenant_id, handoff_id, agent_id) VALUES (?, ?, ?)`
  );
  const run = db.transaction(() => {
    for (const handoffId of handoffIds) {
      if (!exists.get(tenantId, handoffId)) {
        throw new HandoffAckError(`eng4: handoff ${handoffId} does not exist in this tenant`);
      }
      insert.run(tenantId, handoffId, canonicalAgentId);
    }
    return handoffIds.length;
  });
  return { acked: run() };
}

/** resume + explicit acks. Reading NEVER consumes; only listed ids ack. */
export function performBeginSession(
  db: DatabaseType.Database,
  directory: ResumeDirectory,
  tenantId: string,
  params: BeginSessionWrapperParams
): ResumeBundle {
  if (params.ackHandoffIds?.length) {
    const canonical = directory.resolveCanonicalAgent(params.agentId).canonical;
    ackHandoffs(db, tenantId, canonical, params.ackHandoffIds);
  }
  return performResume(db, directory, tenantId, {
    agentId: params.agentId,
    scope: params.scope,
    budget: params.budget,
  });
}

/** Thin delegation — end_session IS checkpoint. */
export function performEndSession(
  db: DatabaseType.Database,
  directory: ResumeDirectory,
  tenantId: string,
  params: CheckpointParams
): CheckpointResult {
  return performCheckpoint(db, directory, tenantId, params);
}
