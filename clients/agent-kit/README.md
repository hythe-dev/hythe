# HYTHE Agent Kit

Client-side integration kit for the HYTHE memory/coordination server
(https://hythe.dev). Gives any agent CLI persistent memory wiring:
session-start context recovery, **compaction survival**, and a Memory
Protocol the agent actually follows.

> Transition note: during the server's phased migration, the working MCP
> config key and tool prefix remain the legacy names; new installs should
> use the config printed by `npx -y @hythe/mcp init`.

Nothing in this kit touches the server. It is hooks, prompt files, and setup
glue on the client side only.

## Installation (Claude Code)

```bash
claude plugin marketplace add hythe-dev/hythe && claude plugin install hythe
```

That installs the `hythe` plugin (session-start resume, compaction recovery,
Memory Protocol skill). For other agent CLIs, see the per-agent files below
and `setup.sh` for instruction-file wiring.

## Contents

| Path | What it is |
|---|---|
| `claude-code/plugin/` | Claude Code plugin: hooks + scripts + memory skill (the marketplace manifest lives at the repo root, `.claude-plugin/marketplace.json`) |
| `codex/` | Codex CLI: instructions file, compaction prompt file, config.toml snippet |
| `gemini/` | Gemini CLI: system.md managed block |
| `setup.sh` | Minimal marker-block installer for CLAUDE.md / AGENTS.md / GEMINI.md |
| `docs/hub-topology.md` | Official two-machine answer: one authoritative server, clients over tailnet |
| `NOTICE` | Attribution: hook/setup patterns adapted from Gentleman-Programming/engram (MIT) |

## Design decisions

- **Instruction-injection first.** Hooks emit protocol + mandatory recovery
  steps to stdout (Claude Code `additionalContext`); the agent itself performs
  memory calls through its MCP tools. No credentials in hooks by default.
  The bridge connection itself comes from the standard `@hythe/mcp` env
  set (`API_KEY`, `MCP_HOST`, `MCP_PORT`) — generate it with
  `npx -y @hythe/mcp init`.
- **Name-agnostic where possible.** Directory and script names avoid the
  product name; new installs use the `hythe` MCP server key and
  `mcp__hythe__*` tool names (printed by `npx -y @hythe/mcp init`).
- **Agent identity** comes from `HYTHE_AGENT_ID` (legacy `ENGRAM_AGENT_ID` honored; e.g. `claude-desktop`);
  hooks refuse to guess.
