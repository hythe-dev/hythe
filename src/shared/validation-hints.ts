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

/** The closest allowed value when it is plausibly a typo (prefix or <= 2 edits). */
export function closest(value: string, allowed: readonly string[]): string | null {
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

const show = (value: unknown) => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));

export function enumError(field: string, value: unknown, allowed: readonly string[]): FieldError {
  const guess = typeof value === 'string' ? closest(value, allowed) : null;
  return {
    error: 'validation_error',
    code: 'INVALID_ENUM',
    field,
    value,
    allowed,
    message: `${field} ${show(value)} is not allowed. Allowed values: ${allowed.join(', ')}.` +
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

/**
 * Like ajv.errorsText, but enum errors name the allowed values and
 * additionalProperties errors name the unknown field.
 */
export function formatSchemaErrors(errors: readonly AjvLikeError[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'no errors';
  return errors.map((e) => {
    const path = `data${e.dataPath ?? e.instancePath ?? ''}`;
    if (e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)) {
      return `${path} must be one of: ${e.params!.allowedValues.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
    }
    if (e.keyword === 'const' && e.params && 'allowedValue' in e.params) {
      return `${path} must be ${JSON.stringify(e.params.allowedValue)}`;
    }
    if (e.keyword === 'additionalProperties' && e.params?.additionalProperty) {
      return `${path} has unknown field "${e.params.additionalProperty}"`;
    }
    return `${path} ${e.message ?? 'is invalid'}`;
  }).join(', ');
}
