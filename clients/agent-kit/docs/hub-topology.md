# Hub topology — the official two-machine setup

**Question this answers:** "I work on a desktop and a laptop. How do I get my
memory on both?"

**Answer:** you don't sync the database — you run ONE authoritative server and
point every machine's agents at it. There is deliberately no multi-master
sync: two writers on one memory store means merge conflicts over supersedes
chains and message state, and silent data loss. One hub, many clients.

```
   desktop (always on, or a small home server)
   └── memory server  ← single authoritative store + backups
        ▲          ▲
   agents on    agents on
    desktop      laptop        ... any machine on your tailnet
```

## Setup

1. **Pick the hub** — the machine that is on when you work: a desktop, a home
   server, a mini PC. The server runs there (container recommended; pinned
   image). Bind to localhost; expose only through the protected gateway.
2. **Private network** — install Tailscale (or equivalent) on hub + laptops.
   The gateway listens on the tailnet address; nothing is exposed to the
   public internet. No port forwarding, no TLS certificates to manage.
3. **Point clients at the hub** — every machine's agent config uses the same
   stdio bridge with `MCP_HOST` set to the hub's tailnet address (plus
   `MCP_PORT` and the shared `API_KEY` from `npx -y @hythe/mcp init`), and
   that machine's own `HYTHE_AGENT_ID` (e.g. `claude-desktop`,
   `claude-laptop`). Distinct ids per machine: the inbox and attribution
   model assume one identity per client lane.
4. **Backups live with the hub** — scheduled snapshot + off-host copy.
   Laptops carry no memory state at all; a lost laptop loses nothing.

## Why not sync the SQLite file?

- Two concurrent writers corrupt logical state even when the file survives:
  supersedes chains, message read-state, and vector indexes do not merge.
- File-sync tools (Syncthing/Dropbox) provide no transaction boundary — a
  sync during a write ships a torn database.
- "One machine at a time" discipline works for one careful person and fails
  the first time it's forgotten. The hub makes the discipline structural.

## Laptop offline?

Agents on the laptop lose memory access while off-network — by design, the
same as losing any server. If offline work matters, the hub belongs on an
always-on box (or a managed instance becomes the hub). Queueing writes
locally for later replay is multi-master sync by another name; rejected.
