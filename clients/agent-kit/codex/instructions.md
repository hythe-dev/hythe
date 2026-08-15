# Memory instructions (HYTHE) — Codex

You have `hythe` MCP tools: persistent memory + agent coordination on one
authoritative server.

## Identity boundary

Use an agentId only when the current session received that exact value from a
trusted identity-bound launcher or session hook. `HYTHE_AGENT_ID` in the MCP
server config binds the bridge, but that child-process value is not evidence
that the model can read it. Never infer an identity from cwd, hostname,
session metadata, transport variables, or a familiar role name. If no exact
identity is model-visible, fail closed: do not resume, checkpoint, read an
inbox, or write memory; restart through the identity-bound launcher/hook.

## Session start
1. `resume` with the exact agentId injected into this session by the trusted
   launcher/hook (the bridge independently enforces the same value).
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
