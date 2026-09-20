#!/bin/sh
# Fleet guard: the plugin's PreToolUse hook for Agent, Skill, Workflow and Bash.
#
# Usage: subagent-guard.sh <plugin-root> <data-dir>        (hook payload on stdin)
#
# Who is calling comes from the payload. A fleet agent_type resolves to a
# definition under agents/, and that definition's model is the caller the rules
# section is keyed by. Otherwise an empty agent_id means the main session,
# governed by the main section (the main thread may still carry an agent_type
# when the session runs as `claude --agent <name>`). Anything else is a built-in
# subagent, which is not governed here and passes.
#
# Rules come from $FLEET_RULES when it is set (and must exist), else from
# <data-dir>/fleet.json (seeded from the shipped fleet.default.json on first
# session start), else from the shipped default.
# The schema is described in README.md. Exit 2 refuses the call and hands the
# message to the calling model; exit 0 lets the call through.

set -eu

usage='usage: subagent-guard.sh <plugin-root> <data-dir>'
plugin_root=${1:?$usage}
data_dir=${2:-}

if [ -n "${FLEET_RULES:-}" ]; then
  rules=$FLEET_RULES
else
  rules=$data_dir/fleet.json
  [ -f "$rules" ] || rules="$plugin_root/fleet.default.json"
fi

payload=$(cat)

field() {
  printf '%s' "$payload" | jq -r "$1 // \"\""
}

# A missing key yields nothing; so does an expression that cannot be applied.
rule() {
  jq -r "$1" "$rules" 2>/dev/null | grep -v '^null$' || true
}

# A section is non-empty when it holds at least one entry.
nonempty() {
  [ "$(rule "$1 | length")" != "0" ]
}

# The matrix under a section, one "  model: efforts" line per row.
matrix() {
  rule "$1 | to_entries[] | \"  \" + .key + \": \" + (.value | join(\", \"))"
}

# allowed <section> <model> <effort>: the section lists the pair.
allowed() {
  rule "$1[\"$2\"][]" | grep -qx "$3"
}

# The definition file of a fleet agent type, with or without a plugin prefix.
agent_file() {
  bare=${1##*:}
  f="$plugin_root/agents/$bare.md"
  [ -n "$bare" ] && [ -f "$f" ] && printf '%s' "$f"
}

# frontmatter <file> <key>: the scalar value of a key between the --- fences.
# An agent without an effort key (a model with no effort control) is rung "default".
frontmatter() {
  awk -v key="$2:" '/^---$/ { if (++fence == 2) exit; next } fence == 1 && $1 == key { print $2; exit }' "$1"
}

refuse() {
  echo "Refused: $1" >&2
  exit 2
}

if [ ! -f "$rules" ]; then
  refuse "fleet rules file not found ($rules); nothing is allowed until it exists."
fi
if ! command -v jq >/dev/null 2>&1; then
  refuse "the fleet guard needs jq on PATH."
fi

tool=$(field '.tool_name')
agent_type=$(field '.agent_type')
agent_id=$(field '.agent_id')

# ---- main session ---------------------------------------------------------

if ! caller_file=$(agent_file "$agent_type") && [ -z "$agent_id" ]; then
  [ "$tool" = Agent ] || exit 0

  requested=$(field '.tool_input.subagent_type')
  model=$(field '.tool_input.model')

  if f=$(agent_file "$requested"); then
    nonempty '.main.fleet' || exit 0
    if [ -n "$model" ]; then
      refuse "fleet agent types carry their own model; '$requested' cannot be given '$model'. Pick the type that already runs on the model you need."
    fi
    callee=$(frontmatter "$f" model)
    effort=$(frontmatter "$f" effort); effort=${effort:-default}
    allowed .main.fleet "$callee" "$effort" && exit 0
    refuse "agent type '$requested' is not enabled for the main session. Enabled fleet agents (model: efforts):
$(matrix .main.fleet)"
  fi

  [ -n "$model" ] || exit 0
  nonempty '.main.builtin_agent_models' || exit 0
  rule '.main.builtin_agent_models[]' | grep -qx "$model" && exit 0
  refuse "model '$model' is not enabled for built-in agents. Enabled: $(rule '.main.builtin_agent_models | join(", ")')"
fi

# ---- inside a subagent ----------------------------------------------------

# Built-in agents are outside the fleet and outside these rules.
[ -n "$caller_file" ] || exit 0
caller=$(frontmatter "$caller_file" model)

case "$tool" in
  Agent)
    model=$(field '.tool_input.model')
    if [ -n "$model" ]; then
      refuse "the model parameter is not available here (requested '$model'). Each fleet agent type carries its own model; pick the type that already runs on the model you need."
    fi
    nonempty '.rules' || exit 0

    requested=$(field '.tool_input.subagent_type')
    if [ -z "$requested" ]; then
      refuse "subagent_type is required here; the default agent is not available."
    fi

    row=$(matrix ".rules[\"$caller\"]")
    if [ -z "$row" ]; then
      refuse "no spawn rules exist for a $caller agent; it may not spawn anything."
    fi

    if f=$(agent_file "$requested"); then
      callee=$(frontmatter "$f" model)
      effort=$(frontmatter "$f" effort); effort=${effort:-default}
      allowed ".rules[\"$caller\"]" "$callee" "$effort" && exit 0
      refuse "agent type '$requested' is not available from a $caller agent. Available to you (model: efforts):
$row"
    fi
    refuse "agent type '$requested' is not a fleet agent and is not available from this agent. Available to you (model: efforts):
$row"
    ;;

  Skill)
    skill=$(field '.tool_input.skill')
    if rule '.disallowed_skills[]' | grep -qx "$skill"; then
      refuse "skill '$skill' is not available from a fleet agent. Do the work within your own limits and report what you found."
    fi
    ;;

  Workflow)
    refuse "workflows spawn their own agents outside the fleet rules and are not available from a fleet agent."
    ;;

  Bash)
    cmd=$(field '.tool_input.command')
    for word in $(rule '.disallowed_commands[]'); do
      # Whole word only, so paths and names such as ~/.claude/ or claude-plugins pass.
      if printf '%s' "$cmd" | grep -qE "(^|[^[:alnum:]_./-])${word}([^[:alnum:]_.-]|\$)"; then
        refuse "'$word' is not available from a fleet agent. Report what needs it instead of working around it."
      fi
    done
    ;;
esac

exit 0
