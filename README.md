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
| [ACP SPEC](docs/SPEC.md) | The coordination protocol, versioned (1.0.0) |
| [Tutorial](docs/TUTORIAL.md) | Annotated transcript of a real Claude Code ↔ Codex review loop from the original Engram deployment |
| [Tool compatibility map](TOOL-COMPATIBILITY-MAP.md) | The 19-tool v1 surface; every retired tool and its exact replacement |
| [Backup & restore](BACKUP-AND-RESTORE.md) | Tested SQLite backup/restore/compaction runbook |

## Status

**Release candidate.** `@hythe/mcp@0.1.3` is the currently published HYTHE
distribution. This tree is the `0.1.4` release candidate: it requires an
explicit per-client `HYTHE_AGENT_ID`, binds bridge actions to that exact lane,
isolates exact mailboxes, and removes private message bodies from shared graph,
search, export, and request-log paths. New installs use `npx -y @hythe/mcp`;
pin `@0.1.3` until `0.1.4` is published. The predecessor
`@tomcat65/engram-mcp` and `io.github.tomcat65/engram` remain available as
compatibility history and are never unpublished.

House rule: every claim in these docs must trace to a test or a measurement (see the evidence ledger below). Claims that don't are bugs.

## Evidence ledger

| Claim | Evidence | Source | Date |
|---|---|---|---|
| Tree green, full gates | Clean `npm ci`; typecheck; build; schema parity; 41 Vitest files (458 passed, 2 skipped, 6 todo); 40 migration assertions; 31 agent-kit checks; 24 release checks; release-tree verifier; and diff check all passed. Production dependency audit: 0 findings. | `.github/workflows/ci.yml`, `tests/`, `src/migrations/007-private-message-residue.node-test.mjs`, `clients/agent-kit/tests/test-setup.sh`, `scripts/verify-hythe-release-tree.test.mjs` | 2026-08-13 |
| Compaction identity fails closed | Startup and post-compaction hooks reject missing, conflicting, or invalid identity; the bridge binds acting tools and message-resource recipients to the configured exact lane before any HTTP request. | `clients/agent-kit/tests/test-setup.sh`, `tests/contract-bridge-identity.test.ts` | 2026-08-13 |
| Exact mailboxes stay isolated | Houston/Hythe, case variants, display metadata, legacy identity history, cross-tenant poisoning, suffix handles, lifecycle changes, supersession, HTTP, and ENG-4 authorship have negative isolation coverage. | `tests/contract-message-identity-isolation.test.ts`, `tests/contract-eng4-p0.test.ts` | 2026-08-13 |
| Private message bodies stay out of shared graph surfaces | Historical, oversized, malformed, alias-linked, relation-linked, imported, exported, searched, graphed, logged, and restored payload paths are covered; hidden children do not leak through counts. | `tests/contract-message-payload-isolation.test.ts`, `tests/contract-data-payload-isolation.test.ts`, `tests/contract-log-confidentiality.test.ts` | 2026-08-13 |
| Cleanup is offline and fail-closed | Migration 007 is dry-run by default, binds execution to a reviewed fingerprint, creates a verified backup, refuses collisions/orphans/malformed rows, handles configured vector tables, and rolls back atomically. The packed command executes `dist/migrations/007-private-message-residue.mjs`. | `src/migrations/007-private-message-residue.mjs`, `src/migrations/007-private-message-residue.node-test.mjs`, `docs/PRIVATE-MESSAGE-RESIDUE-MIGRATION.md` | 2026-08-13 |
| Install and discovery surfaces agree | CLI config generation requires `--agent-id`; registry metadata requires `HYTHE_AGENT_ID`; tools and resource templates served through HTTP match the published stdio bridge path. | `tests/contract-cli.test.ts`, `tests/contract-mcp-resources-http.test.ts`, `scripts/verify-hythe-release-tree.test.mjs` | 2026-08-13 |

## v1 surface (short)

- **Install (two-component setup)**: server via `docker compose up`, then the `@hythe/mcp` stdio bridge per MCP client; first-run wizard stores the API key in a protected `.env` and prints secret-free file-referencing config for Claude Code / Codex / Cursor / Claude Desktop; optional namespaced (`demo-*`) demo seed on an otherwise empty DB.
- **Knowledge graph**: entities, observations, relations, supersession, current-state resolution, conflict surfacing.
- **Agent messaging**: direct, capability-based, superseding; tracked delivery lifecycle.
- **`resume` / `checkpoint`**: budgeted one-call session rehydration with closed coverage accounting, and CAS-protected, branch-preserving structured state capture.
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
