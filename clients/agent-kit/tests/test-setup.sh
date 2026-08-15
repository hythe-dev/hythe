#!/bin/bash
# Dual-marker installer test suite. Run: bash tests/test-setup.sh
# Uses fixtures only; touches nothing outside its temp dir.
set -uo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

# Fixture blocks: an OLD-generation block and a NEW-generation (post-P3) block.
cat > "$TMP/old-block.md" <<'EOF'
<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->
old engram protocol body
<!-- END ENGRAM MEMORY PROTOCOL -->
EOF
cat > "$TMP/new-block.md" <<'EOF'
<!-- BEGIN HYTHE MEMORY PROTOCOL — managed by setup.sh -->
new hythe protocol body
<!-- END HYTHE MEMORY PROTOCOL -->
EOF

check() { # name, condition
  if eval "$2"; then PASS=$((PASS+1)); echo "PASS: $1";
  else FAIL=$((FAIL+1)); echo "FAIL: $1"; fi
}
count_blocks() { grep -c "BEGIN .* MEMORY PROTOCOL" "$1"; }

# T1: fresh file -> append; second run idempotent
f="$TMP/t1.md"; printf '# mine\nuser line\n' > "$f"
bash "$KIT/setup.sh" "$f" "$TMP/old-block.md" >/dev/null
bash "$KIT/setup.sh" "$f" "$TMP/old-block.md" >/dev/null
check "T1 fresh append + idempotent single block" '[ "$(count_blocks "$f")" -eq 1 ] && grep -q "user line" "$f"'
cp "$f" "$TMP/t1.snap"; bash "$KIT/setup.sh" "$f" "$TMP/old-block.md" >/dev/null
check "T1b third run byte-identical" 'cmp -s "$f" "$TMP/t1.snap"'

# T2: OLD block present, install NEW block -> replaced IN PLACE, user content intact
f="$TMP/t2.md"
printf 'above\n' > "$f"; cat "$TMP/old-block.md" >> "$f"; printf 'below\n' >> "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T2 old->new replaced" 'grep -q "HYTHE MEMORY PROTOCOL" "$f" && ! grep -q "ENGRAM MEMORY PROTOCOL" "$f"'
check "T2b single block, content intact, position preserved" \
  '[ "$(count_blocks "$f")" -eq 1 ] && [ "$(head -1 "$f")" = "above" ] && grep -q "below" "$f" && [ "$(grep -n "BEGIN" "$f" | cut -d: -f1)" -lt "$(grep -n "^below" "$f" | cut -d: -f1)" ]'

# T3: NEW block present, reinstall NEW -> idempotent
f="$TMP/t3.md"; printf 'x\n' > "$f"; cat "$TMP/new-block.md" >> "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T3 new->new idempotent" '[ "$(count_blocks "$f")" -eq 1 ] && grep -q "new hythe protocol body" "$f"'

# T4: pathological BOTH blocks present -> collapses to one (current), order preserved
f="$TMP/t4.md"
printf 'top\n' > "$f"; cat "$TMP/old-block.md" >> "$f"; printf 'mid\n' >> "$f"; cat "$TMP/new-block.md" >> "$f"; printf 'end\n' >> "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T4 both blocks collapse to one" \
  '[ "$(count_blocks "$f")" -eq 1 ] && grep -q "top" "$f" && grep -q "mid" "$f" && grep -q "end" "$f" && ! grep -q "old engram protocol body" "$f"'

# T5: NEW block present, roll BACK to old (P3 rollback path) -> replaced
f="$TMP/t5.md"; cat "$TMP/new-block.md" > "$f"
bash "$KIT/setup.sh" "$f" "$TMP/old-block.md" >/dev/null
check "T5 rollback new->old works" 'grep -q "old engram protocol body" "$f" && ! grep -q "HYTHE" "$f"'

# T6: real shipped block installs over an old-marker file
f="$TMP/t6.md"; cat "$TMP/old-block.md" > "$f"
bash "$KIT/setup.sh" "$f" >/dev/null
check "T6 shipped block replaces old block" '[ "$(count_blocks "$f")" -eq 1 ] && grep -q "Persistent Memory Protocol" "$f"'

# --- adversarial / fail-closed cases (review a40b2e81) ---

# T7: BEGIN without END -> abort, target byte-untouched, nonzero exit
f="$TMP/t7.md"
printf 'above\n<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->\norphan\nuser tail line\n' > "$f"
cp "$f" "$TMP/t7.snap"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null 2>&1
rc=$?
check "T7 missing END aborts nonzero" '[ "$rc" -ne 0 ]'
check "T7b target byte-untouched, user tail preserved" 'cmp -s "$f" "$TMP/t7.snap"'

