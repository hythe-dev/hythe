/**
 * ENG-4 resume runtime (sub-step 2(c), authorized by engram-sol 5866fa85
 * on base 52656c6) — the read primitive behind the frozen
 * RESUME_OUTPUT_SCHEMA. READ-ONLY by construction: every statement here is
 * a SELECT — resume never marks messages read, never consumes handoffs,
 * never writes.
 *
 * Contract invariants implemented (executable-tested):
 * - Coverage CLOSEDNESS over all seven sections on every response;
 *   contentComplete=true ⇒ includedCount===totalCount ∧ omittedReason=none
 *   ∧ nextCursor=null. Silent trimming is failure — budget omissions are
 *   accounted with omittedReason='budget' and a cursor to the remainder.
 * - totalTokenEstimate NEVER exceeds the requested budget (items are
 *   admitted only while they fit).
 * - Definition vs state (A4): `definition` is charter/creation prose from
 *   the scope entity; `working` is the CURRENT snapshot state ONLY — an
 *   absent snapshot is null + asOf.stale=true + asOf.stateId=null, never
 *   founding observations (legacy repro #2).
 * - asOf.conflicts lists ALL live heads when the state has forked (A5);
 *   the current view follows the max-revision head, divergence stays
 *   visible, never auto-resolved.
 * - Unresolved/ambiguous scope returns EXPLICIT resolvedScope nulls (with
 *   candidates when ambiguous) and empty accounted sections — never a
 *   silently-empty bundle (legacy repro #1) and never a synthesized key.
 * - Tenant isolation: every query is tenant-keyed; tenantId comes from the
 *   server-side request context, never from the caller.
 *
 * DEFERRED to 2(d) (held gates): engram:// resource FETCH (handles are
 * emitted as values here), handoff items + ackedByMe (needs the ack write
 * path), oversized-body handle substitution, begin_session wrapper.
 */
import type DatabaseType from 'better-sqlite3';
import type {
  ContentHandle,
  CurrentFact,
  InboxItem,
  OpenLoop,
  ResumeBundle,
  ResumeParams,
  ResumeSectionName,
  SectionCoverage,
  WorkingState,
} from './contracts.js';
import { liveHeads } from './checkpoint.js';
import { buildHandoffUri, buildMessageUri } from './resource.js';
import { resolveScope, type EntityDirectory } from './resolver.js';

/** Bodies above this inline as null + verifiable handle instead (2(d)). */
export const MAX_INLINE_MESSAGE_BODY_CHARS = 2000;

/** Narrow read surface resume needs beyond the resolver's EntityDirectory. */
export interface ResumeDirectory extends EntityDirectory {
  /** Charter/creation prose for an entity — NEVER current state. */
  getEntityDefinition(entityId: string, tenantId: string): string | null;
}

const SECTION_ORDER: readonly ResumeSectionName[] = [
  'working', 'openLoops', 'messages', 'currentFacts', 'decisions', 'evidence', 'pointers',
];

/** Deliberately coarse, deterministic estimator (chars/4). */
function tokenEstimate(item: unknown): number {
  return Math.ceil(JSON.stringify(item).length / 4);
}

interface Cursor {
  s: ResumeSectionName;
  o: number;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (SECTION_ORDER.includes(parsed?.s) && Number.isInteger(parsed?.o) && parsed.o >= 0) {
      return { s: parsed.s, o: parsed.o };
    }
  } catch { /* fall through — malformed cursors fail closed below */ }
  throw new Error('eng4: malformed resume cursor');
}

function emptyCoverage(omittedReason: SectionCoverage['omittedReason'], totalCount = 0): SectionCoverage {
  const contentComplete = omittedReason === 'none';
  return {
    includedCount: 0,
    totalCount,
    contentComplete,
    omittedReason,
    nextCursor: null,
    tokenEstimate: 0,
  };
}

