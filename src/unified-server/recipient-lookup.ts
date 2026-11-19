/**
 * Recipient lookup (field feedback P1, item 1).
 *
 * Registration and addressability are different things in hythe:
 *
 * - A mailbox address is an exact, opaque handle (resolveMailboxIdentity):
 *   send_ai_message(to: X) always lands in mailbox X, whether or not X has
 *   ever called register_agent, and case and suffixes are significant.
 * - agent_registrations (get_agent_status) only lists agents that registered.
 *   Its alias/canonical grouping is for presentation; it never redirects mail.
 *
 * So an agent such as "grok" can be fully addressable (it sends and receives)
 * while missing from get_agent_status, and a name such as "Codex-CLI" can look
 * like an alias of a registered "codex" while actually being a separate,
 * empty mailbox. resolveRecipient answers one question for a caller about to
 * send: where does a message to this name go, and does anyone use it?
 *
 * Read-only. It reports message COUNTS and the last activity time for the
 * exact address, never message contents, senders or subjects.
 */
import type Database from 'better-sqlite3';

export type RecipientStatus =
  | 'registered'
  | 'registered-inactive'
  | 'addressable'
  | 'alias'
  | 'unknown'
  | 'invalid';

export interface RecipientRegistration {
  agentId: string;
  name: string | null;
  status: string;
  storedStatus: string;
  lastSeen: string | null;
  expiresAt?: string;
}

export interface RelatedRegistration {
  agentId: string;
  canonicalAgentId: string;
  status: string;
  lastSeen: string | null;
}

export interface RecipientResolution {
  query: string;
  /** The exact mailbox send_ai_message(to: query) delivers to; null when the name is not a valid address. */
  deliversTo: string | null;
  status: RecipientStatus;
  explanation: string;
  registered: boolean;
  registrationActive: boolean;
  hasMailboxHistory: boolean;
  /** Display grouping only (same rule as get_agent_status canonicalAgentId); never changes delivery. */
  canonicalAgentId: string | null;
  registration: RecipientRegistration | null;
  mailbox: { received: number; sent: number; lastActivityAt: string | null };
  /**
   * Registered agents whose presentation aliases include this name but whose
   * mailbox is a DIFFERENT exact address. Mail sent to the query does not
   * reach them.
   */
  relatedRegistrations: RelatedRegistration[];
}

export interface RecipientLookupDeps {
  db: Database.Database;
  tenantId: string;
  /** MemoryManager.resolveMailboxIdentity(...).canonical: '' when invalid. */
  mailboxAddress: (name: string) => string;
  /** MemoryManager.getAgentAliases: presentation aliases (lower-case). */
  presentationAliases: (name: string) => string[];
  /** MemoryManager.resolvePreferredAgentId: presentation canonical id. */
  preferredAgentId: (name: string) => string;
  inferCanonicalAgentId: (agentId: string, name?: string, metadata?: any) => string;
  /** Same rule as get_agent_status: 'active' past expiresAt reads as 'expired'. */
  effectiveStatus: (storedStatus: string | undefined, metadata: any) => string;
  expiresAt: (metadata: any) => string | undefined;
}

const MAX_RELATED = 20;

