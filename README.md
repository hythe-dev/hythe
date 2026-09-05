# HYTHE

**A coordination bus + shared truth for your agent fleet.** Self-hosted, two-component setup: a dockerized server plus a thin stdio bridge for your MCP clients.

HYTHE is an MCP server that lets multiple AI coding agents — Claude Code, Codex, Cursor, custom harnesses — share state, preserve context across sessions, and coordinate with each other. It is not another memory store. Its differentiators:

- **Supersession + current-state resolution**: observations supersede each other (`replace-current`), and `get_current_observation` resolves the chain server-side — so readers get the newest non-superseded state. **Conflict handling is implemented**: `checkpoint` is branch-preserving CAS — concurrent writers branch rather than overwrite, and conflicts surface as heads, never silently resolved (contract-tested; see the evidence ledger).
- **Agent messaging with a tracked delivery lifecycle**: direct and capability-based sends, message supersession, read-state as a shared signal, atomic ack+archive. (Described as *tracked lifecycle*, not guaranteed delivery — the states are honest about what the server knows.)
- **The Adaptive Coordination Protocol (ACP)**: the ETA-driven coordination discipline that co-evolved with the server — published as [docs/SPEC.md](docs/SPEC.md) with a [real two-harness worked tutorial](docs/TUTORIAL.md).

## Documentation

| Doc | What it covers |
|---|---|
| [Quickstart](docs/QUICKSTART.md) | Clean machine → two coordinating agents in ~15 minutes |
| [Concepts](docs/CONCEPTS.md) | One current truth, messaging lifecycle, resume/checkpoint, honest security model |
| [Checkpoint / resume v3](docs/CHECKPOINT-RESUME-V3.md) | Current-head pointer, reconciliation, record / patch, the v3 read model, and the one-time adoption step for scopes written before v3 |
| [ACP SPEC](docs/SPEC.md) | The coordination protocol, versioned (1.0.0) |
| [Tutorial](docs/TUTORIAL.md) | Annotated transcript of a real Claude Code ↔ Codex review loop from the original Engram deployment |
| [Tool compatibility map](TOOL-COMPATIBILITY-MAP.md) | The 20-tool v1 surface; every retired tool and its exact replacement |
| [Backup & restore](BACKUP-AND-RESTORE.md) | Tested SQLite backup/restore/compaction runbook |
| [Agent credential operator](docs/AGENT-CREDENTIAL-OPERATOR.md) | Offline issuance, attestation, promotion, rotation, and revocation |
| [Private-residue adjudication](docs/PRIVATE-MESSAGE-RESIDUE-ADJUDICATION.md) | Hash-bound, owner-approved disposition of ambiguous historical rows |
| [SQLite physical sanitation](docs/SQLITE-PHYSICAL-SANITATION.md) | Verified offline VACUUM and no-clobber promotion after logical cleanup |
| [Pavilion production](docs/PAVILION-PRODUCTION.md) | Pinned deployment, readiness, shutdown, canary, and rollback contract |

## Status

**Version 0.2.0.** This source tree and package define the reviewed 0.2.0
release. Version 0.2.0 preserves 0.1.7's dual-proof agent authorization,
exact-mailbox/private-payload containment, bounded related-context discovery,
latency-SLO recovery and the offline adjudicator, and adds `checkpoint` /
`resume` `resultVersion: 3`: an explicit current-head pointer per scope, a
`reconcile` operation that folds live heads into one survivor and resolves
divergent values causally, append-only verified fact/loop versions, a read
model that only promotes values proven on the accepted lineage, and
`record` / `patch` operations on the pointed head. Every v1 / v2 request and
result shape is frozen; v3 is opt-in per call, so a 0.1.7 client keeps working
against a 0.2.0 server. The dependency tree moved to Express 5, clearing two
moderate `qs` advisories. This release runs on the reference production host
since 2026-09-05. All 0.2.0 rollout configurations pin `@hythe/mcp@0.2.0`;
verify that the registry returns that exact version before production use. The
predecessor `@tomcat65/engram-mcp` and `io.github.tomcat65/engram` remain
available as compatibility history and are never unpublished. See
[CHANGELOG.md](CHANGELOG.md) and the [v3 guide](docs/CHECKPOINT-RESUME-V3.md).

