#!/bin/bash
# Session-start hook: inject Memory Protocol + mandatory resume steps.
# Instruction-injection design: stdout becomes additionalContext for the agent;
# the agent performs all memory calls itself via its MCP tools. This script
# makes no network calls unless the optional context-fetch is enabled.
#
# Pattern adapted from Gentleman-Programming/engram (MIT) — see NOTICE.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=resolve-agent-id.sh
source "$SCRIPT_DIR/resolve-agent-id.sh"
if ! hythe_resolve_agent_id; then
  hythe_identity_error >&2
  exit 2
fi
AGENT_ID="$HYTHE_RESOLVED_AGENT_ID"

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
else
  CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
# The project name is embedded in JSON below: keep it to a JSON-safe set.
PROJECT=$(basename "${CWD:-unknown}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-' | sed 's/-*$//')
PROJECT=${PROJECT:-unknown}

cat <<'PROTOCOL'
## Persistent Memory — ACTIVE PROTOCOL (HYTHE)

You have HYTHE MCP memory tools. This protocol is MANDATORY.

### SESSION START — do these FIRST, before the user's task:
PROTOCOL

printf '1. Call mcp__hythe__resume to recover prior session state and recent context. Note asOf.revision in the result; your session-close checkpoint needs it. Scope {"project":"%s"} is a default from the working directory; use your usual scope if you have one:\n' "$PROJECT"
printf 'mcp__hythe__resume {"agentId":"%s","scope":{"project":"%s"},"budget":4000}\n' "$AGENT_ID" "$PROJECT"
printf '2. Call mcp__hythe__get_ai_messages with agentId: "%s" (defaults: unreadOnly) — other agents may have left you messages. Address or acknowledge anything urgent.\n' "$AGENT_ID"

cat <<'PROTOCOL'

### PROACTIVE SAVE — do NOT wait to be asked
Call mcp__hythe__add_observations IMMEDIATELY after any of these:
- Decision made (architecture, convention, workflow, tool choice) — kind: decision
- Bug fixed (include root cause) — kind: bug or fix
- Non-obvious discovery, gotcha, or edge case — kind: finding
- Correcting something previously stored — kind: correction, WITH supersedes
  (or mode: replace-current) and a canonicalFact
- User preference or constraint learned
Factual claims should carry their source/evidence in the content. Unattested
figures are how bad data enters memory.

Self-check after EVERY task: "Did I or the user just decide, fix, learn, or
correct something? If yes → add_observations NOW."

### SEARCH before re-deriving
Call mcp__hythe__search_entities (searchType: exact for known names) when:
- the user asks to recall anything
- you start work that might have prior history
- a topic appears that you have no context on

### SESSION CLOSE — before saying "done" on substantial work:
PROTOCOL

printf 'Call mcp__hythe__checkpoint with this shape:\n'
printf 'mcp__hythe__checkpoint {"agentId":"%s","scope":{"project":"%s"},"expectedRevision":null,"idempotencyKey":"%s-<short-unique-suffix>","state":{"objective":"<goal>","status":"<what was accomplished>","owner":"%s","nextActions":["<next step>"],"blockers":[],"guardrails":[]},"evidenceRefs":["<relevant file, entity or observation id>"]}\n' "$AGENT_ID" "$PROJECT" "$AGENT_ID" "$AGENT_ID"

cat <<'PROTOCOL'
- expectedRevision: the asOf.revision from your latest resume (null only if
  the scope had no state). A stale value branches; it never overwrites.
- idempotencyKey: at least 8 characters, new for each distinct checkpoint;
  reuse it only when retrying the same call.
- state: all six fields are required; use [] for an empty list. Record
  discoveries with add_observations; state has no field for them.
PROTOCOL

printf '\nProject directory hint: %s\n' "$PROJECT"

exit 0
