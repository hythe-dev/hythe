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

**Published.** `@hythe/mcp@0.1.2` is the additive HYTHE distribution, with source at [github.com/hythe-dev/hythe](https://github.com/hythe-dev/hythe). New installs use `npx -y @hythe/mcp`. The predecessor `@tomcat65/engram-mcp` and `io.github.tomcat65/engram` remain available as compatibility history and point forward to HYTHE; they are never unpublished.

House rule: every claim in these docs must trace to a test or a measurement (see the evidence ledger below). Claims that don't are bugs.

## Evidence ledger

| Claim | Evidence | Source | Date |
|---|---|---|---|
| Tree green, full gates | lock-verify (manifest-bound pin matched), clean `npm ci`, script-integrity, typecheck, build, tests (33 files, 408 passed \| 2 skipped \| 6 todo), schema-docs, final-tree smoke, docker build — all PASS, exit 0 | this repository, `internal/run-staged-proof.sh` | 2026-07-16 |
| Documented env boots the runtime | Final-tree smoke gate: server starts from `.env.example` variables with a generated key, authenticated MCP request succeeds, DB lands at the documented path, bridge round-trips on the same contract, compose ports are loopback-bound, and the untouched placeholder key fails startup | this repository, `internal/final-tree-smoke.mjs` | 2026-07-16 |
| resume/checkpoint + conflict handling implemented | ENG-4 P0 contract suite (120 executable tests: CAS branching, conflict heads, idempotent replay, budget coverage closedness, scope-bound handles) | `tests/contract-eng4-p0.test.ts` | 2026-07-16 |
| Install path works | CLI contract suite (bin mapping, secret-free wizard configs, protected credential-file loading, .env write-once, live demo round-trip verified server-side, bridge delegation) | `tests/contract-cli.test.ts` | 2026-07-16 |
| Closed-safe defaults | Placeholder key fails startup; compose ports loopback-bound; CORS grants no cross-origin access unless `CORS_ORIGINS` is set (tested) | `internal/final-tree-smoke.mjs`, `tests/contract-cli.test.ts` | 2026-07-16 |
| Discovery is truthful | tools/list advertises the exact frozen schemas the handlers implement; retired legacy shapes are schema-rejected (regressions added after an adversarial review caught drift) | `tests/contract-eng4-p0.test.ts` | 2026-07-16 |
| Published + installable from the registry | `npm publish` succeeded under 2FA (auth-and-writes, security key); `npm view @tomcat65/engram-mcp version` → `0.1.0`; clean-machine smoke: fresh npx cache, `npx -y @tomcat65/engram-mcp --help` and `… init` ran from the registry install | npm registry, post-publish smoke | 2026-07-16 |

## v1 surface (short)

- **Install (two-component setup)**: server via `docker compose up`, then the `@hythe/mcp` stdio bridge per MCP client; first-run wizard stores the API key in a protected `.env` and prints secret-free file-referencing config for Claude Code / Codex / Cursor / Claude Desktop; optional namespaced (`demo-*`) demo seed on an otherwise empty DB.
- **Knowledge graph**: entities, observations, relations, supersession, current-state resolution, conflict surfacing.
- **Agent messaging**: direct, capability-based, superseding; tracked delivery lifecycle.
- **`resume` / `checkpoint`**: budgeted one-call session rehydration with closed coverage accounting, and CAS-protected, branch-preserving structured state capture.
- **ACP**: the coordination protocol as a versioned spec + real worked example.

## License

[Apache-2.0](LICENSE)
