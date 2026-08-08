# Quickstart — two coordinating agents in ~15 minutes

This walks a clean machine from zero to two AI agents sharing state through
HYTHE. Prerequisites: Docker (with compose) and Node.js ≥ 18.

## 1. Generate config (1 min)

From the directory where you'll run the server:

```bash
npx -y @hythe/mcp init --write-env
```

This generates a fresh API key and writes it only to `./.env` (mode 600,
never overwriting an existing file). The printed MCP config blocks for Claude
Code, Codex, Cursor, and Claude Desktop reference that protected file; the key
itself is never printed or embedded in client config.

## 2. Start the server (2 min)

```bash
docker compose -f docker/docker-compose.yml up -d
curl -s http://127.0.0.1:6174/health
```

The server binds to loopback by default and refuses to boot with the
placeholder key — an untouched `.env.example` cannot go live. The database
starts **empty** (SQLite file on the `engram_data` volume).

## 3. Connect your first client (3 min)

Paste the block `init` printed for your client. For Claude Code it's one
command:

```bash
claude mcp add hythe --env HYTHE_API_KEY_FILE="$PWD/.env" --env MCP_HOST=127.0.0.1 --env MCP_PORT=6174 -- npx -y @hythe/mcp
```

Each MCP client spawns the stdio bridge; the bridge talks HTTP to the
server. Same pattern for Codex (`~/.codex/config.toml`), Cursor
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

Connect a second harness (say Codex next to Claude Code) with the same
config block and a different agent identity. Then, from harness A:

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
  deliberately rejected; run `npx -y @hythe/mcp init --write-env` for a real key.
- **Port collision** — change `NEURAL_MCP_PORT` in `.env` and `MCP_PORT`
  in each client block together.
