#!/usr/bin/env bash

# Resolve one logical HYTHE identity. Transport sender variables are not
# identity inputs and must be bound by the launcher/bridge after this step.
hythe_resolve_agent_id() {
  local hythe_id="${HYTHE_AGENT_ID-}"
  local legacy_id="${ENGRAM_AGENT_ID-}"
  local candidate=""

  HYTHE_RESOLVED_AGENT_ID=""
  HYTHE_IDENTITY_STATUS="missing"

  if [[ -n "$hythe_id" && -n "$legacy_id" && "$hythe_id" != "$legacy_id" ]]; then
    HYTHE_IDENTITY_STATUS="conflict"
    return 2
  fi

  candidate="${hythe_id:-$legacy_id}"
  [[ -n "$candidate" ]] || return 2

  if (( ${#candidate} > 100 )) || [[ ! "$candidate" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
    HYTHE_IDENTITY_STATUS="invalid"
    return 2
  fi

  HYTHE_RESOLVED_AGENT_ID="$candidate"
  HYTHE_IDENTITY_STATUS="bound"
}

hythe_identity_error() {
  case "${HYTHE_IDENTITY_STATUS:-missing}" in
    conflict) printf '%s\n' 'HYTHE identity error: HYTHE_AGENT_ID and ENGRAM_AGENT_ID conflict; refusing to choose an identity.' ;;
    invalid) printf '%s\n' 'HYTHE identity error: the explicit agent identity is invalid; refusing to use it.' ;;
    missing) printf '%s\n' 'HYTHE identity error: no explicit agent identity is bound. Restart this client lane with HYTHE_AGENT_ID; refusing memory, inbox, and checkpoint operations.' ;;
  esac
}
