/**
 * ENG-4 registration module (Step-3 item B, sol 4320b5c5 + owner GO) —
 * the ONLY place the v1 tool surface is defined.
 *
 * - resume + checkpoint register schema+handler ATOMICALLY: both live here,
 *   the server delegates by name, and the tools/list entry uses the SAME
 *   frozen input schema objects the handler validates against.
 * - Ajv {$data: true} validators are compiled ONCE at module load and run
 *   in EVERY build (no NODE_ENV gating): malformed runtime output throws
 *   Eng4OutputValidationError BEFORE any transport object is constructed.
 * - structuredContent and the MCP text fallback are derived from the SAME
 *   validated object (text = JSON.stringify(validated)).
 * - History stays a RESOURCE: engram:// templates are exported for MCP
 *   resources/list + resources/read; there is deliberately no third tool.
 * - Tool diet (v1 surface, see TOOL-COMPATIBILITY-MAP.md): tools/list is
 *   built EXCLUSIVELY from RETAINED_LEGACY_TOOLS + ENG4_TOOLS, so a
 *   retired tool can never linger in discovery accidentally. Retired-tool
 *   HANDLERS remain callable as a documented, test-covered compatibility
 *   surface until the owner-gated cutover; call-blocking happens there,
 *   not here.
 */
import Ajv from 'ajv';
import type DatabaseType from 'better-sqlite3';
import type { ToolDefinition } from '../../shared/toolSchemas.js';
import {
  RESUME_INPUT_SCHEMA,
  RESUME_OUTPUT_SCHEMA,
  CHECKPOINT_INPUT_SCHEMA,
  CHECKPOINT_OUTPUT_SCHEMA,
} from './schemas.js';
import { performResume, type ResumeDirectory } from './resume.js';
import { performCheckpoint } from './checkpoint.js';
import { fetchResourceByUri } from './resource.js';

// $data:true is a RUNTIME requirement (coverage closedness uses $data refs).
// Compiled once; used in every build — production included.
const ajv = new Ajv({ allErrors: true, $data: true });
const validate = {
  resumeInput: ajv.compile(RESUME_INPUT_SCHEMA as any),
  resumeOutput: ajv.compile(RESUME_OUTPUT_SCHEMA as any),
  checkpointInput: ajv.compile(CHECKPOINT_INPUT_SCHEMA as any),
  checkpointOutput: ajv.compile(CHECKPOINT_OUTPUT_SCHEMA as any),
};

/** Malformed runtime output — fails CLOSED before transport. */
export class Eng4OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Eng4OutputValidationError';
  }
}

export class Eng4InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Eng4InputValidationError';
  }
}

/** The two canonical primitives — exactly two, never a third (history is a resource). */
export const ENG4_TOOLS: ToolDefinition[] = [
  {
    name: 'resume',
    description: 'Rebuild working context for a project/task scope: current state, open loops, scoped messages/handoffs, facts, decisions, evidence handles and pointers — with closed per-section coverage accounting under a hard token budget. Read-only; never consumes messages or handoffs. Replaces get_agent_context.',
    inputSchema: RESUME_INPUT_SCHEMA as any,
  },
  {
    name: 'checkpoint',
    description: 'Write an immutable, branch-preserving state snapshot for a scope (CAS on expectedRevision; stale parents branch, never conflict) with fingerprint-verified idempotency, plus transactional fact/loop changes. The counterpart of resume.',
    inputSchema: CHECKPOINT_INPUT_SCHEMA as any,
  },
];

/** Legacy tools RETAINED on the v1 surface (see TOOL-COMPATIBILITY-MAP.md). */
export const RETAINED_LEGACY_TOOLS: readonly string[] = [
  'create_entities',
  'add_observations',
  'get_current_observation',
  'create_relations',
  'search_entities',
  'get_entity_detail',
  'send_ai_message',
  'get_ai_messages',
  'get_message_detail',
  'archive_messages',
  'register_agent',
  'unregister_agent', // lifecycle symmetry with register_agent (sol b2543ebc)
  'get_agent_status',
  'set_agent_identity',
  'get_entity_neighborhood', // bounded typed adjacency — relations must not be write-only (sol b2543ebc)
  'begin_session',
  'end_session',
];

/** Retired from DISCOVERY now; handlers stay callable until cutover. */
export const RETIRED_TOOLS: ReadonlySet<string> = new Set([
  'get_agent_context',
  'search_nodes',
  'read_graph',
  'get_entity_backlinks',
  'compact_memory',
  'gc_agent_registrations',
  'delete_entity',
  'remove_observations',
  'update_observation',
  'delete_observations_by_entity',
  'get_user_profile',
  'update_user_profile',
  'set_preferences',
  'mark_messages_read',
  'record_learning',
  'get_individual_memory',
]);

/** Output validation used by the handler itself — exported so tests prove
 * the exact compiled instances reject malformed objects. */
export function validateEng4Output(kind: 'resume' | 'checkpoint', value: unknown): void {
  const validator = kind === 'resume' ? validate.resumeOutput : validate.checkpointOutput;
  if (!validator(value)) {
    throw new Eng4OutputValidationError(`eng4: ${kind} output failed frozen-schema validation — ${ajv.errorsText(validator.errors)}`);
  }
}

export interface Eng4ToolDeps {
  db: DatabaseType.Database;
  directory: ResumeDirectory;
  /** From the server-side request context — NEVER caller-supplied. */
  tenantId: string;
}

/** Atomic handler for the two primitives. */
export function handleEng4Tool(
  name: string,
  args: Record<string, unknown>,
  deps: Eng4ToolDeps
): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  if (name === 'resume') {
    if (!validate.resumeInput(args)) {
      throw new Eng4InputValidationError(`resume: invalid params — ${ajv.errorsText(validate.resumeInput.errors)}`);
    }
    const bundle = performResume(deps.db, deps.directory, deps.tenantId, args as any);
    validateEng4Output('resume', bundle); // fail closed BEFORE transport
    return { content: [{ type: 'text', text: JSON.stringify(bundle) }], structuredContent: bundle };
  }
  if (name === 'checkpoint') {
    if (!validate.checkpointInput(args)) {
      throw new Eng4InputValidationError(`checkpoint: invalid params — ${ajv.errorsText(validate.checkpointInput.errors)}`);
    }
    const result = performCheckpoint(deps.db, deps.directory, deps.tenantId, args as any);
    validateEng4Output('checkpoint', result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  throw new Eng4InputValidationError(`eng4: unknown tool ${name}`);
}

/** engram:// discovery templates (resources/list). History is never a tool. */
export const ENG4_RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'engram://snapshot/{scopeKey}/{stateId}',
    name: 'engram-snapshot',
    description: 'Immutable state snapshot for a scope; payload hash+size verified on every read.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'engram://message/{scopeKey}/{messageId}',
    name: 'engram-message',
    description: 'Full body of a scoped message handle (scope-bound; tenant is the security boundary).',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: 'engram://handoff/{scopeKey}/{handoffId}',
    name: 'engram-handoff',
    description: 'Full summary of a scoped handoff handle (reading never consumes).',
    mimeType: 'text/plain',
  },
] as const;

/** resources/read implementation over the verified fetch path. */
export function readEng4Resource(
  db: DatabaseType.Database,
  tenantId: string,
  uri: string
): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  const fetched = fetchResourceByUri(db, tenantId, uri);
  if (fetched.kind === 'state-snapshot') {
    return { contents: [{ uri, mimeType: fetched.mediaType, text: fetched.body.toString('utf8') }] };
  }
  return { contents: [{ uri, mimeType: 'text/plain', text: fetched.body }] };
}
