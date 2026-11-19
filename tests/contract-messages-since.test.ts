/**
 * v3 plan P1: get_ai_messages `since`.
 *
 * Before: `since` was compared as raw text against stored timestamps
 * ("YYYY-MM-DD HH:MM:SS"), so the ISO T/Z form matched nothing on the same
 * day ('T' sorts after ' ') and offsets were never applied. Now both sides are
 * normalized to UTC "YYYY-MM-DD HH:MM:SS.SSS"; invalid input is a validation
 * error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseSince, sinceForQuery, InvalidSinceError } from '../src/shared/message-since.js';

const BASE_URL = process.env.NEURAL_URL || 'http://localhost:6174';
const API_KEY = process.env.NEURAL_API_KEY ?? 'test-placeholder-not-a-real-key';

describe('parseSince', () => {
  const utc = (v: string) => {
    const r = parseSince(v);
    if (!r.ok) throw new Error(r.error.message);
    return r.utc;
  };

  it('accepts the ISO T/Z form', () => {
    expect(utc('2026-11-18T23:00:00Z')).toBe('2026-11-18 23:00:00.000');
    expect(utc('2026-11-18t23:00:00z')).toBe('2026-11-18 23:00:00.000');
  });

  it('accepts the space form, without a zone meaning UTC', () => {
    expect(utc('2026-11-18 23:00:00')).toBe('2026-11-18 23:00:00.000');
    expect(utc('2026-11-18T23:00:00')).toBe('2026-11-18 23:00:00.000');
  });

  it('applies offsets, including across a day boundary', () => {
    expect(utc('2026-11-18T17:00:00-06:00')).toBe('2026-11-18 23:00:00.000');
    expect(utc('2026-11-18T19:00:00-0600')).toBe('2026-11-19 01:00:00.000');
    expect(utc('2026-11-19T01:30:00+02:30')).toBe('2026-11-18 23:00:00.000');
    expect(utc('2026-11-18 23:00:00+00:00')).toBe('2026-11-18 23:00:00.000');
  });

  it('keeps milliseconds and truncates finer fractions', () => {
    expect(utc('2026-11-18T23:00:00.5Z')).toBe('2026-11-18 23:00:00.500');
    expect(utc('2026-11-18T23:00:00.123Z')).toBe('2026-11-18 23:00:00.123');
    expect(utc('2026-11-18T23:00:00.123999Z')).toBe('2026-11-18 23:00:00.123');
  });

  it('accepts a date alone and a time without seconds', () => {
    expect(utc('2026-11-18')).toBe('2026-11-18 00:00:00.000');
    expect(utc('2026-11-18T23:05Z')).toBe('2026-11-18 23:05:00.000');
    expect(utc(' 2026-11-18T23:00:00Z ')).toBe('2026-11-18 23:00:00.000');
  });

  it('rejects invalid input with a validation error that names the field', () => {
    for (const bad of [
      'yesterday', '2026-11-18T25:00:00Z', '2026-02-30', '2026-13-01', '2026-11-18T23:60:00Z',
      '2026-11-18Z', '2026-11-18T23:00:00+24:00', '18/11/2026', '1700000000', '2026-11-18T23:00:00ZZ',
      '   ', 'x'.repeat(10_000),
    ]) {
      const r = parseSince(bad);
      expect(r.ok, bad.slice(0, 40)).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatchObject({ error: 'validation_error', code: 'INVALID_TIMESTAMP', field: 'since' });
        expect(r.error.message).toContain('2026-11-18T23:00:00Z');
        expect(r.error.message.length).toBeLessThan(400);
      }
    }
    expect(parseSince(1700000000).ok).toBe(false);
    expect(parseSince(null).ok).toBe(false);
  });

  it('sinceForQuery: empty means no filter; invalid throws', () => {
    expect(sinceForQuery(undefined)).toBeUndefined();
    expect(sinceForQuery('')).toBeUndefined();
    expect(sinceForQuery('2026-11-18T23:00:00Z')).toBe('2026-11-18 23:00:00.000');
    expect(() => sinceForQuery('not a time')).toThrow(InvalidSinceError);
  });
});

describe('MemoryManager.getMessagesPage since (stored timestamps in mixed forms)', () => {
  let manager: any;
  const to = 'since-recipient';
  // Stored created_at values. SQLite's default is the space form; rows written
  // by other paths may carry milliseconds or the ISO T/Z form.
  const rows: Array<[string, string]> = [
    ['m1', '2026-11-18 22:59:59'],
    ['m2', '2026-11-18 23:00:00'],
    ['m3', '2026-11-18 23:00:00.001'],
    ['m4', '2026-11-18T23:30:00Z'],
    ['m5', '2026-11-19 00:00:00'],
  ];

  const ids = (since?: string) =>
    manager
      .getMessagesPage(to, { since, unreadOnly: false, limit: 20, compact: false })
      .messages.map((m: any) => m.content)
      .sort();

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    for (const [label, createdAt] of rows) {
      const id = await manager.storeMessage('since-sender', to, label);
      manager.getDb().prepare('UPDATE ai_messages SET created_at = ? WHERE id = ?').run(createdAt, id);
    }
  });

  afterAll(async () => { await manager.close(); });

  it('no since returns every row', () => {
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('REPRO: the ISO T/Z form now matches rows stored in the space form', () => {
    // Raw text comparison returned only m4 and m5 here.
    expect(ids('2026-11-18T23:00:00Z')).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('space form and offset form select the same rows as the T/Z form', () => {
    expect(ids('2026-11-18 23:00:00')).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(ids('2026-11-18T17:00:00-06:00')).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('boundary: a timestamp exactly equal to since is included (>=)', () => {
    expect(ids('2026-11-19T00:00:00Z')).toEqual(['m5']);
    expect(ids('2026-11-18T23:30:00Z')).toEqual(['m4', 'm5']);
    expect(ids('2026-11-18 23:30:00')).toEqual(['m4', 'm5']);
  });

  it('boundary: millisecond precision on both sides', () => {
    expect(ids('2026-11-18T23:00:00.001Z')).toEqual(['m3', 'm4', 'm5']);
    expect(ids('2026-11-18T23:00:00.002Z')).toEqual(['m4', 'm5']);
    expect(ids('2026-11-18T22:59:59.999Z')).toEqual(['m2', 'm3', 'm4', 'm5']);
  });

  it('a date alone covers the whole day', () => {
    expect(ids('2026-11-18')).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(ids('2026-11-19')).toEqual(['m5']);
  });

  it('invalid since throws before any read (nothing marked read or delivered)', async () => {
    // A fresh recipient whose rows were never fetched: delivered_at and
    // read_at are both still NULL, so a stray UPDATE would show.
    const fresh = 'since-fresh-recipient';
    for (const label of ['f1', 'f2']) await manager.storeMessage('since-sender', fresh, label);
    const state = () => manager.getDb()
      .prepare('SELECT id, delivered_at, read_at FROM ai_messages WHERE to_agent = ? ORDER BY id')
      .all(fresh);
    const before = state();
    expect(before).toHaveLength(2);
    for (const row of before) {
      expect(row.delivered_at).toBeNull();
      expect(row.read_at).toBeNull();
    }
    for (const bad of ['yesterday', '1700000000', '2026-02-30']) {
      expect(() => manager.getMessagesPage(fresh, { since: bad, markAsRead: true, unreadOnly: false }))
        .toThrow(InvalidSinceError);
    }
    expect(state()).toEqual(before);
  });
});

describe('since precision: both sides truncated to milliseconds (ai_messages and legacy path)', () => {
  let manager: any;
  const to = 'since-precision-recipient';
  // Stored values with finer-than-millisecond fractions, plus one value
  // SQLite cannot parse. Current inserts are whole seconds; these model
  // imported or legacy rows.
  const rows: Array<[string, string]> = [
    ['p1', '2026-11-18 23:00:00.123999'],
    ['p2', '2026-11-18 23:00:00.123499'],
    ['p3', '2026-11-18 23:59:59.9999'],
    ['p4', '2026-11-18 23:00:00.999999'],
    ['u1', '2026-11-18 23:00:00 UTC'],
    // Empty or malformed fractions: SQLite rejects them, so must the helper.
    ['u2', '2026-11-18T23:00:00.Z'],
    ['u3', '2026-11-18 23:00:00.'],
    ['u4', '2026-11-18T23:00:00.+02:00'],
  ];

  const current = (since?: string) =>
    manager.getMessagesPage(to, { since, unreadOnly: false, limit: 20, compact: false })
      .messages.map((m: any) => m.content).sort();
  const legacy = (since?: string) =>
    manager.getLegacyMessagesPage(to, { since, limit: 20 })
      .messages.map((m: any) => m.content).sort();

  beforeAll(async () => {
    process.env.ENABLE_ADVANCED_MEMORY = 'false';
    const { MemoryManager } = await import('../src/unified-server/memory/index.js');
    manager = new MemoryManager(':memory:');
    const insertLegacy = manager.getDb().prepare(
      `INSERT INTO shared_memory (id, tenant_id, memory_type, content, created_by, tags)
       VALUES (?, 'default', 'ai_message', ?, 'since-sender', '[]')`,
    );
    for (const [label, createdAt] of rows) {
      const id = await manager.storeMessage('since-sender', to, label);
      manager.getDb().prepare('UPDATE ai_messages SET created_at = ? WHERE id = ?').run(createdAt, id);
      insertLegacy.run(`legacy-${label}`, JSON.stringify({ from: 'since-sender', to, content: label, timestamp: createdAt }));
    }
  });

  afterAll(async () => { await manager.close(); });

  for (const [name, ids] of [['ai_messages', () => current], ['legacy shared_memory', () => legacy]] as const) {
    describe(name, () => {
      it('without since every row is returned, the unparseable one included', () => {
        expect(ids()()).toEqual(['p1', 'p2', 'p3', 'p4', 'u1', 'u2', 'u3', 'u4']);
      });

      it('stored .123999 is NOT moved onto a .124 cutoff (strftime alone rounds it to .124)', () => {
        expect(ids()('2026-11-18T23:00:00.124Z')).toEqual(['p3', 'p4']);
      });

      it('both sides truncate: .123 and .123999 cutoffs keep .123499 and .123999', () => {
        expect(ids()('2026-11-18T23:00:00.123Z')).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(ids()('2026-11-18T23:00:00.123999Z')).toEqual(['p1', 'p2', 'p3', 'p4']);
      });

      it('no second rollover: stored 23:59:59.9999 stays before the next second', () => {
        expect(ids()('2026-11-18T23:59:59.999Z')).toEqual(['p3']);
        expect(ids()('2026-11-19T00:00:00Z')).toEqual([]);
      });

      it('no second rollover: stored 23:00:00.999999 stays before a 23:00:01 cutoff (strftime alone rounds it to 23:00:01.000)', () => {
        expect(ids()('2026-11-18T23:00:01Z')).toEqual(['p3']);
        expect(ids()('2026-11-18T23:00:00.999Z')).toEqual(['p3', 'p4']);
        expect(ids()('2026-11-18T23:00:00.999999Z')).toEqual(['p3', 'p4']);
      });

      it('a stored value SQLite cannot parse is left out of every since result', () => {
        expect(ids()('2026-01-01')).toEqual(['p1', 'p2', 'p3', 'p4']);
      });

      it('an empty or malformed stored fraction is not padded into .000 (left out like any unparseable value)', () => {
        expect(ids()('2026-11-18T23:00:00Z')).toEqual(['p1', 'p2', 'p3', 'p4']);
      });
    });
  }
});

describe('get_ai_messages since over MCP and HTTP (hermetic server)', () => {
  const recipient = `_since_r_${Date.now()}`;
  const sender = `_since_s_${Date.now()}`;

  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
    return { isError: json.result?.isError === true, text: json.result?.content?.[0]?.text ?? '' };
  }

  const inbox = async (since: string) => {
    const r = await call('get_ai_messages', { agentId: recipient, since, unreadOnly: false, limit: 20 });
    return { ...r, body: r.isError ? null : JSON.parse(r.text) };
  };

  // Whole seconds, one minute back: safe against clock rounding on either side.
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const iso = start.toISOString().replace('.000Z', 'Z');
  const space = iso.replace('T', ' ').replace('Z', '');
  const future = new Date(start.getTime() + 3_600_000).toISOString();

  beforeAll(async () => {
    const r = await call('send_ai_message', { from: sender, to: recipient, content: 'since contract message' });
    expect(r.isError).toBe(false);
  });

  it('REPRO: the ISO T/Z form finds a message sent after it', async () => {
    const r = await inbox(iso);
    expect(r.isError).toBe(false);
    expect(r.body.totalMessages).toBe(1);
    expect(r.body.filters.since).toBe(iso);
    expect(r.body.filters.sinceUtc).toBe(`${space}.000`);
  });

  it('the space form and an offset form find it too', async () => {
    expect((await inbox(space)).body.totalMessages).toBe(1);
    const offset = new Date(start.getTime() - 6 * 3_600_000).toISOString().replace('Z', '-06:00');
    expect((await inbox(offset)).body.totalMessages).toBe(1);
  });

  it('a since after the message excludes it', async () => {
    expect((await inbox(future)).body.totalMessages).toBe(0);
  });

  it('invalid since is a validation error, not an empty inbox', async () => {
    const r = await inbox('yesterday');
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'validation_error', code: 'INVALID_TIMESTAMP', field: 'since' });
  });

  it('HTTP GET /ai-messages: invalid since is a 400 with the same error', async () => {
    const res = await fetch(
      `${BASE_URL}/ai-messages/${encodeURIComponent(recipient)}?since=${encodeURIComponent('2026-02-30')}`,
      { headers: { 'X-API-Key': API_KEY } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_TIMESTAMP', field: 'since' });
  });

  it('HTTP GET /ai-messages: the ISO T/Z form finds the message', async () => {
    const res = await fetch(
      `${BASE_URL}/ai-messages/${encodeURIComponent(recipient)}?since=${encodeURIComponent(iso)}`,
      { headers: { 'X-API-Key': API_KEY } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('since contract message');
  });
});
