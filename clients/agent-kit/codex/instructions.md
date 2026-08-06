# Memory instructions (HYTHE) — Codex

You have `hythe` MCP tools: persistent memory + agent coordination on one
authoritative server.

## Session start
1. `resume` with your agentId (from env `HYTHE_AGENT_ID`, e.g. `codex-cli`).
2. `get_ai_messages` — check your inbox; other agents leave tasks/answers there.

## While working — save proactively
Call `add_observations` immediately after: a decision (with the why), a bug
fix (with root cause), a non-obvious discovery, a learned constraint.
Factual claims carry their source in the content.

Corrections: `kind: correction` + `canonicalFact` + `supersedes` (or
`mode: replace-current`). Never leave a wrong fact un-superseded.

## Before saying done
`checkpoint` with goal / discoveries / accomplished / next steps / entities.

## Search before re-deriving
`search_entities` — `searchType: exact` for known names, `hybrid` for fuzzy.
Entity state comes from `get_current_observation`.
