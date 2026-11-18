# Sender identity and agent fencing: options and migration plan

Status: PLAN ONLY. No auth-mode change, no credential, no deploy. Every
production step below is the owner's decision.
Source: task 1147d702 item 3; field reports 8aeaee56 M1 (2026-10-14)
and 9ceed35e P3 (2026-09-20); bot gateway review F3 (fa14d849).
Written 2026-11-12. Code references are to hythe-dev/hythe main
449794a.

Revision 2 (2026-11-12) answers review d913806a: step 0 is a
mandatory inventory gate that produces the impact table (no assumed-empty
set of enforced principals); the mode rollback is treated as a security
rollback with a stop/restore order; `enable` restores the prior state.

## 1. The problem, precisely

This section describes `HYTHE_AGENT_AUTH_MODE=observe` as a mode, wherever it
is set. In observe mode:

- A caller with the base key and **no** agent key may claim any `agentId` /
  `from` (`policy.ts` legacy path: `legacy_observed`). So any lane can send a
  message "from" a bot or write an observation as another lane (M1).
- A caller that **does** present an agent key is pinned to its principal,
  even in observe mode (`claimed_identity_mismatch`), and its scopes are
  enforced (`binder.ts assertAgentCredentialScope`). Keys work today; the
  trouble is that nothing makes them *necessary*.
- There is no way to silence a stood-down lane (P3: a stood-down lane kept
  messaging every ~5 minutes for hours). `hythe-agent-auth` has `issue`,
  `status`, `promote`, `rotate` and `revoke`, and no `disable`.

The HTTP binder and the WebSocket message hub apply the same rules
(`websocket-server.ts authenticateMessageHubRequest`), so there is no side
door through port 3004.

## 2. What each mode actually enforces

| Caller | observe | mixed | required |
|---|---|---|---|
| valid agent key, claim matches or omitted | allowed, pinned, scopes checked | same | same |
| valid agent key, claim differs | denied | denied | denied |
| no key, claims a principal in state `disabled` | **denied** | denied | denied |
| no key, claims a principal in state `enforced` | allowed (audit only) | **denied** | denied |
| no key, claims a `staged` or unknown id | allowed | allowed | denied |
| no key, agent-bound tool, no claim at all | allowed (handler default) | **denied** `AGENT_ID_REQUIRED` | denied |
| no key, unbound read tool (search, entity detail) | allowed | allowed | denied |

Two consequences drive the plan:

1. **Fencing works in every mode, today**, through the `disabled` state. Only
   an operator command to set it is missing.
2. **Protecting a specific identity from impersonation needs `mixed`**, plus
   that principal promoted to `enforced`. Observe cannot protect it.

## 3. Options

### A. Fencing without a mode change (recommended first)

Add `hythe-agent-auth disable` and `enable` (audited; `--reason` required).
`disable` on an agent with no principal row creates one directly in state
`disabled`. The store already supports both: `ensurePrincipal` accepts
`disabled` and `setPrincipalState` sets `disabled_at`/`disabled_by`
(`credential-store.ts`).

Effect: every claim of that `agentId`, with or without a key, is refused in
every mode, on HTTP and on the WebSocket hub. That answers P3.

Limits, stated honestly:
- It fences the **identity**, not the actor. In observe mode the stood-down
  process can still claim a different id. It stops the "same lane keeps
  talking" case, which is what P3 reported.
- Unbound read tools (search, entity detail) stay open to the base key.
- The operator is offline-only (`BEGIN EXCLUSIVE`): each disable needs a
  short stop of the server. An online, authenticated operator endpoint is
  possible but is a larger security change and should be its own review.

`enable` must restore the exact state the principal had before `disable`
(`staged` or `enforced`), never default to `staged`: silently downgrading a
formerly enforced id would reopen impersonation of it in mixed mode. The
principal table records only `disabled_at`/`disabled_by`, so `disable` also
needs to store the prior state (a `state_before_disable` column, or the audit
record `enable` reads back). For an id created directly in `disabled`, the
prior state is "none", and `enable` refuses until an operator chooses one.

Cost: small (one operator subcommand pair, one column, tests). Risk: low. It
is deny-only and reversible by `enable`.

### B. observe -> mixed, with bots and willing lanes promoted (needed for gateway phase 2)

