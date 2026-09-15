#!/bin/sh
# SessionEnd hook for the seamless plugin. POSIX sh: runs under dash, ash, bash and zsh.
#
# When a session ends because of /clear, remember which transcript was cleared, so that the
# SessionStart hook of the session that replaces it can read exactly that transcript instead of
# guessing "the newest one". One small JSON marker per project, in the plugin's data directory.
# Works without jq: the hook input is flat JSON and the marker is written by hand.
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

json_escape() {
  tab=$(printf '\t')
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" \
    | awk 'BEGIN { ORS = "" } { if (NR > 1) printf "\\n"; printf "%s", $0 }'
}

reason=$(printf '%s' "$input" | json_str reason)
[ "$reason" = "clear" ] || exit 0

transcript=$(printf '%s' "$input" | json_str transcript_path)
[ -n "$transcript" ] || exit 0

data_dir="${1:-}"
case "$data_dir" in
  ""|*'${CLAUDE_PLUGIN_DATA}'*) data_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/data/seamless" ;;
esac

project_slug=$(basename "$(dirname "$transcript")")
mkdir -p "$data_dir/cleared" 2>/dev/null || exit 0

printf '{"transcript_path":"%s","cleared_at":%s}\n' \
  "$(printf '%s' "$transcript" | json_escape)" "$(date +%s)" \
  > "$data_dir/cleared/$project_slug.json" 2>/dev/null

exit 0