House rule: every claim in these docs must trace to a test or a measurement (see the evidence ledger below). Claims that don't are bugs.

## Evidence ledger

| Claim | Evidence | Source | Date |
|---|---|---|---|
| Tree green, full gates | Source and clean installed-package gates cover 49 Vitest files (530 passed, 2 skipped, 6 explicit todos), 107 migration checks, 43 release-tree checks, 31 agent-kit checks, zero production npm audit findings, registry validation, and an isolated Docker start/readiness/MCP/WebSocket/graceful-shutdown canary. | `.github/workflows/ci.yml`, `tests/`, `src/migrations/`, `clients/agent-kit/tests/test-setup.sh`, `scripts/verify-hythe-release-tree.test.mjs`, `scripts/verify-packed-consumer.mjs` | 2026-08-14 |
| Compaction identity fails closed | Startup and post-compaction hooks reject missing, conflicting, or invalid identity; the bridge binds acting tools and message-resource recipients to the configured exact lane before any HTTP request. | `clients/agent-kit/tests/test-setup.sh`, `tests/contract-bridge-identity.test.ts` | 2026-08-13 |
| Exact mailboxes stay isolated | Houston/Hythe, case variants, display metadata, legacy identity history, cross-tenant poisoning, suffix handles, lifecycle changes, supersession, HTTP, and ENG-4 authorship have negative isolation coverage. | `tests/contract-message-identity-isolation.test.ts`, `tests/contract-eng4-p0.test.ts` | 2026-08-13 |
| Private message bodies stay out of shared graph surfaces | Historical, oversized, malformed, alias-linked, relation-linked, imported, exported, searched, graphed, logged, and restored payload paths are covered; hidden children do not leak through counts. | `tests/contract-message-payload-isolation.test.ts`, `tests/contract-data-payload-isolation.test.ts`, `tests/contract-log-confidentiality.test.ts` | 2026-08-13 |
| Cleanup is offline and fail-closed | Migration 007, owner-approved adjudication, and physical sanitation are dry-run/plan-first, bind execution to reviewed database and decision evidence, require verified no-clobber artifacts, refuse unresolved custody, and preserve rollback state. | `src/migrations/007-private-message-residue.mjs`, `src/migrations/private-message-residue-adjudication.mjs`, `src/migrations/vacuum-sanitized-database.mjs`, `docs/` | 2026-08-14 |
| Per-agent authority is server-derived | The base key proves deployment/tenant access; a separate protected-file `hya1` credential proves the exact agent. Required mode rejects stripped proof, mismatched identity, insufficient scope, revoked credentials, and stale WebSocket sessions. | `src/agent-auth/`, `tests/contract-agent-auth-foundation.test.ts`, `tests/contract-agent-auth-server.test.ts`, `tests/contract-agent-key-client.test.ts` | 2026-08-14 |
| Install and discovery surfaces agree | CLI and registry surfaces require an exact lane identity and expose only a protected per-agent key-file path plus an explicit authorization mode; tools and resource templates served through HTTP match the stdio bridge path. | `tests/contract-cli.test.ts`, `tests/contract-agent-key-client.test.ts`, `tests/contract-mcp-resources-http.test.ts`, `scripts/verify-hythe-release-tree.test.mjs` | 2026-08-14 |
| Current head is explicit, never guessed | The pointer advances only from the pointed head; stale parents branch without becoming current; a pointer at a non-live snapshot fails closed; snapshot rows are immutable by trigger. 33 contract tests. | `tests/contract-eng4-h1-head-pointer.test.ts` | 2026-09-03 |
| Versions and coverage are exact and verified | Every ledger tuple gets exactly one disposition; the startup backfill is all-or-nothing and idempotent; a bidirectional parity verifier fails closed on any missing, extra or mismatched row. 32 contract tests. | `tests/contract-eng4-h2-version-foundation.test.ts` | 2026-09-03 |
| Reconciliation is CAS-bound and causal | Exact live-head set and pointer are compare-and-set; every non-survivor head is retired (never deleted); divergent values resolve only by bound accept, reject or lineage reject; the record is payload-bound and re-verified on replay and read. 34 contract tests. | `tests/contract-eng4-h3-reconcile.test.ts` | 2026-09-04 |
| The v3 read model promotes only proven values | `currentFacts` / `openLoops` come only from verified versions on the accepted lineage with provenance; everything else is accounted as divergent or legacy with closed coverage. 29 contract tests. | `tests/contract-eng4-h4-read-model.test.ts` | 2026-09-04 |
| record / patch cannot promote stale state | Only the pointed head is admitted (conflict otherwise); state is materialized from the hash-verified payload; each payload is read once per call; snapshot resources serve exactly the verified bytes. 21 contract tests, four review rounds. | `tests/contract-eng4-h5-record-patch.test.ts` | 2026-09-04 |
| Express 5 keeps the HTTP contract | A bodiless or wrong-content-type request is handled like an empty JSON body on every parsed route, never a framework 500; production audit reports zero findings. | `tests/contract-express5-body-contract.test.ts`, `.github/workflows/ci.yml` run 33878587010 | 2026-09-04 |
| Production migration verified on a copy first | The v3 schema and backfill were exercised against a copy of the production database on the production host before cutover; the live cutover took 17 s with row counts identical to the verified cold backup. | `docs/PAVILION-PRODUCTION.md`; operator log `engram-prod/releases/hythe-74a324c-cutover-20260905T005551Z.log` on the host | 2026-09-05 |

