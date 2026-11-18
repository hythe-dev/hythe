/**
 * Validation messages that tell the caller how to fix the call.
 * Field report dc041e5c (kimi-desktop-ws01, 2026-10-13):
 *   K1: enum errors did not list the allowed values ("Invalid message type"
 *       for messageType 'inform'; Ajv's "should be equal to one of the
 *       allowed values" without the values).
 *   K2: send_ai_message answered toAgentId/fromAgentId with "Missing
 *       recipient" instead of naming to/from.
 */

/** Levenshtein distance, small inputs only (enum values, field names). */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Longest echoed value in an error; longer input is truncated, never scanned. */
export const MAX_ECHO_CHARS = 64;

/**
 * The closest allowed value when it is plausibly a typo (prefix or <= 2 edits).
 * Input much longer than every allowed value cannot be a typo of one, so it
 * is rejected before any scan: the work stays bounded by the allowed set, not
 * by caller input (codex-hythe review 1148db41: an 8M-character messageType
 * took ~528 ms here before this guard).
 */
export function closest(value: string, allowed: readonly string[]): string | null {
  const longest = allowed.reduce((n, a) => Math.max(n, a.length), 0);
  if (value.length === 0 || value.length > longest + 2) return null;
  const v = value.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of allowed) {
    const c = candidate.toLowerCase();
    const score = c.startsWith(v) || v.startsWith(c) ? 0 : distance(v, c);
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return bestScore <= 2 ? best : null;
}

export interface FieldError {
  error: 'validation_error';
  code: 'INVALID_ENUM' | 'UNKNOWN_FIELD';
  field: string;
  message: string;
  value?: unknown;
  allowed?: readonly string[];
  expected?: string;
}

/**
 * A bounded echo of caller input: strings are cut to MAX_ECHO_CHARS with the
 * original length noted; other types are described by type, never serialized.
 */
export function echo(value: unknown): { shown: string; value: unknown } {
  if (typeof value === 'string') {
    if (value.length <= MAX_ECHO_CHARS) return { shown: `"${value}"`, value };
    const cut = value.slice(0, MAX_ECHO_CHARS);
    return { shown: `"${cut}..." (${value.length} characters)`, value: `${cut}...` };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value);
    if (text.length <= MAX_ECHO_CHARS) return { shown: text, value };
  }
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return { shown: `a value of type ${kind}`, value: `<${kind}>` };
}

export function enumError(field: string, value: unknown, allowed: readonly string[]): FieldError {
  const guess = typeof value === 'string' ? closest(value, allowed) : null;
  const { shown, value: echoed } = echo(value);
  return {
    error: 'validation_error',
    code: 'INVALID_ENUM',
    field,
    value: echoed,
    allowed,
    message: `${field} ${shown} is not allowed. Allowed values: ${allowed.join(', ')}.` +
      (guess ? ` Did you mean "${guess}"?` : ''),
  };
}

export function unknownFieldError(field: string, expected: string): FieldError {
  return {
    error: 'validation_error',
    code: 'UNKNOWN_FIELD',
    field,
    expected,
    message: `Unknown field "${field}". Use "${expected}" instead. Nothing was sent.`,
  };
}

/**
 * Field names callers commonly use for send_ai_message, mapped to the real
 * ones. `agentId` and `message` are not here: they are documented aliases.
 */
export const SEND_FIELD_MISNAMES: Readonly<Record<string, string>> = {
  toAgentId: 'to', toAgent: 'to', to_agent: 'to', toAgentID: 'to', recipient: 'to', recipientId: 'to', target: 'to',
  fromAgentId: 'from', fromAgent: 'from', from_agent: 'from', fromAgentID: 'from', sender: 'from', senderId: 'from',
  type: 'messageType', message_type: 'messageType', msgType: 'messageType',
  body: 'content', text: 'content',
};

/**
 * A misnamed field is an error when the real field is absent, or present with
 * a different value. Without this, `{to, fromAgentId, content}` was sent and
 * attributed to the server's own identity, because `from` falls back to it.
 */
export function misnamedSendField(args: Record<string, unknown>): FieldError | null {
  for (const [wrong, right] of Object.entries(SEND_FIELD_MISNAMES)) {
    if (!(wrong in args)) continue;
    if (!(right in args) || args[right] !== args[wrong]) return unknownFieldError(wrong, right);
  }
  return null;
}

interface AjvLikeError {
  keyword: string;
  dataPath?: string;
  instancePath?: string;
  message?: string;
  params?: Record<string, any>;
}

/** Longest data path echoed in a schema error (paths can carry caller keys). */
export const MAX_PATH_CHARS = 128;
/** Most schema errors listed in one message; the rest are counted. */
export const MAX_LISTED_ERRORS = 10;
/** Hard cap on the whole formatted schema-error text. */
export const MAX_SCHEMA_ERROR_CHARS = 2000;

/** Cut caller-derived text to `max` characters, noting the original length. */
function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} characters)`;
}

/**
 * A field name from caller input, quoted and escaped (JSON string rules), and
 * cut to MAX_ECHO_CHARS with the original length noted. codex-hythe PR #20
 * review: a 1,000,000-character unknown property name was echoed in full.
 */
export function echoFieldName(name: unknown): string {
  if (typeof name !== 'string') return `a field name of type ${typeof name}`;
  if (name.length <= MAX_ECHO_CHARS) return JSON.stringify(name);
  return `${JSON.stringify(name.slice(0, MAX_ECHO_CHARS))}... (${name.length} characters)`;
}

/**
 * Like ajv.errorsText, but enum errors name the allowed values and
 * additionalProperties errors name the unknown field. Everything taken from
 * caller input is bounded: each field name (MAX_ECHO_CHARS, escaped), each
 * path (MAX_PATH_CHARS), the number of errors listed (MAX_LISTED_ERRORS, the
 * rest counted), and the whole text (MAX_SCHEMA_ERROR_CHARS).
 */
export function formatSchemaErrors(errors: readonly AjvLikeError[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'no errors';
  const listed = errors.slice(0, MAX_LISTED_ERRORS).map((e) => {
    const path = bounded(`data${e.dataPath ?? e.instancePath ?? ''}`, MAX_PATH_CHARS);
    if (e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)) {
      return `${path} must be one of: ${e.params!.allowedValues.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
    }
    if (e.keyword === 'const' && e.params && 'allowedValue' in e.params) {
      return `${path} must be ${JSON.stringify(e.params.allowedValue)}`;
    }
    if (e.keyword === 'additionalProperties' && e.params?.additionalProperty !== undefined) {
      return `${path} has unknown field ${echoFieldName(e.params.additionalProperty)}`;
    }
    return `${path} ${bounded(e.message ?? 'is invalid', MAX_PATH_CHARS)}`;
  });
  const more = errors.length - listed.length;
  const text = listed.join(', ') + (more > 0 ? `, and ${more} more error${more === 1 ? '' : 's'}` : '');
  return text.length <= MAX_SCHEMA_ERROR_CHARS
    ? text
    : `${text.slice(0, MAX_SCHEMA_ERROR_CHARS)}... (error text cut at ${MAX_SCHEMA_ERROR_CHARS} characters)`;
}
