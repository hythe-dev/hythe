import type { RequestContext } from '../middleware/auth/types.js';

/**
 * Message attribution labels (field feedback P1 item 6). Labelling only: it
 * records how the server knew who sent a message. It never changes who may
 * send, and it never exposes credential or key identifiers.
 *
 *   credential      the sender id is proven by a per-agent credential (the
 *                   binder bound `from` to the authenticated principal)
 *   asserted        the caller supplied `from` without a per-agent credential;
 *                   the server took its word for it. On a shared connection
 *                   every co-located agent is 'asserted', so the label cannot
 *                   tell them apart.
 *   server-default  no `from` at all: the server's own id was used
 *   unknown         a message stored before attribution existed
 */
export type AttributionSource = 'credential' | 'asserted' | 'server-default';
export type StoredAttributionSource = AttributionSource | 'unknown';

export interface MessageAttribution {
  authoredBy: string;
  attributionSource: AttributionSource;
}

/**
 * @param context      the request context the binder authorized
 * @param boundFrom    `from` AFTER bindAgentInvocation (undefined when absent)
 * @param authoredBy   the sender id actually stored on the message
 */
export function messageAttribution(
  context: RequestContext,
  boundFrom: unknown,
  authoredBy: string,
): MessageAttribution {
  const from = typeof boundFrom === 'string' && boundFrom.trim() ? boundFrom : null;
  if (from == null) return { authoredBy, attributionSource: 'server-default' };
  const principal = context.agentPrincipal;
  const attributionSource: AttributionSource =
    principal != null && principal.agentId === from ? 'credential' : 'asserted';
  return { authoredBy, attributionSource };
}

/**
 * Read side: the top-level labels for a stored message row. Rows written
 * before attribution existed read attributionSource 'unknown' and authoredBy
 * the stored sender.
 */
export function readMessageAttribution(
  metadata: unknown,
  fromAgent: string,
): { authoredBy: string; attributionSource: StoredAttributionSource } {
  const stored = (metadata as any)?.attribution;
  const source = stored?.attributionSource;
  if (
    stored && typeof stored.authoredBy === 'string' &&
    (source === 'credential' || source === 'asserted' || source === 'server-default')
  ) {
    return { authoredBy: stored.authoredBy, attributionSource: source };
  }
  return { authoredBy: fromAgent, attributionSource: 'unknown' };
}
