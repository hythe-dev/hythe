/**
 * ENG-4 H5 — per-call verification memo.
 *
 * The v3 verifiers (version parity, reconcile rows, resolution rows,
 * divergent terminals) each re-read, re-hash and re-parse the same payload
 * bodies inside one `resume` or `checkpoint` call. Every better-sqlite3 call
 * here is SYNCHRONOUS, so a memo that lives exactly for the duration of one
 * top-level call cannot leak across requests or interleave with another
 * caller: `runWithEnvelopeMemo` installs an empty map, the readers consult
 * it, and it is discarded when the call returns (or throws).
 *
 * What is memoized: (a) "payload <hash> verified" — the sha256/byte-length
 * check of the persisted bytes, and (b) the parsed envelope for a verified
 * hash. Both are keyed by (tenant, content_hash); a payload row cannot change
 * legitimately (hash-addressed, verified), and an out-of-band change is still
 * caught on the FIRST read of every call. Nothing is cached across calls.
 */
let current: Map<string, unknown> | null = null;

/** Hits/misses of the most recent memoized call — for tests and profiling only. */
export const lastMemoStats = { hits: 0, misses: 0 };

export function runWithEnvelopeMemo<T>(fn: () => T): T {
  const previous = current;
  current = new Map();
  lastMemoStats.hits = 0;
  lastMemoStats.misses = 0;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

export function memoGet<T>(key: string): T | undefined {
  if (!current) return undefined;
  const v = current.get(key);
  if (v === undefined) { lastMemoStats.misses++; return undefined; }
  lastMemoStats.hits++;
  return v as T;
}

export function memoSet(key: string, value: unknown): void {
  if (current) current.set(key, value);
}
