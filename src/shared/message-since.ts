/**
 * The `since` filter of get_ai_messages (and GET /ai-messages/:agentId).
 *
 * Bug (v3 plan P1): `since` was bound as raw text and compared as text
 * against stored timestamps. Stored ai_messages.created_at uses SQLite's
 * "YYYY-MM-DD HH:MM:SS" form, so an ISO value such as 2026-11-18T23:00:00Z
 * compared 'T' (0x54) against ' ' (0x20) and matched nothing on that day,
 * and an offset such as -06:00 was never applied.
 *
 * Fix: parse the caller's value strictly here, normalize it to UTC in one
 * canonical text form, and normalize the stored side to the same form in SQL
 * (SINCE_SQL_FORMAT) before comparing. Invalid input is a validation error,
 * never a silent empty result.
 */
import { echo } from './validation-hints.js';

/** strftime format both sides are normalized to: "YYYY-MM-DD HH:MM:SS.SSS" (UTC). */
export const SINCE_SQL_FORMAT = '%Y-%m-%d %H:%M:%f';

/** Wrap a SQL expression holding a stored timestamp so it compares with a normalized `since`. */
export function normalizedTimestampSql(expression: string): string {
  return `strftime('${SINCE_SQL_FORMAT}', ${expression})`;
}

export interface SinceError {
  error: 'validation_error';
  code: 'INVALID_TIMESTAMP';
  field: 'since';
  value: unknown;
  message: string;
}

export type SinceResult = { ok: true; utc: string } | { ok: false; error: SinceError };

/** Thrown by the storage layer when an unvalidated `since` reaches it. */
export class InvalidSinceError extends Error {
  readonly detail: SinceError;
  constructor(detail: SinceError) {
    super(detail.message);
    this.name = 'InvalidSinceError';
    this.detail = detail;
  }
}

/**
 * Date, optional time (minutes, seconds and a fraction optional), optional
 * zone (Z or +-HH:MM / +-HHMM). Separator T, t or a single space. A zone is
 * only allowed with a time. A value without a zone is UTC, like the stored
 * timestamps.
 */
const SINCE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/** Longest accepted input; anything longer cannot match SINCE_PATTERN. */
const MAX_SINCE_CHARS = 40;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function invalid(value: unknown, reason: string): SinceResult {
  const { shown, value: echoed } = echo(value);
  return {
    ok: false,
    error: {
      error: 'validation_error',
      code: 'INVALID_TIMESTAMP',
      field: 'since',
      value: echoed,
      message:
        `since ${shown} is not a valid timestamp (${reason}). Use ISO 8601, for example ` +
        '2026-11-18T23:00:00Z, 2026-11-18T17:00:00-06:00 or 2026-11-18 23:00:00 (no zone means UTC). ' +
        'Nothing was read.',
    },
  };
}

/** Parse a caller `since` into canonical UTC text "YYYY-MM-DD HH:MM:SS.SSS". */
export function parseSince(value: unknown): SinceResult {
  if (typeof value !== 'string') return invalid(value, 'not a string');
  const text = value.trim();
  if (text.length === 0) return invalid(value, 'empty');
  if (text.length > MAX_SINCE_CHARS) return invalid(value, 'too long');
  const m = SINCE_PATTERN.exec(text);
  if (!m) return invalid(value, 'unrecognized format');

  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  // Milliseconds are the stored precision; extra digits are truncated.
  const ms = Number((frac + '000').slice(0, 3));
  if (month < 1 || month > 12) return invalid(value, 'month out of range');
  if (hour > 23 || minute > 59 || second > 59) return invalid(value, 'time out of range');

  let offsetMinutes = 0;
  if (zone && zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2)), om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return invalid(value, 'zone offset out of range');
    offsetMinutes = sign * (oh * 60 + om);
  }

  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, second, ms);
  const local = check.getTime();
  // Rejects calendar overflow such as 2026-02-30 (Date.UTC would roll it over).
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return invalid(value, 'no such date');
  }
  const t = new Date(local - offsetMinutes * 60_000);
  if (Number.isNaN(t.getTime()) || t.getUTCFullYear() < 0 || t.getUTCFullYear() > 9999) {
    return invalid(value, 'out of range');
  }
  const utc =
    `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}.${pad(t.getUTCMilliseconds(), 3)}`;
  return { ok: true, utc };
}

/**
 * The storage-layer guard: undefined/'' means no filter (unchanged behaviour);
 * anything else must parse, or InvalidSinceError is thrown.
 */
export function sinceForQuery(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseSince(value);
  if (!parsed.ok) throw new InvalidSinceError(parsed.error);
  return parsed.utc;
}
