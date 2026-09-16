#!/bin/sh
# UserPromptSubmit hook for the seamless plugin. POSIX sh: runs under dash, ash, bash and zsh.
#
# Catches the one case no SessionStart source can: the plugin was installed or reloaded while
# this session was already running, so the session never received the plugin's context. The
# SessionStart hook leaves a marker file per session id after it has spoken; this hook checks for
# that marker on every prompt. Marker present: exit at once (one stat, no output). Marker absent:
# this session started before the plugin was loaded, so hand it the onboarding text once and
# leave the marker. The transcript is never read, whatever its size.
#
# Usage: user-prompt-onboard.sh <plugin data dir>

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

session_id=$(printf '%s' "$input" | json_str session_id)
[ -n "$session_id" ] || exit 0
case "$session_id" in
  */*|.*) exit 0 ;;
esac

data_dir="${1:-}"
case "$data_dir" in
  ""|*'${CLAUDE_PLUGIN_DATA}'*) data_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/data/seamless" ;;
esac
marker="$data_dir/onboarded/$session_id"

[ -f "$marker" ] && exit 0

ctx="[seamless] seamless is installed: before any further work, invoke the seamless:save skill once to load its rules, and keep the handoff living."

mkdir -p "$data_dir/onboarded" 2>/dev/null && : > "$marker" 2>/dev/null

msg="seamless: this session started before the plugin was loaded; its rules are injected with this prompt."

if [ "$have_jq" -eq 1 ]; then
  jq -n --arg ctx "$ctx" --arg msg "$msg" \
    '{systemMessage: $msg, hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}'
else
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
    "$(printf '%s' "$msg" | json_escape)" "$(printf '%s' "$ctx" | json_escape)"
fi
