#!/bin/bash
# Marker-block installer with DUAL-MARKER transition support for the server's
# phased rename. Writes the Memory Protocol into an agent's shared
# instruction file as a managed block.
#
# Recognized marker generations (index-paired):
#   old:  <!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh --> ... <!-- END ENGRAM MEMORY PROTOCOL -->
#   new:  <!-- BEGIN HYTHE MEMORY PROTOCOL — managed by setup.sh -->  ... <!-- END HYTHE MEMORY PROTOCOL -->
#
# MARKER MATCHING POLICY: a marker counts ONLY as an exact full line. A single
# trailing carriage return is stripped before comparison, so CRLF targets are
# supported. Prose that merely quotes a marker mid-line is plain text.
#
# FAIL-CLOSED GUARANTEES (reviews a40b2e81, 2ff93cf9):
#   - an EXISTING target is never created/touched before validation; on any
#     abort it keeps bytes, mode, AND mtime
#   - block file must begin/end with one exact recognized same-generation
#     marker pair, else abort
#   - malformed target markers (BEGIN w/o END, nested, cross-generation)
#     → abort with diagnostic
#   - symlinked target resolves to and updates the referent; symlink survives;
#     unresolvable link aborts
#   - mode preservation on existing targets is VERIFIED (stat compare) and a
#     chmod failure aborts; ownership is best-effort only (documented)
#   - collision-safe same-directory mktemp with cleanup trap
#
# Usage: ./setup.sh <target-file> [block-file]
# Marker-block pattern adapted from Gentleman-Programming/engram (MIT).

set -euo pipefail

TARGET="${1:?usage: setup.sh <target-instruction-file> [block-file]}"
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
BLOCK_FILE="${2:-${KIT_DIR}/gemini/system-block.md}"

BEGINS=(
  '<!-- BEGIN ENGRAM MEMORY PROTOCOL — managed by setup.sh -->'
  '<!-- BEGIN HYTHE MEMORY PROTOCOL — managed by setup.sh -->'
)
ENDS=(
  '<!-- END ENGRAM MEMORY PROTOCOL -->'
  '<!-- END HYTHE MEMORY PROTOCOL -->'
)

die() { echo "setup.sh: $*" >&2; exit 1; }

[ -f "$BLOCK_FILE" ] || die "block file not found: $BLOCK_FILE"

# --- validate block file: first/last lines must be one same-generation pair
# (exact line match, tolerating one trailing CR)
blk_first=$(head -n 1 "$BLOCK_FILE" | sed 's/\r$//')
blk_last=$(tail -n 1 "$BLOCK_FILE" | sed 's/\r$//')
blk_gen=""
for i in "${!BEGINS[@]}"; do
  if [ "$blk_first" = "${BEGINS[$i]}" ] && [ "$blk_last" = "${ENDS[$i]}" ]; then blk_gen="$i"; break; fi
done
[ -n "$blk_gen" ] || die "invalid block file (first/last lines are not one recognized same-generation marker pair): $BLOCK_FILE"

# --- resolve symlinked target to its referent; the symlink itself stays put
if [ -L "$TARGET" ]; then
  RESOLVED=$(readlink -f -- "$TARGET") || die "cannot resolve symlink: $TARGET"
  [ -n "$RESOLVED" ] || die "cannot resolve symlink: $TARGET"
  echo "note: $TARGET is a symlink; updating referent $RESOLVED"
  TARGET="$RESOLVED"
fi

target_exists=0
[ -e "$TARGET" ] && target_exists=1

# --- shared awk marker matcher: exact full line, single trailing CR stripped
AWK_MATCH='
  function marker_index(line, arr, n,   j, s) {
    s = line; sub(/\r$/, "", s)
    for (j = 1; j <= n; j++) if (s == arr[j]) return j
    return 0
  }'

# --- validate EXISTING target marker integrity, read-only, before any write
if [ "$target_exists" -eq 1 ]; then
  verr=$(awk -v begins="$(printf '%s\x1f' "${BEGINS[@]}")" \
             -v ends="$(printf '%s\x1f' "${ENDS[@]}")" "$AWK_MATCH"'
    BEGIN { nb = split(begins, B, "\x1f") - 1; split(ends, E, "\x1f"); inside = 0 }
    {
      bi = marker_index($0, B, nb)
      ei = marker_index($0, E, nb)
      if (bi) { if (inside) { print "nested/unclosed BEGIN at line " NR; exit 2 } inside = bi; next }
      if (ei) {
        if (!inside) { print "END without BEGIN at line " NR; exit 2 }
        if (inside != ei) { print "cross-generation pairing at line " NR; exit 2 }
        inside = 0; next
      }
    }
    END { if (inside) { print "BEGIN without matching END (user tail would be lost)"; exit 2 } }
  ' "$TARGET") || die "target has malformed managed-block markers — refusing to modify $TARGET: $verr"
fi

has_block=0
if [ "$target_exists" -eq 1 ]; then
  if awk -v begins="$(printf '%s\x1f' "${BEGINS[@]}")" "$AWK_MATCH"'
    BEGIN { nb = split(begins, B, "\x1f") - 1 }
    marker_index($0, B, nb) { found = 1; exit }
    END { exit found ? 0 : 1 }
  ' "$TARGET"; then has_block=1; fi
fi

# --- build replacement in a collision-safe same-directory tempfile
mkdir -p "$(dirname -- "$TARGET")"
TMPFILE=$(mktemp "$(dirname -- "$TARGET")/.setup-sh.XXXXXX") || die "mktemp failed"
trap 'rm -f "$TMPFILE"' EXIT

if [ "$has_block" -eq 1 ]; then
  awk -v begins="$(printf '%s\x1f' "${BEGINS[@]}")" \
      -v ends="$(printf '%s\x1f' "${ENDS[@]}")" \
      -v blockfile="$BLOCK_FILE" "$AWK_MATCH"'
    BEGIN { nb = split(begins, B, "\x1f") - 1; split(ends, E, "\x1f"); replaced = 0 }
    {
      bi = marker_index($0, B, nb)
      if (bi) {
        if (!replaced) {
          while ((getline line < blockfile) > 0) print line
          close(blockfile)
          replaced = 1
        }
        while ((getline) > 0) { if (marker_index($0, E, nb) == bi) break }
        next
      }
      print
    }
  ' "$TARGET" > "$TMPFILE"
  action="Replaced managed block in"
elif [ "$target_exists" -eq 1 ]; then
  cat "$TARGET" > "$TMPFILE"
  printf '\n' >> "$TMPFILE"
  cat "$BLOCK_FILE" >> "$TMPFILE"
  action="Appended managed block to"
else
  cat "$BLOCK_FILE" > "$TMPFILE"
  action="Created with managed block:"
fi

# --- preserve and VERIFY mode on existing targets (ownership best-effort)
if [ "$target_exists" -eq 1 ]; then
  chmod --reference="$TARGET" "$TMPFILE" || die "mode preservation failed for $TARGET (target unchanged)"
  [ "$(stat -c %a "$TMPFILE")" = "$(stat -c %a "$TARGET")" ] || die "mode verification mismatch for $TARGET (target unchanged)"
  chown --reference="$TARGET" "$TMPFILE" 2>/dev/null || true
fi
mv -- "$TMPFILE" "$TARGET"
trap - EXIT
echo "$action $TARGET"
