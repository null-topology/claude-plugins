#!/usr/bin/env bash
# SessionEnd hook for the seamless plugin.
#
# When a session ends because of /clear, remember which transcript was cleared, so that the
# SessionStart hook of the session that replaces it can read exactly that transcript instead of
# guessing "the newest one". One small JSON marker per project, in the plugin's data directory.
#
# Usage: session-end-mark.sh <plugin data dir>

set -u

input=$(cat)

command -v jq >/dev/null 2>&1 || exit 0

reason=$(printf '%s' "$input" | jq -r '.reason // ""')
[ "$reason" = "clear" ] || exit 0

transcript=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
[ -n "$transcript" ] || exit 0

data_dir="${1:-}"
case "$data_dir" in
  ""|*'${CLAUDE_PLUGIN_DATA}'*) data_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/data/seamless" ;;
esac

project_slug=$(basename "$(dirname "$transcript")")
mkdir -p "$data_dir/cleared" 2>/dev/null || exit 0

printf '%s' "$input" | jq '{transcript_path, session_id, cwd, cleared_at: (now | floor)}' \
  > "$data_dir/cleared/$project_slug.json" 2>/dev/null

exit 0
