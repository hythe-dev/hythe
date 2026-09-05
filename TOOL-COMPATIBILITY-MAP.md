# Engram v1 Tool Compatibility Map (Step-3 tool diet)

Authorized: adversarial review `4320b5c5` + owner GO; corrected per review
`b2543ebc` (lifecycle symmetry + bounded adjacency kept). Registry of
record: `src/unified-server/eng4/register.ts` — `tools/list` is built
exclusively from `RETAINED_LEGACY_TOOLS + READ_DISCOVERY_TOOLS + ENG4_TOOLS`,
so nothing retired can linger in discovery accidentally.

## Surface: 33 → 20

### New canonical primitives (2)
| Tool | Notes |
|---|---|
| `resume` | Read primitive. Replaces `get_agent_context` (frozen D4 transition). Frozen v1/v2 input/output schemas; output Ajv-validated in every build before transport; text fallback = the same validated object. `resultVersion: 3` returns the head-selection model (`asOf.selection`/`pointer`, `heads`, provenance-bearing `currentFacts`/`openLoops`, `divergentValues`, `legacyValues`). |
| `checkpoint` | Write primitive. Branch-preserving CAS + fingerprint idempotency + transactional fact/loop changes. `resultVersion: 3` adds the `operation` discriminant: `reconcile` (fold heads, retire, resolve divergent values), `record` (changes without state) and `patch` (RFC 7396 merge patch) — the last two admit only the pointed head. See [docs/CHECKPOINT-RESUME-V3.md](docs/CHECKPOINT-RESUME-V3.md). |

History/snapshot/message/handoff fetch is a **resource** (`engram://…` via
`resources/list` templates + `resources/read`), deliberately never a tool.

### Read-only knowledge discovery (1)
| Tool | Notes |
|---|---|
| `discover_related_context` | Exact-resolves a project/task scope, automatically retrieves bounded vector candidates, reranks them with one/two-hop graph paths, and returns score/currentness/evidence/provenance explanations under a hard response budget. It never creates a relation or changes memory; durable graph writes remain an explicit `create_relations` step after validation. |

### Retained legacy tools (17)
`create_entities`, `add_observations`, `get_current_observation`,
`create_relations`, `search_entities`, `get_entity_detail`,
`get_entity_neighborhood` (bounded typed adjacency — keeps relations
readable, not write-only), `send_ai_message`, `get_ai_messages`,
`get_message_detail`, `archive_messages`, `register_agent`,
`unregister_agent` (lifecycle symmetry with `register_agent`),
`get_agent_status`, `set_agent_identity`, `begin_session`, `end_session`.

`begin_session` / `end_session` are **compatibility lifecycle wrappers**
(B2, committed): `begin_session` delegates through
`adaptLegacyBeginSessionArgs` → `performBeginSession` (resume + explicit
`ackHandoffIds` acks — never auto-consumed, no skeleton creation, no Slack);
`end_session` delegates to `performEndSession` (= checkpoint) and REQUIRES
checkpoint-shaped args `{agentId, scope, expectedRevision, idempotencyKey,
state, …}` — the legacy `{projectId, summary, openItems}` shape returns a
migration error. `tools/list` advertises exactly these B2 contracts
(`UnifiedToolSchemas` references the frozen eng4 schema objects; review
verdict a6c75553).

### Retired from discovery (16)
Removed from `tools/list` now, each with its EXACT replacement path.
**Handlers remain callable** as a documented, test-covered compatibility
surface (existing suites exercise them); call-blocking/physical removal
happens at the owner-gated cutover after dependent clients migrate.

| Retired tool | Exact replacement path |
|---|---|
| `get_agent_context` | `resume({agentId, scope:{project|task}, budget})` — same bootstrap intent, scoped + budget-accounted (D4). Handler transitioned in B2: calls now return a migration error pointing to `resume`. |
| `search_nodes` | `search_entities({query, ...})` — identical query surface; `search_nodes` was a thin alias. |
| `read_graph` | Bounded reads: `search_entities` (discovery) + `get_entity_detail({ids})` (content) + `get_entity_neighborhood({entity})` (adjacency). Full-graph export is an operator/export path, not an agent tool. |
| `get_entity_backlinks` | `get_entity_neighborhood({entity, direction:'in'})` — the retained adjacency reader covers inbound edges. |
| `compact_memory` | Operator runbook (ENG-2 compaction procedure) — admin action, never agent-initiated. |
| `gc_agent_registrations` | Operator runbook — admin GC; agent-side lifecycle is `register_agent`/`unregister_agent`. |
| `delete_entity` | Operator runbook (destructive). Agent-side correction path: `add_observations` mode `replace-current` to supersede content. |
| `remove_observations` | `add_observations` mode `replace-current` (supersede) — destructive removal is operator-only. |
| `update_observation` | `add_observations` mode `replace-current` — same effect with an audit trail. |
| `delete_observations_by_entity` | Operator runbook (destructive bulk). |
| `get_user_profile` | Dropped from v1 (no agent-facing consumer); tenant/user context is server-side. |
| `update_user_profile` | Dropped from v1; profile edits are an owner/console action. |
| `set_preferences` | Dropped from v1; preferences fold into entity observations where needed. |
| `mark_messages_read` | `get_message_detail({agentId, messageId})` marks read; `archive_messages({..., markAsRead:true})` for batches. |
| `record_learning` | `add_observations` (prose) or `checkpoint` factChanges (typed assertions with refs). |
| `get_individual_memory` | Dropped from v1 (legacy individual-memory store); `search_entities`/`get_entity_detail` over shared memory. |