export function performResume(
  db: DatabaseType.Database,
  directory: ResumeDirectory,
  tenantId: string,
  params: ResumeParams
): ResumeBundle {
  const resolved = resolveScope(directory, tenantId, params.scope);
  const assembledAt = new Date().toISOString();

  const coverageOf = (entries: Array<[ResumeSectionName, SectionCoverage]>) =>
    Object.fromEntries(entries) as Record<ResumeSectionName, SectionCoverage>;

  if (!resolved.scopeKey) {
    // Fail-closed resolution: explicit nulls (+ candidates when ambiguous),
    // all sections empty but ACCOUNTED — never a silently-empty bundle.
    return {
      schemaVersion: 1,
      resolvedScope: resolved,
      asOf: { assembledAt, stateId: null, revision: null, stateAgeSec: null, stale: true, conflicts: [] },
      definition: null,
      working: null,
      openLoops: [],
      messages: [],
      currentFacts: [],
      decisions: [],
      evidence: [],
      pointers: [],
      coverage: {
        ...coverageOf(SECTION_ORDER.map((s) => [s, emptyCoverage('none')])),
        totalTokenEstimate: 0,
        budget: params.budget,
      },
    };
  }
  const scopeKey = resolved.scopeKey;

  // --- Current state: max-revision live head; forks surface as conflicts.
  const heads = liveHeads(db, tenantId, scopeKey);
  const current = heads.length > 0 ? heads[heads.length - 1] : null; // heads are revision-ASC
  const currentRow = current
    ? db.prepare(
        `SELECT state_id, revision, recorded_at, state_json, content_hash
           FROM eng4_state_snapshots WHERE tenant_id = ? AND state_id = ?`
      ).get(tenantId, current.stateId) as any
    : null;

  const working: WorkingState | null = currentRow ? JSON.parse(currentRow.state_json) : null;
  const definition = resolved.projectId
    ? directory.getEntityDefinition(resolved.projectId, tenantId)
    : resolved.taskId
      ? directory.getEntityDefinition(resolved.taskId, tenantId)
      : null;

  // --- Section item sources (all SELECT-only).
  const scopeRow = db.prepare(
    `SELECT project_id, task_id FROM eng4_scopes WHERE tenant_id = ? AND scope_key = ?`
  ).get(tenantId, scopeKey) as { project_id: string | null; task_id: string | null } | undefined;

  const openLoops: OpenLoop[] = (db.prepare(
    `SELECT * FROM eng4_open_loops WHERE tenant_id = ? AND scope_key = ? ORDER BY updated_at DESC, loop_id ASC`
  ).all(tenantId, scopeKey) as any[]).map((r) => {
    const loop: OpenLoop = {
      loopId: r.loop_id,
      scopeKey: r.scope_key,
      projectId: scopeRow?.project_id ?? null,
      taskId: scopeRow?.task_id ?? null,
      owner: r.owner,
      status: r.status,
      openedAt: r.opened_at,
      updatedAt: r.updated_at,
      nextAction: r.next_action,
      revision: r.revision,
    };
    if (r.due_at) loop.dueAt = r.due_at;
    if (r.blocked_on) loop.blockedOn = r.blocked_on;
    if (r.close_json) loop.closeEvent = JSON.parse(r.close_json);
    return loop;
  });

  const resolvedAgentId = directory.resolveCanonicalAgent(params.agentId, tenantId).canonical;
  if (!resolvedAgentId) throw new Error('Invalid agent identity');

  // Scoped messages only — TENANT-KEYED first (sol review 95eba75a: entity
  // UUIDs are not tenant secrets; without the tenant key, knowing another
  // tenant's project UUID would leak its scoped messages), then exact-
  // recipient-keyed and matched on the resolved entity UUID columns.
  // Oversized bodies stay REACHABLE: null body + reference handle (2(d)).
  const messageItems: InboxItem[] = (db.prepare(
    `SELECT id, from_agent, content, priority, created_at FROM ai_messages
      WHERE tenant_id = ? AND to_agent = ?
        AND ((project_id IS NOT NULL AND project_id = ?) OR (task_id IS NOT NULL AND task_id = ?))
      ORDER BY created_at DESC, id ASC`
  ).all(tenantId, resolvedAgentId, resolved.projectId, resolved.taskId) as any[]).map((r) => {
    const body = String(r.content ?? '');
    const base = {
      itemType: 'message' as const,
      messageId: String(r.id),
      from: String(r.from_agent ?? ''),
      priority: (['low', 'normal', 'high', 'urgent'].includes(r.priority) ? r.priority : 'normal') as 'low' | 'normal' | 'high' | 'urgent',
      recordedAt: String(r.created_at ?? ''),
    };
    return body.length > MAX_INLINE_MESSAGE_BODY_CHARS
      ? { ...base, body: null, handle: { kind: 'message' as const, uri: buildMessageUri(scopeKey, resolvedAgentId, String(r.id)) } }
      : { ...base, body, handle: null };
  });

  // Handoffs travel in the SAME section with the SAME accounting (A6).
  // Reading NEVER consumes (consumed_at untouched — this is a SELECT);
  // ackedByMe is THIS caller's exact opaque-principal view only. Selection is
  // resolved-UUID-only so it is IDENTICAL to handle dereference (sol
  // 037cfc22); legacy rows keyed by project NAME need a backfill mapping
  // at cutover — out of scope here.
  const handoffItems: InboxItem[] = (db.prepare(
    `SELECT h.id, h.from_agent, h.summary, h.created_at,
            EXISTS(SELECT 1 FROM eng4_handoff_acks a
                    WHERE a.tenant_id = h.tenant_id AND a.handoff_id = h.id AND a.agent_id = ?) AS acked
       FROM session_handoffs h
      WHERE h.tenant_id = ? AND h.active = 1 AND h.project_id = ?
      ORDER BY h.created_at DESC, h.id ASC`
  ).all(resolvedAgentId, tenantId, resolved.projectId) as any[]).map((r) => {
    const body = String(r.summary ?? '');
    const base = {
      itemType: 'handoff' as const,
      handoffId: String(r.id),
      from: String(r.from_agent ?? ''),
      recordedAt: String(r.created_at ?? ''),
      ackedByMe: Boolean(r.acked),
    };
    return body.length > MAX_INLINE_MESSAGE_BODY_CHARS
      ? { ...base, body: null, handle: { kind: 'message' as const, uri: buildHandoffUri(scopeKey, String(r.id)) } }
      : { ...base, body, handle: null };
  });

  const messages: InboxItem[] = [...handoffItems, ...messageItems];

  // currentFacts = non-superseded facts; refs join in; effectiveAt only
  // when recorded — never invented. Dangling contradicts refs surface
  // verbatim as unresolved contradictions (deferred-resolution rule).
  const factRows = db.prepare(
    `SELECT * FROM eng4_facts WHERE tenant_id = ? AND scope_key = ? AND status != 'superseded'
      ORDER BY recorded_at DESC, fact_id ASC`
  ).all(tenantId, scopeKey) as any[];
  const refStmt = db.prepare(
    `SELECT ref_kind, ref FROM eng4_fact_refs WHERE tenant_id = ? AND fact_id = ? ORDER BY ref ASC`
  );
  const currentFacts: CurrentFact[] = factRows.map((r) => {
    const refs = refStmt.all(tenantId, r.fact_id) as Array<{ ref_kind: string; ref: string }>;
    const pick = (kind: string) => refs.filter((x) => x.ref_kind === kind).map((x) => x.ref);
    const fact: CurrentFact = {
      factId: r.fact_id,
      assertion: { subject: r.subject, predicate: r.predicate, object: r.object },
      status: r.status,
      evidenceRefs: pick('evidence'),
      sourceRefs: pick('source'),
      author: r.author,
      recordedAt: r.recorded_at,
      contradicts: pick('contradicts'),
    };
    if (r.effective_at) fact.effectiveAt = r.effective_at;
    return fact;
  });

  // decisions = 'decision' events from the CURRENT head's persisted envelope.
  const decisions: ResumeBundle['decisions'] = [];
  let evidence: ContentHandle[] = [];
  if (currentRow) {
    const payload = db.prepare(
      `SELECT body, byte_length, media_type FROM eng4_payloads WHERE tenant_id = ? AND content_hash = ?`
    ).get(tenantId, currentRow.content_hash) as any;
    if (payload) {
      const envelope = JSON.parse(Buffer.from(payload.body).toString('utf8'));
      (envelope.events ?? []).forEach((event: any, index: number) => {
        if (event?.kind === 'decision') {
          decisions.push({
            id: `${currentRow.state_id}:${index}`,
            summary: String(event.summary ?? ''),
            recordedAt: typeof event.at === 'string' ? event.at : currentRow.recorded_at,
            evidenceRefs: (envelope.evidenceRefs ?? []).map(String),
          });
        }
      });
      evidence = [{
        kind: 'state-snapshot',
        uri: `engram://snapshot/${encodeURIComponent(scopeKey)}/${encodeURIComponent(currentRow.state_id)}`,
        contentHash: currentRow.content_hash,
        byteLength: payload.byte_length,
        mediaType: payload.media_type,
      }];
    }
  }

  const pointers: ResumeBundle['pointers'] = [];
  if (resolved.projectId) pointers.push({ label: 'project', entity: resolved.projectId, relation: 'scoped-to' });
  if (resolved.taskId) pointers.push({ label: 'task', entity: resolved.taskId, relation: 'scoped-to' });

  // --- Budgeted assembly in contractual section order.
  const requested = new Set<ResumeSectionName>(params.sections ?? SECTION_ORDER);
  const cursor = decodeCursor(params.cursor);
  const sectionItems: Record<ResumeSectionName, unknown[]> = {
    working: working ? [working] : [],
    openLoops, messages, currentFacts, decisions, evidence, pointers,
  };

  const coverageEntries: Array<[ResumeSectionName, SectionCoverage]> = [];
  const included: Partial<Record<ResumeSectionName, unknown[]>> = {};
  let totalTokenEstimate = 0;
  let beforeCursor = cursor !== null;
  // Budget truncation is a HARD STOP: once a section is cut, later sections
  // deliver nothing — the truncation point is the ONE continuation cursor,
  // so pages never repeat items admitted "around" an earlier cut.
  let truncated = false;

  for (const section of SECTION_ORDER) {
    const items = sectionItems[section];
    if (beforeCursor && section === cursor!.s) beforeCursor = false;
    if (!requested.has(section)) {
      included[section] = [];
      coverageEntries.push([section, { ...emptyCoverage('not-requested', items.length), contentComplete: false }]);
      continue;
    }
    if (beforeCursor) {
      // Delivered on an earlier page — accounted, not repeated.
      included[section] = [];
      coverageEntries.push([section, { ...emptyCoverage('cursor', items.length), contentComplete: false }]);
      continue;
    }
    if (truncated) {
      included[section] = [];
      coverageEntries.push([section, {
        ...emptyCoverage('budget', items.length),
        contentComplete: items.length === 0,
        omittedReason: items.length === 0 ? 'none' : 'budget',
      }]);
      continue;
    }
    const startOffset = cursor && section === cursor.s ? Math.min(cursor.o, items.length) : 0;
    const takeFrom = items.slice(startOffset);
    const taken: unknown[] = [];
    let sectionTokens = 0;
    for (const item of takeFrom) {
      const cost = tokenEstimate(item);
      if (totalTokenEstimate + cost > params.budget) {
        truncated = true;
        break;
      }
      taken.push(item);
      sectionTokens += cost;
      totalTokenEstimate += cost;
    }
    included[section] = taken;
    const includedCount = taken.length;
    const complete = startOffset === 0 && includedCount === items.length;
    coverageEntries.push([section, {
      includedCount,
      totalCount: items.length,
      contentComplete: complete,
      omittedReason: complete ? 'none' : (startOffset > 0 && includedCount + startOffset >= items.length ? 'cursor' : 'budget'),
      nextCursor: complete || startOffset + includedCount >= items.length
        ? null
        : encodeCursor({ s: section, o: startOffset + includedCount }),
      tokenEstimate: sectionTokens,
    }]);
  }

  return {
    schemaVersion: 1,
    resolvedScope: resolved,
    asOf: {
      assembledAt,
      stateId: currentRow ? currentRow.state_id : null,
      revision: currentRow ? currentRow.revision : null,
      stateAgeSec: currentRow
        ? Math.max(0, Math.floor((Date.parse(assembledAt) - Date.parse(currentRow.recorded_at)) / 1000))
        : null,
      stale: !currentRow,
      conflicts: heads.length > 1 ? heads : [],
    },
    definition,
    working: (included.working?.[0] as WorkingState | undefined) ?? null,
    openLoops: (included.openLoops ?? []) as OpenLoop[],
    messages: (included.messages ?? []) as InboxItem[],
    currentFacts: (included.currentFacts ?? []) as CurrentFact[],
    decisions: (included.decisions ?? []) as ResumeBundle['decisions'],
    evidence: (included.evidence ?? []) as ContentHandle[],
    pointers: (included.pointers ?? []) as ResumeBundle['pointers'],
    coverage: {
      ...coverageOf(coverageEntries),
      totalTokenEstimate,
      budget: params.budget,
    },
  };
}