# T8: mode 0600 preserved across replacement
f="$TMP/t8.md"; cat "$TMP/old-block.md" > "$f"; chmod 600 "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T8 mode 0600 preserved" '[ "$(stat -c %a "$f")" = "600" ] && grep -q "HYTHE" "$f"'

# T9: invalid block file (no markers) -> abort, target untouched
f="$TMP/t9.md"; printf 'user\n' > "$f"; cp "$f" "$TMP/t9.snap"
printf 'no markers here\n' > "$TMP/bad-block.md"
bash "$KIT/setup.sh" "$f" "$TMP/bad-block.md" >/dev/null 2>&1
rc=$?
check "T9 unmarked block file rejected" '[ "$rc" -ne 0 ] && cmp -s "$f" "$TMP/t9.snap"'

# T9b: cross-generation block file (ENGRAM begin + HYTHE end) -> rejected
printf '<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->\nx\n<!-- END HYTHE MEMORY PROTOCOL -->\n' > "$TMP/cross-block.md"
bash "$KIT/setup.sh" "$f" "$TMP/cross-block.md" >/dev/null 2>&1
rc=$?
check "T9b cross-generation block file rejected" '[ "$rc" -ne 0 ] && cmp -s "$f" "$TMP/t9.snap"'

# T10: symlinked target -> referent updated, symlink stays a symlink
real="$TMP/t10-real.md"; ln="$TMP/t10-link.md"
cat "$TMP/old-block.md" > "$real"; ln -s "$real" "$ln"
bash "$KIT/setup.sh" "$ln" "$TMP/new-block.md" >/dev/null
check "T10 symlink preserved, referent updated" '[ -L "$ln" ] && grep -q "HYTHE" "$real" && [ "$(count_blocks "$real")" -eq 1 ]'

# T10b: dangling symlink -> abort (readlink -f fails only when parent missing; a
# dangling link to a missing file in an existing dir resolves — setup would
# create the referent. Test the truly unresolvable case: loop symlink.)
ln -s "$TMP/t10-loop.md" "$TMP/t10-loop.md"
bash "$KIT/setup.sh" "$TMP/t10-loop.md" "$TMP/new-block.md" >/dev/null 2>&1
rc=$?
check "T10b unresolvable symlink aborts" '[ "$rc" -ne 0 ]'

# T11: cross-generation pairing inside TARGET -> abort untouched
f="$TMP/t11.md"
printf '<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->\nx\n<!-- END HYTHE MEMORY PROTOCOL -->\nuser\n' > "$f"
cp "$f" "$TMP/t11.snap"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null 2>&1
rc=$?
check "T11 cross-generation target aborts untouched" '[ "$rc" -ne 0 ] && cmp -s "$f" "$TMP/t11.snap"'

# T12: no stray tempfiles left behind after an abort
lsjunk=$(ls "$TMP"/.setup-sh.* 2>/dev/null | wc -l)
check "T12 no stray tempfiles after aborts" '[ "$lsjunk" -eq 0 ]'

# T13: malformed target abort preserves MTIME (not just bytes)
f="$TMP/t13.md"
printf '<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->\norphan no end\n' > "$f"
touch -d "2020-01-01 00:00:00" "$f"
mt_before=$(stat -c %Y "$f")
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null 2>&1
rc=$?
mt_after=$(stat -c %Y "$f")
check "T13 abort preserves mtime" '[ "$rc" -ne 0 ] && [ "$mt_before" = "$mt_after" ]'

# T14: prose QUOTING a marker mid-line is plain text, not a marker
f="$TMP/t14.md"
printf 'docs: the marker is `<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->` verbatim\nuser line\n' > "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
rc=$?
check "T14 mid-line marker quote treated as prose (append succeeds)" \
  '[ "$rc" -eq 0 ] && [ "$(count_blocks "$f")" -eq 2 ] && grep -q "user line" "$f" && grep -q "docs: the marker" "$f"'
# note: count_blocks greps the quoted prose too, so expect 2 matches but only
# one REAL managed block — verify by exact-line count:
real_blocks=$(grep -cx '<!-- BEGIN HYTHE MEMORY PROTOCOL — managed by setup.sh -->' "$f")
check "T14b exactly one real block" '[ "$real_blocks" -eq 1 ]'

