<!-- BEGIN HYTHE MEMORY PROTOCOL — managed by setup.sh -->
## Persistent Memory Protocol (HYTHE)

You have HYTHE MCP memory tools (persistent memory + agent coordination).

- SESSION START: call `resume` with agentId from HYTHE_AGENT_ID, then
  `get_ai_messages` (your inbox — other agents leave tasks/answers there).
- SAVE PROACTIVELY via `add_observations`: decisions (with why), bug fixes
  (with root cause), discoveries, learned constraints. Factual claims carry
  their source. Corrections use kind: correction + canonicalFact +
  supersedes/replace-current — never leave a wrong fact standing.
- SEARCH before re-deriving: `search_entities` (exact for known names).
- AFTER ANY COMPACTION OR CONTEXT RESET: call `checkpoint` with the
  compacted summary FIRST, then `resume` to recover state, then continue.
- BEFORE SAYING DONE on substantial work: `checkpoint` with goal /
  discoveries / accomplished / next steps / entities.
<!-- END HYTHE MEMORY PROTOCOL -->
