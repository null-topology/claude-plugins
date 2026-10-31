# 1password-bridge exit trap, sourced from CLAUDE_ENV_FILE before every Bash command.
# PostToolUseFailure cannot rewrite a failed command's output. While the session holds a masked
# value (its marker file exists), a failed command therefore exits 0 and ends with a line
# [exit N], so its output goes through PostToolUse, which masks it. The marker is checked at
# exit, so a command that redeems a ticket and then fails is covered. Without the marker the
# status is left alone. This file holds no value.
trap '__op_bridge_rc=$?
trap - EXIT
if [ "$__op_bridge_rc" -ne 0 ] && [ -n "${OP_BRIDGE_STATE_DIR:-}" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] &&
  [ -f "$OP_BRIDGE_STATE_DIR/sessions/$CLAUDE_CODE_SESSION_ID/masked" ]; then
  printf "\n[exit %s]\n" "$__op_bridge_rc"
  exit 0
fi
exit "$__op_bridge_rc"' EXIT
