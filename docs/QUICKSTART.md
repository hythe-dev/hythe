# Quickstart — two coordinating agents in ~15 minutes

This walks a clean machine from zero to two AI agents sharing state through
HYTHE. Prerequisites: Docker (with compose) and Node.js ≥ 20.9.

## 1. Generate config (1 min)

From the directory where you'll run the server:

```bash
npx -y @hythe/mcp init --write-env --agent-id agent-a
```

This generates a fresh API key and writes it only to `./.env` (mode 600,
never overwriting an existing file). The printed MCP config blocks for Claude
Code, Codex, Cursor, and Claude Desktop reference that protected file and bind
this client lane to `HYTHE_AGENT_ID=agent-a`; the key itself is never printed
or embedded in client config.

## 2. Start the server (2 min)

```bash
docker compose -f docker/docker-compose.yml up -d
curl -s http://127.0.0.1:6174/health
```

The server binds to loopback by default and refuses to boot with the
placeholder key — an untouched `.env.example` cannot go live. The database
starts **empty** (SQLite file on the `engram_data` volume). On a new volume,
the image downloads the q8 embedding model into `/app/data/models` and proves
it can produce a finite 384-dimension vector before serving; later starts use
that cache. Set `SQLITE_VEC_ALLOW_REMOTE_MODELS=false` only after the complete
model is cached. If the first health request is early, follow progress with
`docker compose -f docker/docker-compose.yml logs -f engram`.

## 3. Connect your first client (3 min)

Paste the block `init` printed for your client. For Claude Code, install the
hook plugin, add the bridge, then launch the identity-bound lane:

```bash
claude plugin marketplace add hythe-dev/hythe
claude plugin install hythe
claude mcp add hythe --env HYTHE_API_KEY_FILE="$PWD/.env" --env HYTHE_AGENT_ID=agent-a --env MCP_HOST=127.0.0.1 --env MCP_PORT=6174 -- npx -y @hythe/mcp
HYTHE_AGENT_ID=agent-a claude
```

Each MCP client spawns the stdio bridge; the bridge talks HTTP to the
server. Claude's plugin hooks are separate child processes: the `--env`
flags on `claude mcp add` configure the bridge only, while the launch-time
`HYTHE_AGENT_ID` is inherited by session-start and post-compaction hooks.
Both values must be the same exact lane identity; missing or conflicting hook
identity fails closed. Same pattern for Codex (`~/.codex/config.toml`), Cursor
(`.cursor/mcp.json`), and Claude Desktop.

## 4. Seed the demo (optional, 2 min)

```bash
HYTHE_API_KEY_FILE="$PWD/.env" npx -y @hythe/mcp demo
```

This seeds a namespaced (`demo-*`) two-agent story: `demo-alice` writes a
`checkpoint` (structured state, CAS revision 1), messages `demo-bob` on
the bus, and `demo-bob` `resume`s the scope and reads alice's state. The
command prints exactly what happened and how to explore it from your own
client. Wipe everything with `docker compose -f docker/docker-compose.yml
down -v`.

## 5. Two real agents (5 min)

Generate a second block from the same directory without rewriting the shared
credential, then paste it into the second harness (say Codex next to Claude
Code):

```bash
npx -y @hythe/mcp init --agent-id agent-b
```

Each client lane needs a stable, distinct identity. The bridge rejects a
`send_ai_message.from` that differs from its configured `HYTHE_AGENT_ID`
instead of forwarding it. Then, from harness A:

```
register_agent({agentId: "agent-a", name: "A", capabilities: ["builder"]})
checkpoint({agentId: "agent-a", scope: {project: "hello-fleet"},
            expectedRevision: null, idempotencyKey: "hello-1",
            state: {objective: "prove shared state", status: "green",
                    owner: "agent-a", nextActions: ["agent-b resumes"],
                    blockers: [], guardrails: []}})
send_ai_message({from: "agent-a", to: "agent-b",
                 content: "[ACP] urgency=normal expected_reply=5m next_check=3m\nCheckpoint written for hello-fleet — resume and take over."})
```

From harness B:

```
get_ai_messages({agentId: "agent-b"})
resume({agentId: "agent-b", scope: {project: "hello-fleet"}, budget: 4000})
```

Agent B now holds agent A's structured state — objective, status, next
actions — plus the message that pointed at it. That's the loop: checkpoint
→ message → resume. The coordination discipline built on top of it (ETAs,
cadence, stand-down) is [SPEC.md](./SPEC.md); the concepts behind the
store are in [CONCEPTS.md](./CONCEPTS.md).

## Troubleshooting

- **Bridge connects but calls fail** — confirm `HYTHE_API_KEY_FILE` points to
  the same mode-400 or mode-600 `.env` used by the server. The server also logs
  auth failures.
- **`.env` refuses to boot** — the placeholder `API_KEY=CHANGE_ME` is
  deliberately rejected; run `npx -y @hythe/mcp init --write-env --agent-id agent-a`
  for a real key and identity-bound client config.
- **Bridge exits with an identity error** — set `HYTHE_AGENT_ID` to one stable
  1-100 character id for that client lane. If the legacy `ENGRAM_AGENT_ID`,
  `FROM`, or `MCP_FROM` aliases are also set, they must resolve to the same id.
- **Claude hooks emit no recovery context** — the identity in `claude mcp add
  --env HYTHE_AGENT_ID=...` reaches the bridge, not plugin hook processes.
  Restart that Claude lane as `HYTHE_AGENT_ID=<same-id> claude`.
- **Port collision** — change `NEURAL_MCP_PORT` in `.env` and `MCP_PORT`
  in each client block together.