function parseJson(raw: unknown): any {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function resolveRecipient(deps: RecipientLookupDeps, query: unknown): RecipientResolution {
  const text = typeof query === 'string' ? query : '';
  const address = text ? deps.mailboxAddress(text) : '';

  const empty: RecipientResolution = {
    query: text,
    deliversTo: null,
    status: 'invalid',
    explanation:
      'Not a valid mailbox address: use 1-100 characters from A-Z a-z 0-9 _ . : - . A message to it would be rejected.',
    registered: false,
    registrationActive: false,
    hasMailboxHistory: false,
    canonicalAgentId: null,
    registration: null,
    mailbox: { received: 0, sent: 0, lastActivityAt: null },
    relatedRegistrations: [],
  };
  if (!address) return empty;

  const { db, tenantId } = deps;

  const regRow = db.prepare(
    `SELECT agent_id, name, metadata_json, status, updated_at
       FROM agent_registrations
      WHERE tenant_id = ? AND agent_id = ?
      LIMIT 1`,
  ).get(tenantId, address) as any;

  let registration: RecipientRegistration | null = null;
  if (regRow) {
    const metadata = parseJson(regRow.metadata_json);
    registration = {
      agentId: regRow.agent_id,
      name: regRow.name ?? null,
      status: deps.effectiveStatus(regRow.status, metadata),
      storedStatus: regRow.status || 'unknown',
      lastSeen: regRow.updated_at ?? null,
      ...(deps.expiresAt(metadata) ? { expiresAt: deps.expiresAt(metadata) } : {}),
    };
  }

  // Exact-address counts; both columns are indexed (idx_ai_messages_to/_from).
  const received = db.prepare(
    `SELECT COUNT(*) AS c, MAX(created_at) AS last FROM ai_messages WHERE tenant_id = ? AND to_agent = ?`,
  ).get(tenantId, address) as { c: number; last: string | null };
  const sent = db.prepare(
    `SELECT COUNT(*) AS c, MAX(created_at) AS last FROM ai_messages WHERE tenant_id = ? AND from_agent = ?`,
  ).get(tenantId, address) as { c: number; last: string | null };
  const lastActivityAt = [received?.last, sent?.last]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort()
    .pop() ?? null;
  const mailbox = { received: received?.c ?? 0, sent: sent?.c ?? 0, lastActivityAt };
  const hasMailboxHistory = mailbox.received + mailbox.sent > 0;

  // Registrations grouped with this name for presentation, at another exact address.
  const aliasSet = new Set(deps.presentationAliases(address).map((a) => a.toLowerCase()));
  const relatedRegistrations: RelatedRegistration[] = [];
  if (aliasSet.size > 0) {
    const rows = db.prepare(
      `SELECT agent_id, name, metadata_json, status, updated_at
         FROM agent_registrations
        WHERE tenant_id = ? AND agent_id <> ?
        ORDER BY updated_at DESC`,
    ).all(tenantId, address) as any[];
    for (const row of rows) {
      const metadata = parseJson(row.metadata_json);
      const canonical = deps.inferCanonicalAgentId(row.agent_id, row.name, metadata);
      const related =
        aliasSet.has(String(row.agent_id).toLowerCase()) ||
        (typeof row.name === 'string' && aliasSet.has(row.name.toLowerCase())) ||
        aliasSet.has(canonical);
      if (!related) continue;
      relatedRegistrations.push({
        agentId: row.agent_id,
        canonicalAgentId: canonical,
        status: deps.effectiveStatus(row.status, metadata),
        lastSeen: row.updated_at ?? null,
      });
      if (relatedRegistrations.length >= MAX_RELATED) break;
    }
  }

  const registrationActive = registration?.status === 'active';
  let status: RecipientStatus;
  let explanation: string;
  const relatedNote = relatedRegistrations.length > 0
    ? ` Related registration(s) at other addresses (${relatedRegistrations.map((r) => r.agentId).join(', ')}) do NOT receive mail sent to "${address}".`
    : '';
  if (registration && registrationActive) {
    status = 'registered';
    explanation = `Registered and active. Messages to "${address}" go to that exact mailbox.`;
  } else if (registration) {
    status = 'registered-inactive';
    explanation =
      `Registered, but the registration is ${registration.status}. Messages to "${address}" are still delivered to ` +
      'that exact mailbox and wait there until the agent reads them.';
  } else if (hasMailboxHistory) {
    status = 'addressable';
    explanation =
      `Not registered (so not listed by get_agent_status), but "${address}" is an existing mailbox that has sent or ` +
      'received messages. Messages to it are delivered normally.' + relatedNote;
  } else if (relatedRegistrations.length > 0) {
    status = 'alias';
    explanation =
      `"${address}" has no registration and no message history; it only matches registered agent(s) by name. ` +
      'Mail is delivered to the exact address, so a message to it would sit in a new, unused mailbox. ' +
      `Send to the registered address instead: ${relatedRegistrations.map((r) => r.agentId).join(', ')}.`;
  } else {
    status = 'unknown';
    explanation =
      `"${address}" is a valid address with no registration and no message history. A message to it would be ` +
      'stored in a new mailbox that no known agent reads yet.';
  }

  return {
    query: text,
    deliversTo: address,
    status,
    explanation,
    registered: !!registration,
    registrationActive,
    hasMailboxHistory,
    canonicalAgentId: deps.preferredAgentId(address) || null,
    registration,
    mailbox,
    relatedRegistrations,
  };
}

/**
 * Mailbox addresses that have sent or received messages but have no
 * registration row, most recently active first. Bounded by `limit`.
 * `prefix` (lower-case) keeps only addresses starting with it, ignoring case.
 */
export function listUnregisteredAddressable(
  db: Database.Database,
  tenantId: string,
  limit: number,
  prefix?: string,
): { total: number; addresses: Array<{ agentId: string; lastActivityAt: string | null; registered: false }> } {
  const base = `
    WITH addresses AS (
      SELECT to_agent AS agent_id, MAX(created_at) AS last FROM ai_messages WHERE tenant_id = ? GROUP BY to_agent
      UNION ALL
      SELECT from_agent AS agent_id, MAX(created_at) AS last FROM ai_messages WHERE tenant_id = ? GROUP BY from_agent
    ), merged AS (
      SELECT agent_id, MAX(last) AS last FROM addresses GROUP BY agent_id
    )
    SELECT agent_id, last FROM merged
     WHERE agent_id NOT IN (SELECT agent_id FROM agent_registrations WHERE tenant_id = ?)
       AND (? IS NULL OR lower(substr(agent_id, 1, length(?))) = ?)`;
  const p = prefix ?? null;
  const params = [tenantId, tenantId, tenantId, p, p, p];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM (${base})`).get(...params) as { c: number }).c;
  const rows = db.prepare(`${base} ORDER BY last DESC, agent_id LIMIT ?`).all(...params, limit) as any[];
  return {
    total,
    addresses: rows.map((r) => ({ agentId: r.agent_id, lastActivityAt: r.last ?? null, registered: false as const })),
  };
}
