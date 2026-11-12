# Sender identity and agent fencing: options and migration plan

Status: PLAN ONLY. No auth-mode change, no credential, no deploy. Every
production step below is Tomas's decision.
Source: task 1147d702 item 3; field reports 8aeaee56 M1 (Manus, 2026-10-14)
and 9ceed35e P3 (2026-09-20); hythe-bot-gateway review F3 (fa14d849).
Author: claude-hythe, 2026-11-12. Code references are to hythe-dev/hythe main
449794a.

## 1. The problem, precisely

engram-v1 runs `HYTHE_AGENT_AUTH_MODE=observe`
(`docker/pavilion-production.compose.yml`). In observe mode:

- A caller with the base key and **no** agent key may claim any `agentId` /
  `from` (`policy.ts` legacy path: `legacy_observed`). So any lane can send a
  message "from muse" or write an observation as "codex-hythe" (M1).
- A caller that **does** present an agent key is pinned to its principal,
  even in observe mode (`claimed_identity_mismatch`), and its scopes are
  enforced (`binder.ts assertAgentCredentialScope`). Keys work today; the
  trouble is that nothing makes them *necessary*.
- There is no way to silence a stood-down lane (P3: codex-desktop-ws01 kept
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
  short engram-v1 stop. An online, authenticated operator endpoint is
  possible but is a larger security change and should be its own review.

Cost: small (one operator subcommand pair plus tests). Risk: low. It is
deny-only and reversible by `enable`.

### B. observe -> mixed, with bots and willing lanes promoted (needed for gateway phase 2)

`mixed` changes behavior for exactly two kinds of caller:
(a) keyless claims of **enforced** principals, and (b) keyless calls to
agent-bound tools with **no** claim. Everyone else behaves as in observe.
Since no principal is enforced until someone promotes it, (a) starts empty.
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
  (`docs/PAVILION-PRODUCTION.md` says the same).

## 4. Migration path for engram-v1 (each step: Tomas)

0. **Inventory (offline, read-only).** `hythe-agent-auth status` for the known
   lanes: which principals exist, their states and credentials. Not recorded
   anywhere in hythe today.
1. **Telemetry gap first (code, observe-only).** The auth metrics carry only
   `{mode, proof}` (`metrics.ts recordAgentAuthInvocation`), with no tool or
   claim presence, so they cannot show who would hit `AGENT_ID_REQUIRED`
   under mixed. Add a counter (or an audit row) for "legacy call to an
   agent-bound tool with no claim", labeled by tool, in observe only. Run it
   for about a week. Deploying it is a normal image change, which is Tomas's
   call.
2. **Fix the callers step 1 finds** (pass `agentId`/`from` explicitly). This is
   client-side; no server change.
3. **Fence as needed (option A).** Disable stood-down ids. Independent of the
   mode.
4. **Cut to mixed.** One manifest edit (`HYTHE_AGENT_AUTH_MODE: mixed`), then a
   container restart. **Rollback:** the same edit back to `observe` and a
   restart. That edit is the fencing flag for the mode itself. No data
   changes, so rollback is clean.
5. **Promote lane by lane.** For each lane with a key: run the `/agent/whoami`
   canary (only recorded in mixed or required mode), stop, `promote`, start,
   then confirm a keyless claim of that id is refused. Bots first (step 5),
   then any human-driven lane that wants protection.
6. **Required** only after step 0 shows every active lane has a key and step 1
   telemetry is quiet for a full cycle.

What breaks for existing lanes, by step:
- Steps 0 to 3: nothing, except the fenced ids.
- Step 4: keyless calls to agent-bound tools that omit agentId/from (found by
  step 1). Keyless claims of enforced principals, of which there are none yet.
- Step 5: only keyless use of a promoted id. That is the point.
- Step 6: every lane without a key.

## 5. Minimum for hythe-bot-gateway phase 2 (writes)

Under observe mode, a message or note "from muse" is forgeable by any base-key
holder, whatever the gateway does. The minimum before any bot write is
turned on:

1. engram-v1 in **mixed** mode (step 4);
2. each writing bot's principal issued, canaried and **enforced** (step 5),
   with scopes limited to what the bot's phase-2 tools need: `message:send`
   for send_message and `memory:write` for add_note, on top of phase 1's
   `memory:read` and `message:read`;
3. a negative test on the live canary: a keyless call claiming `from: "muse"`
   is refused with `AGENT_CREDENTIAL_REQUIRED`;
4. option A available, so a misbehaving bot can be fenced without
   redeploying the gateway (the gateway's own kill switch covers the gateway
   path; `disable` covers every path).

Phase 1 (read-only) does not need any of this. The gateway's agent key already
pins the bot's inbox in observe mode (F3).

## 6. Proposed work items (not started)

- `operator: disable/enable` with an audit `--reason`, plus contract tests for
  observe, mixed and required, HTTP and WebSocket. (Option A)
- `metrics: agent-bound legacy call without a claim`, labeled by tool,
  observe only. (Step 1)
- A test that pins the mode table in section 2, so the plan stays true as the
  code changes.
