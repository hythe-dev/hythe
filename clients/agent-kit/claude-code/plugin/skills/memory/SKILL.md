---
name: memory
description: Memory Protocol for the HYTHE server — when and how to save, search, checkpoint, and resume. Use when deciding whether something belongs in persistent memory, how to record a correction, or how to recover context.
---

# Memory Protocol (HYTHE)

One authoritative server holds the knowledge graph (entities → observations →
relations), agent inboxes, and session checkpoints. You talk to it through
`mcp__hythe__*` tools.

## What belongs in memory

Save (via `add_observations`) when any of these happen:

| Event | kind | Notes |
|---|---|---|
| Decision made | `decision` | include the why, not just the what |
| Bug fixed | `bug` / `fix` | root cause mandatory |
| Non-obvious discovery | `finding` | |
| Prior memory was wrong | `correction` | MUST supersede — see below |
| Proposal/design produced | `proposal` | |
| Handoff to another agent | `handoff` | also send_ai_message |

**Provenance rule:** factual claims carry their source in the content
(URL, command output, message id). An unattested figure is future bad data.

## Corrections — the one thing you must not get wrong

A correction that merely *adds* leaves the wrong fact as a sibling. Always:
- `kind: correction`, with `canonicalFact` stating the corrected truth
- `supersedes: [<old-observation-id>]`, or `mode: replace-current` to
  supersede the entity's current observation server-side

## Retrieval

- Known entity name → `search_entities` with `searchType: exact` (fast, precise)
- Fuzzy/exploratory → `searchType: hybrid`, keep `limit` small, `compact: true`
- Entity state → `get_current_observation` (NOT the embedded observations
  array, which is a creation-time snapshot)
- Full content of one item → `get_entity_detail` / `get_message_detail`

## Sessions

- Start of session: `resume` (recovers prior state), then `get_ai_messages`
  (inbox — other agents leave work and answers there)
- Substantial work finished, or compaction happened: `checkpoint` with
  goal / discoveries / accomplished / next steps / relevant entities
- Replying to another agent: `send_ai_message` with `from` = your agentId;
  use `supersedes` when replacing an earlier message of yours

## Identity

Your agentId comes from `HYTHE_AGENT_ID` (e.g. `claude-desktop`; legacy
`ENGRAM_AGENT_ID` is honored only when it agrees). Never invent one; never
write attributed memory under another agent's id except an explicitly
authorized proxy write (say so in the content).