# T15: CRLF target with CRLF markers is recognized and replaced
f="$TMP/t15.md"
printf 'above\r\n<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->\r\nold body\r\n<!-- END ENGRAM MEMORY PROTOCOL -->\r\nbelow\r\n' > "$f"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T15 CRLF markers recognized, replaced" \
  'grep -q "new hythe protocol body" "$f" && ! grep -q "old body" "$f" && grep -q "below" "$f"'

# T16: nonexistent target created with block (no prior touch semantics)
f="$TMP/subdir/t16.md"
bash "$KIT/setup.sh" "$f" "$TMP/new-block.md" >/dev/null
check "T16 absent target created with single block" '[ -f "$f" ] && [ "$(count_blocks "$f")" -eq 1 ]'

# T17-T19: Claude hook identity resolution must fail closed on alias conflicts.
hook_input='{"cwd":"/tmp/hythe-client"}'
hook_err="$TMP/t17.err"
hook_out=$(env HYTHE_AGENT_ID=claude-a ENGRAM_AGENT_ID=claude-b \
  bash "$KIT/claude-code/plugin/scripts/session-start.sh" <<<"$hook_input" 2>"$hook_err")
rc=$?
check "T17 session-start rejects conflicting identity aliases" \
  '[ "$rc" -eq 2 ] && [ -z "$hook_out" ] && grep -qi "HYTHE_AGENT_ID.*ENGRAM_AGENT_ID.*conflict" "$hook_err"'

hook_err="$TMP/t18.err"
hook_out=$(env HYTHE_AGENT_ID=claude-a ENGRAM_AGENT_ID=claude-b \
  bash "$KIT/claude-code/plugin/scripts/post-compaction.sh" <<<"$hook_input" 2>"$hook_err")
rc=$?
check "T18 post-compaction rejects conflicting identity aliases" \
  '[ "$rc" -eq 2 ] && [ -z "$hook_out" ] && grep -qi "HYTHE_AGENT_ID.*ENGRAM_AGENT_ID.*conflict" "$hook_err"'

hook_err="$TMP/t19.err"
hook_out=$(env HYTHE_AGENT_ID=claude-stable ENGRAM_AGENT_ID=claude-stable \
  bash "$KIT/claude-code/plugin/scripts/session-start.sh" <<<"$hook_input" 2>"$hook_err")
rc=$?
check "T19 matching identity aliases remain compatible" \
  '[ "$rc" -eq 0 ] && [ ! -s "$hook_err" ] && grep -q '\''agentId: "claude-stable"'\'' <<<"$hook_out"'

for hook in session-start.sh post-compaction.sh; do
  hook_err="$TMP/t20-${hook}.err"
  hook_out=$(env HYTHE_AGENT_ID='invalid identity' \
    bash "$KIT/claude-code/plugin/scripts/$hook" <<<"$hook_input" 2>"$hook_err")
  rc=$?
  check "T20 $hook rejects invalid explicit identity without leaking it" \
    '[ "$rc" -eq 2 ] && [ -z "$hook_out" ] && grep -qi "identity.*invalid" "$hook_err" && ! grep -q "invalid identity" "$hook_err"'
done

for hook in session-start.sh post-compaction.sh; do
  hook_err="$TMP/t21-${hook}.err"
  hook_out=$(env -u HYTHE_AGENT_ID -u ENGRAM_AGENT_ID FROM=transport-only \
    bash "$KIT/claude-code/plugin/scripts/$hook" <<<"$hook_input" 2>"$hook_err")
  rc=$?
  check "T21 $hook rejects a missing logical identity instead of asking the model to choose one" \
    '[ "$rc" -eq 2 ] && [ -z "$hook_out" ] && grep -qi "no explicit agent identity.*Restart.*HYTHE_AGENT_ID" "$hook_err" && ! grep -qi "ask the user" "$hook_err" && ! grep -q "transport-only" "$hook_err"'
done

# T22: the documented Claude flow binds the hook process as well as the MCP
# bridge. `claude mcp add --env` alone does not populate hook child env.
check "T22 Claude install docs require an ambient launch identity for hooks" \
  'grep -q "HYTHE_AGENT_ID=claude-desktop claude" "$KIT/README.md" && grep -q "hooks are separate children" "$KIT/README.md"'

check "T23 Codex instructions fail closed when identity is not model-visible" \
  'grep -qi "MCP child-process env is not model-visible" "$KIT/codex/compact-prompt.md" && grep -qi "Never infer an identity" "$KIT/codex/instructions.md" && grep -qi "do not call any HYTHE identity-scoped tool" "$KIT/codex/compact-prompt.md"'

echo "----"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
