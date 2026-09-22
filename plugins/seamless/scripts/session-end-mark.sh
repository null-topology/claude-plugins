#!/bin/sh
# SessionEnd hook for the seamless plugin. POSIX sh: runs under dash, ash, bash and zsh.
#
# When a session ends because of /clear, leave a bridge for the session that replaces it. The
# SessionEnd hook knows only the old session id and the SessionStart hook only the new one; what
# both see is the process they run in, because /clear keeps the process and swaps the session.
# The bridge is an empty file whose name carries everything:
#
#   <plugin data>/bridge/<key>=<old session id>
#
# where <key> identifies the process: the CRC of CLAUDE_CODE_MESSAGING_TOKEN (a per-process
# random token; only its checksum is ever written), or the process id when the token is missing.
# Several sessions running in parallel in the same directory have different keys, so the new
# session finds exactly the transcript that was cleared in its own process, never a neighbour's.
# The SessionStart hook turns the bridge into a permanent chain entry and deletes it.
#
# Usage: session-end-mark.sh <plugin data dir>

set -u

input=$(cat)

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1

json_str() {
  if [ "$have_jq" -eq 1 ]; then
    jq -r --arg k "$1" '.[$k] // "" | tostring'
  else
    tr -d '\n' | sed -n "s/.*\"$1\":[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1
  fi
}

bridge_key() {
  # The identity of the Claude Code process both hooks of a /clear run in. Same function in the
  # SessionStart hook; the two must agree.
  if [ -n "${CLAUDE_CODE_MESSAGING_TOKEN:-}" ]; then
    printf 'tok-%s' "$(printf '%s' "$CLAUDE_CODE_MESSAGING_TOKEN" | cksum | cut -d' ' -f1)"
  elif [ -n "${CLAUDE_PID:-}" ]; then
    printf 'pid-%s' "$CLAUDE_PID"
  else
    printf 'pid-%s' "$PPID"
  fi
}

reason=$(printf '%s' "$input" | json_str reason)
[ "$reason" = "clear" ] || exit 0

session_id=$(printf '%s' "$input" | json_str session_id)
if [ -z "$session_id" ]; then
  transcript=$(printf '%s' "$input" | json_str transcript_path)
  [ -n "$transcript" ] && session_id=$(basename "$transcript" .jsonl)
fi
case "$session_id" in
  ""|*/*|*=*|.*) exit 0 ;;
esac

data_dir="${1:-}"
case "$data_dir" in
  ""|*'${CLAUDE_PLUGIN_DATA}'*) data_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/data/seamless" ;;
esac

key=$(bridge_key)

# SEAMLESS_DEBUG=1 appends one line per hook run to <plugin data>/debug.log, for troubleshooting.
case "${SEAMLESS_DEBUG:-}" in
  1|true|yes) mkdir -p "$data_dir" 2>/dev/null && printf '%s SessionEnd reason=%s session_id=%s bridge=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$reason" "$session_id" "$key" >> "$data_dir/debug.log" 2>/dev/null ;;
esac

mkdir -p "$data_dir/bridge" 2>/dev/null || exit 0
: > "$data_dir/bridge/$key=$session_id" 2>/dev/null

exit 0
