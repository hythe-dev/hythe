/**
 * Field report 9ceed35e P1 (2026-09-20): on scope bensalem-clean the pointer
 * sat at revision 378 while live heads reached ~500, and resume handed a
 * newcomer state ~120 revisions old with no warning. The fork WAS in the
 * bundle (asOf.conflicts lists every live head once the state has forked),
 * but nothing said what it meant.
 *
 * This module turns that frozen data into a plain-text notice that the
 * resume/begin_session handlers append as a SECOND content item. content[0]
 * stays the exact JSON of structuredContent, and no output schema changes,
 * so the frozen v1/v2 shapes and the final v3 shape are untouched.
 *
 * How a lag grows (checkpoint.ts): a write's parent is the snapshot whose
 * revision equals expectedRevision, revisions are numbered scope-wide
 * (MAX+1), and the pointer advances only when the parent IS the pointed
 * head (heads.ts §3.2a). An agent that keeps checkpointing on its own
 * branch's revision therefore grows a branch with ever-higher revisions
 * while "current" stays put. The notice says which revision advances it.
 */

interface HeadLike {
  stateId: string;
  revision: number;
  author: string;
  recordedAt: string;
}

/** The fields of any resume bundle version that this module reads. */
export interface DivergenceInput {
  resolvedScope?: { scopeKey?: string | null } | null;
  asOf: {
    stateId: string | null;
    revision: number | null;
    conflicts: HeadLike[];
  };
}

export interface DivergenceSummary {
  liveHeadCount: number;
  currentStateId: string | null;
  currentRevision: number | null;
  newest: HeadLike;
  /** newest.revision - currentRevision; 0 when current is the newest; null when there is no current head. */
  revisionLag: number | null;
}

export function summarizeDivergence(bundle: DivergenceInput): DivergenceSummary | null {
  const heads = bundle.asOf.conflicts ?? [];
  if (heads.length < 2) return null; // not forked: nothing to say
  const newest = heads.reduce((a, b) => (b.revision > a.revision ? b : a));
  const currentRevision = bundle.asOf.revision;
  return {
    liveHeadCount: heads.length,
    currentStateId: bundle.asOf.stateId,
    currentRevision,
    newest,
    revisionLag: currentRevision === null ? null : Math.max(0, newest.revision - currentRevision),
  };
}

/** The notice text, or null when the scope has a single line of history. */
export function divergenceNotice(bundle: DivergenceInput): string | null {
  const d = summarizeDivergence(bundle);
  if (!d) return null;
  const scope = bundle.resolvedScope?.scopeKey ?? 'this scope';
  const others = d.liveHeadCount - (d.currentStateId ? 1 : 0);
  const lines: string[] = [];

  if (d.currentStateId === null || d.currentRevision === null) {
    lines.push(
      `WARNING (hythe resume): ${scope} has ${d.liveHeadCount} live heads and NO current head is designated. ` +
      `working is null on purpose; do not pick a head by revision number.`
    );
  } else if (d.revisionLag && d.revisionLag > 0) {
    lines.push(
      `WARNING (hythe resume): the working state above is revision ${d.currentRevision}, ` +
      `but ${scope} has ${others} other live head(s); the newest is revision ${d.newest.revision} ` +
      `by ${d.newest.author} at ${d.newest.recordedAt}, ${d.revisionLag} revision(s) ahead. ` +
      `The working state may be stale.`
    );
  } else {
    lines.push(
      `NOTE (hythe resume): ${scope} has forked: the working state above is revision ${d.currentRevision} (current), ` +
      `and ${others} other live head(s) exist with older revisions.`
    );
  }

  lines.push(
    'Live heads: ' +
      [...bundle.asOf.conflicts]
        .sort((a, b) => b.revision - a.revision)
        .map((h) => `rev ${h.revision} ${h.author} ${h.stateId}${h.stateId === d.currentStateId ? ' (current)' : ''}`)
        .join('; ') +
      '.'
  );
  if (d.currentRevision !== null) {
    lines.push(
      `To advance current, checkpoint with expectedRevision ${d.currentRevision}. ` +
      'A checkpoint on any other head\'s revision extends a branch that does not become current.'
    );
  }
  lines.push(
    'To inspect: resume with resultVersion 3 and sections ["working","heads"]. ' +
    'To merge: checkpoint with resultVersion 3 and operation "reconcile" (expectedHeads, expectedPointer, survivor). ' +
    'Reconciling discards no history, but choose the survivor deliberately; ask the scope owner if unsure.'
  );
  return lines.join('\n');
}

/** Append the notice as an extra text item; content[0] is left unchanged. */
export function withDivergenceNotice<T extends { content: Array<{ type: 'text'; text: string }> }>(
  result: T,
  bundle: DivergenceInput
): T {
  const notice = divergenceNotice(bundle);
  if (!notice) return result;
  return { ...result, content: [...result.content, { type: 'text', text: notice }] };
}
