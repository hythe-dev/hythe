#!/bin/bash
# Post-compaction hook: the compaction-recovery contract.
# Fires on SessionStart matcher "compact". Orders the agent to recover the
# scope's revision, persist the compacted summary as a checkpoint, then
# continue.
#
# The worked examples are emitted as strict single-line JSON so that
# clients/agent-kit/tests and tests/contract-agent-kit-hook-shapes.test.ts can
# validate them against the live resume/checkpoint input schemas. If either
# schema changes, that test fails until this text is updated.
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
# One idempotency key per compaction: a retried checkpoint replays instead of
# writing twice. AGENT_ID is already restricted to [A-Za-z0-9_.:-].
IDEMPOTENCY_KEY="${AGENT_ID}-compact-$(date -u +%Y%m%dT%H%M%SZ)"

echo "CRITICAL INSTRUCTION POST-COMPACTION — follow these steps IN ORDER:"
echo ""
printf 'Scope: {"project":"%s"} is a default taken from the working directory. If you checkpointed under a different scope before compaction, use that scope in steps 1 and 2 instead.\n\n' "$PROJECT"

echo '1. FIRST: recover the scope state (read-only). Call mcp__hythe__resume with exactly these arguments:'
printf 'mcp__hythe__resume {"agentId":"%s","scope":{"project":"%s"},"budget":4000}\n' "$AGENT_ID" "$PROJECT"
cat <<'STEP1'
   Read the returned context carefully: it tells you what was being worked on.
   Note asOf.revision in the result. You need it in step 2.

STEP1

echo '2. THEN: persist the compacted summary above as a checkpoint. If you skip this and the session dies, that work history is gone. Call mcp__hythe__checkpoint with this shape:'
printf 'mcp__hythe__checkpoint {"agentId":"%s","scope":{"project":"%s"},"expectedRevision":null,"idempotencyKey":"%s","state":{"objective":"<goal of the work>","status":"<what is done and what is in progress, from the summary>","owner":"%s","nextActions":["<next step>"],"blockers":[],"guardrails":["<limits you were told to keep>"]},"events":[{"kind":"compaction","summary":"<key discoveries and decisions from the summary>"}]}\n' "$AGENT_ID" "$PROJECT" "$IDEMPOTENCY_KEY" "$AGENT_ID"
cat <<'STEP2'
   - expectedRevision: replace null with the asOf.revision from step 1. Keep
     null only if step 1 returned revision null (no state yet in this scope).
   - idempotencyKey: use the value above unchanged. If the call fails on a
     transport error, retry with the same key AND the same arguments; it
     will not write twice.
   - state: all six fields are required; use [] for an empty list.
   - Put durable discoveries and decisions in mcp__hythe__add_observations as
     well. state has no field for them.

3. If you need detail on a specific topic, call mcp__hythe__search_entities
   with relevant keywords (searchType: exact for known entity names).

4. Check mcp__hythe__get_ai_messages — a message may have arrived while the
   context was being compacted.

5. Only THEN continue the user's task.

All steps are MANDATORY. Without them you lose context and continue blind.
STEP2

exit 0
