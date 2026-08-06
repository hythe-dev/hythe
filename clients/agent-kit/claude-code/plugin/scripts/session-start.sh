#!/bin/bash
# Session-start hook: inject Memory Protocol + mandatory resume steps.
# Instruction-injection design: stdout becomes additionalContext for the agent;
# the agent performs all memory calls itself via its MCP tools. This script
# makes no network calls unless the optional context-fetch is enabled.
#
# Pattern adapted from Gentleman-Programming/engram (MIT) — see NOTICE.

AGENT_ID="${HYTHE_AGENT_ID:-${ENGRAM_AGENT_ID:-}}"

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
else
  CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
PROJECT=$(basename "${CWD:-unknown}" | tr '[:upper:]' '[:lower:]')

cat <<'PROTOCOL'
## Persistent Memory — ACTIVE PROTOCOL (HYTHE)

You have HYTHE MCP memory tools. This protocol is MANDATORY.

### SESSION START — do these FIRST, before the user's task:
PROTOCOL

if [ -n "$AGENT_ID" ]; then
  printf '1. Call mcp__hythe__resume with agentId: "%s" to recover prior session state and recent context.\n' "$AGENT_ID"
  printf '2. Call mcp__hythe__get_ai_messages with agentId: "%s" (defaults: unreadOnly) — other agents may have left you messages. Address or acknowledge anything urgent.\n' "$AGENT_ID"
else
  cat <<'NOID'
1. HYTHE_AGENT_ID is not set on this machine. Ask the user which agent
   identity to use (e.g. claude-desktop) before writing anything to memory.
2. Once known, call mcp__hythe__resume and mcp__hythe__get_ai_messages with it.
NOID
fi

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
Call mcp__hythe__checkpoint with: goal, discoveries, accomplished, next
steps, relevant files/entities.
PROTOCOL

printf '\nProject directory hint: %s\n' "$PROJECT"

exit 0