## v1 surface (short)

- **Install (two-component setup)**: server via `docker compose up`, then the `@hythe/mcp` stdio bridge per MCP client; first-run wizard stores the API key in a protected `.env` and prints secret-free file-referencing config for Claude Code / Codex / Cursor / Claude Desktop; optional namespaced (`demo-*`) demo seed on an otherwise empty DB.
- **Knowledge graph**: entities, observations, relations, supersession, current-state resolution, conflict surfacing.
- **Related-context discovery**: exact scope anchoring plus automatic bounded vector retrieval and graph-path reranking, with currentness/evidence/provenance explanations and no implicit writes.
- **Agent messaging**: direct, capability-based, superseding; tracked delivery lifecycle.
- **`resume` / `checkpoint`**: budgeted one-call session rehydration with closed coverage accounting, and CAS-protected, branch-preserving structured state capture. With `resultVersion: 3`: an explicit current-head pointer, `reconcile` to fold heads and resolve divergent values, verified fact/loop versions with provenance, and `record` / `patch` on the pointed head — see the [v3 guide](docs/CHECKPOINT-RESUME-V3.md).
- **ACP**: the coordination protocol as a versioned spec + real worked example.

## Embedding runtime contract

The published npm package does not install a transformer engine by default.
Without one, HYTHE still provides deterministic 384-dimension token-hash
vectors plus lexical ranking; it does not download a model or create a model
cache. `@xenova/transformers@2.17.2` is an optional peer for operators who
deliberately provide it from their own audited dependency root.

The Docker image keeps semantic behavior stable through a separate, locked
`/opt/hythe-transformers` runtime. Its startup preflight loads the configured
`Xenova/all-MiniLM-L6-v2` q8 model and requires one finite 384-dimension
embedding before the server starts. When
`SQLITE_VEC_ALLOW_REMOTE_MODELS=false`, the configured
`SQLITE_VEC_CACHE_DIR` must already contain that model. Do not switch between
transformer and hash embeddings on a populated vector index: retain the same
provider/model/dimensions or rebuild the vector index first.

## License

[Apache-2.0](LICENSE)