`mixed` changes behavior for exactly two kinds of caller:
(a) keyless claims of **enforced** principals, and (b) keyless calls to
agent-bound tools with **no** claim. Everyone else behaves as in observe.
Do not assume (a) is empty: some principals may already be enforced (an
instance may already have an enforced read-only identity, and nothing in
hythe records an instance's principal states). Its size comes only from the
step 0 inventory below.
(b) is the real compatibility risk.

### C. mixed -> required (end state, not proposed now)

Every lane needs its own key file (`HYTHE_AGENT_KEY_FILE`; the bridge
supports it). Operator automation needs operator principals with explicit
scopes. There is no shared-key-only bypass. This breaks every lane that has
not been issued a key, so it waits until the inventory in step 0 shows none
remain.

### Rejected

- **Gateway-side signatures that recipients verify:** every reader would need
  new verification logic, and other lanes could still write unsigned
  messages claiming the bot's id. Server enforcement is the only boundary
  that holds.
- **Skipping straight to `required`:** locks out unprovisioned lanes
  (the deployment notes say the same).

## 4. Migration path for a deployment in observe mode (each step: the owner)

0. **Inventory (mandatory gate, read-only). Nothing below starts until it is
   done and its impact table is accepted by the owner.**
   - *Principals:* every row of `agent_principals` and its credentials:
     agent id, `enforcement_state`, scopes, expiry, last use. `hythe-agent-auth
     status` takes one `--agent-id` at a time and cannot list unknown ids, so
     read the tables with a read-only SQLite query against the **verified
     backup copy** made for the migration, never the live database. Proposed
     work item: `status --all`.
   - *Callers:* every client of the instance, by surface: MCP bridges (each
     lane's `HYTHE_AGENT_ID` and whether it has a key file), automation (timers,
     cron, wake/relay scripts, backups), REST callers (`/ai-message` and the
     other REST routes), WebSocket hub clients on 3004, and dashboard/operator
     tooling. For each: the identity it claims, whether it presents a key, and
     the tools it calls (agent-bound or not).
   - *Output:* an impact table, one row per caller, saying what happens to it
     at steps 3, 4, 5 and 6. Every "breaks" row is fixed, or accepted by the owner,
     before that step. Not recorded anywhere in hythe today.
1. **Telemetry gap first (code, observe-only).** The auth metrics carry only
   `{mode, proof}` (`metrics.ts recordAgentAuthInvocation`), with no tool or
   claim presence, so they cannot show who would hit `AGENT_ID_REQUIRED`
   under mixed. Add a counter (or an audit row) for "legacy call to an
   agent-bound tool with no claim", labeled by tool, in observe only. Run it
   for about a week. Deploying it is a normal image change, which is the owner's
   call.
2. **Fix the callers step 1 finds** (pass `agentId`/`from` explicitly). This is
   client-side; no server change.
3. **Fence as needed (option A).** Disable stood-down ids. Independent of the
   mode.
4. **Cut to mixed.** One manifest edit (`HYTHE_AGENT_AUTH_MODE: mixed`), then a
   container restart. **Rollback** is the same edit back to `observe` and a
   restart. That edit is the fencing flag for the mode itself. It is
   data-compatible (no data changes), but it is a **security rollback**: in
   observe, any base-key holder can again claim an enforced id without its key
   (section 2). So a rollback follows this order:
   1. Before the edit, stop everything that trusts identity: turn off bot
      writes (the gateway's phase-2 tools, or its per-bot kill switch) and
      pause consumers that act on a message's `from` or an observation's
      author as authority (relay, automation, any lane's standing
      instructions that obey a named sender).
   2. Edit back to observe and restart.
   3. While in observe, treat every `from` and author as unverified.
   4. Restart those consumers only after mixed mode is back, every principal
      that was enforced still is (re-check against the step 0 inventory), and
      the negative canaries pass again: a keyless claim of each enforced id is
      refused on HTTP and on the WebSocket hub.
5. **Promote lane by lane.** For each lane with a key: run the `/agent/whoami`
   canary (only recorded in mixed or required mode), stop, `promote`, start,
   then confirm a keyless claim of that id is refused. Bots first (step 5),
   then any human-driven lane that wants protection.
6. **Required** only after step 0 shows every active lane has a key and step 1
   telemetry is quiet for a full cycle.

What breaks for existing lanes, by step:
- Steps 0 to 3: nothing, except the fenced ids.
- Step 4: keyless calls to agent-bound tools that omit agentId/from (found by
  step 1), and keyless claims of every principal step 0 shows as already
  enforced, on every surface step 0 lists. The impact table, not this list,
  is authoritative.
- Step 5: only keyless use of a promoted id. That is the point.
- Step 6: every lane without a key.

## 5. Minimum for bot gateway phase 2 (writes)

Under observe mode, a message or note "from" a bot is forgeable by any base-key
holder, whatever the gateway does. The minimum before any bot write is
turned on:

1. the instance the gateway writes to in **mixed** mode (step 4);
2. each writing bot's principal issued, canaried and **enforced** (step 5),
   with scopes limited to what the bot's phase-2 tools need: `message:send`
   for send_message and `memory:write` for add_note, on top of phase 1's
   `memory:read` and `message:read`;
3. a negative test on the live canary: a keyless call claiming a bot's id as `from`
   is refused with `AGENT_CREDENTIAL_REQUIRED`;
4. option A available, so a misbehaving bot can be fenced without
   redeploying the gateway (the gateway's own kill switch covers the gateway
   path; `disable` covers every path);
5. the step 4 rollback order agreed in advance: bot writes go off before any
   return to observe and stay off until enforcement and the negative canaries
   are restored.

Phase 1 (read-only) does not need any of this. The gateway's agent key already
pins the bot's inbox in observe mode (F3).

## 6. Proposed work items (not started)

- `operator: disable/enable` with an audit `--reason`, storing the prior state
  so `enable` restores it exactly, plus contract tests for observe, mixed and
  required, HTTP and WebSocket. (Option A)
- `operator: status --all`, read-only, listing every principal and credential
  in a tenant. (Step 0)
- `metrics: agent-bound legacy call without a claim`, labeled by tool,
  observe only. (Step 1)
- A test that pins the mode table in section 2, so the plan stays true as the
  code changes.
