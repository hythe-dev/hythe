# HYTHE Agent Kit

Client-side integration kit for the HYTHE memory/coordination server
(https://hythe.dev). Gives any agent CLI persistent memory wiring:
session-start context recovery, **compaction survival**, and a Memory
Protocol the agent actually follows.

> Transition note: during the server's phased migration, the working MCP
> config key and tool prefix remain the legacy names; new installs should
> use the config printed by `npx -y @hythe/mcp@0.1.6 init --agent-id <agent-id>`.

Nothing in this kit touches the server. It is hooks, prompt files, and setup
glue on the client side only.

## Installation (Claude Code)

```bash
claude plugin marketplace add hythe-dev/hythe && claude plugin install hythe
HYTHE_AGENT_ID=claude-desktop claude
```

That installs the `hythe` plugin (session-start resume, compaction recovery,
Memory Protocol skill) and starts one explicitly bound lane. The
`HYTHE_AGENT_ID` configured on `claude mcp add` belongs to the stdio bridge;
Claude plugin hooks are separate children and inherit identity from the Claude
process. Launch Claude with the same exact value or the hooks fail closed. For
other agent CLIs, see the per-agent files below and `setup.sh` for
instruction-file wiring.

When per-agent authorization is enabled, first have the server operator issue
a credential for that exact id into a dedicated local file by following the
[offline operator guide](../../docs/AGENT-CREDENTIAL-OPERATOR.md), then
generate the client block with:

```bash
npx -y @hythe/mcp@0.1.6 init --agent-id claude-desktop \
  --agent-key-file /absolute/path/to/claude-desktop.agent-key \
  --agent-auth-mode required
```

The agent-key file contains one raw `hya1_…` token, must be a regular
non-symlink owned by the client user, and must have mode 0400 or 0600. The
bridge sends it only as `X-Hythe-Agent-Key`, attests `/agent/whoami` before
reading MCP stdin, and requires the server-derived id to equal
`HYTHE_AGENT_ID`. A mismatch or failed attestation exits before forwarding a
request. Never put an agent token directly in environment variables, command
arguments, config JSON/TOML, or URLs.

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
  set (`HYTHE_API_KEY_FILE`, `HYTHE_AGENT_ID`, `MCP_HOST`, `MCP_PORT`). In an
  authenticated lane it also carries file reference `HYTHE_AGENT_KEY_FILE`
  and rollout setting `HYTHE_AGENT_AUTH_MODE`; generate the block with the
  command above. Hook processes need the exact agent id, but never the agent
  credential.
- **Name-agnostic where possible.** Directory and script names avoid the
  product name; new installs use the `hythe` MCP server key and
  `mcp__hythe__*` tool names (printed by `npx -y @hythe/mcp@0.1.6 init --agent-id <agent-id>`).
- **Agent identity** comes from `HYTHE_AGENT_ID` (e.g. `claude-desktop`);
  the legacy `ENGRAM_AGENT_ID` alias is honored only when it agrees. Hooks
  reject conflicting aliases and refuse to guess a missing identity. For
  Claude Code, both the bridge config and the ambient environment of the
  launched `claude` process must carry that same value.
- **Agent proof is distinct per lane.** The deployment/tenant API key proves
  access to the HYTHE instance; the protected agent-key file proves one exact
  principal. Reusing one agent-key file across identities fails attestation
  and defeats clean rotation boundaries.
- **Codex instructions never infer identity.** MCP config env binds the bridge
  but is not automatically model-visible. A trusted Codex session hook or
  launcher must inject the same exact value into session context; otherwise
  startup and post-compaction recovery remain fail closed.
