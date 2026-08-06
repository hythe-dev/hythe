#!/bin/bash
# Post-compaction hook: the compaction-recovery contract.
# Fires on SessionStart matcher "compact". Orders the agent to persist the
# compacted summary FIRST, then recover context, then continue.
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

echo "CRITICAL INSTRUCTION POST-COMPACTION — follow these steps IN ORDER:"
echo ""

if [ -n "$AGENT_ID" ]; then
  printf '1. FIRST: call mcp__hythe__checkpoint with the content of the compacted summary above (agentId: "%s", project hint: "%s"). This preserves what was accomplished before compaction — if you skip it and the session dies, that work history is gone.\n\n' "$AGENT_ID" "$PROJECT"
  printf '2. THEN: call mcp__hythe__resume with agentId: "%s" to recover session history and current observations. Read the returned context carefully — it tells you what was being worked on.\n\n' "$AGENT_ID"
else
  cat <<'NOID'
1. HYTHE_AGENT_ID is not set. Ask the user which agent identity applies,
   then perform steps 1-2 with it (checkpoint the compacted summary, then resume).

NOID
fi

cat <<'STEPS'
3. If you need detail on a specific topic, call mcp__hythe__search_entities
   with relevant keywords (searchType: exact for known entity names).

4. Check mcp__hythe__get_ai_messages — a message may have arrived while the
   context was being compacted.

5. Only THEN continue the user's task.

All steps are MANDATORY. Without them you lose context and continue blind.
STEPS

exit 0
