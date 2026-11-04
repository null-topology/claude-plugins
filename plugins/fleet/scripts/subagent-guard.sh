#!/bin/sh
# Fleet guard: the plugin's PreToolUse hook for Agent, Skill, Workflow and Bash,
# and its SubagentStart hook, which hands a starting fleet agent the skills and
# commands it cannot use, so that it does not try them.
#
# Usage: subagent-guard.sh <plugin-root> <data-dir>        (hook payload on stdin)
#
# Who is calling comes from the payload. A fleet agent_type resolves to a
# definition under agents/, or, when the file is gone, to a model id in
# models.json; its model is the caller the rules section is keyed by. A type
# with this plugin's prefix that resolves to neither is still a fleet agent and
# is refused. Otherwise an empty agent_id means the main session, governed by
# the main section (the main thread may still carry an agent_type when the
# session runs as `claude --agent <name>`). Anything else is a built-in
# subagent, which is not governed here and passes. The requested agent type of
# an Agent call is resolved the same way.
#
# There is one fleet agent per model; the reasoning effort is the Agent call's
# effort parameter. An Agent call to a fleet agent, from the main session or
# from a fleet agent, must pass a named level on that model's ladder (its
# rungs in models.json), or no effort for a model without effort control
# (rung "default"); the (model, rung) pair is then authorized against the
# rules as before. The caller's own effort is not needed: rules are keyed by
# the caller's model.
#
# Rules come from $FLEET_RULES when it is set (and must exist), else from
# <data-dir>/fleet.json (seeded from the shipped fleet.default.json on first
# session start), else from the shipped default. Where a call needs the rules,
# the file is read once, into a private copy that is checked and then answers
# every query, so a file replaced or removed during the call cannot change the
# answer; a query that fails (a section of the wrong type) refuses the call.
# The rule readers and the agent-type resolution live in fleet-rules.sh, shared
# with the generator. The schema is described in README.md. Exit 2 refuses the
# call and hands the message to the calling model; exit 0 lets the call through.

set -eu

usage='usage: subagent-guard.sh <plugin-root> <data-dir>'
plugin_root=${1:?$usage}
data_dir=${2:-}

# Without the shared readers nothing can be checked, so nothing passes.
lib=$(dirname "$0")/fleet-rules.sh
if [ ! -f "$lib" ]; then
  echo "Refused: the fleet guard library is missing ($lib); nothing is allowed until the plugin is reinstalled." >&2
  exit 2
fi
. "$lib"

rules_path=$(fleet_rules_path)
rules=

payload=$(cat)

field() {
  printf '%s' "$payload" | jq -r "$1 // \"\""
}

refuse() {
  # printf, not echo: some shells' echo expands backslashes, and a message may quote call input.
  printf 'Refused: %s\n' "$1" >&2
  exit 2
}

# A query on the rules that fails refuses the call: read as an empty list, a denylist of the
# wrong type would let everything through.
fleet_unreadable() {
  refuse "the fleet rules ($rules_path) could not be read: the query $1 failed, so a section has the wrong type; fleet checks refuse everything until it is fixed."
}

# check_effort <requested-type>: the call's effort against the ladder of the model fleet_agent
# resolved for the requested type; sets rung to the rung the rules are read for, or refuses. A
# model with a ladder needs a named level on it: a missing effort would run the agent at the
# caller's session effort, and a relative one (lower, higher) is not a level the rules list. A
# model without one takes no effort at all, so a call cannot set what the rules call "default".
check_effort() {
  # A value that is not a plain lowercase word is read as JSON text, so that no line break or other
  # character can be trimmed away into a level that matches.
  effort=$(printf '%s' "$payload" | jq -r '.tool_input.effort
    | if . == null then "" elif type == "string" and test("\\A[a-z]+\\z") then . else tojson end' 2>/dev/null) ||
    refuse "the effort of the call to '$1' could not be read from the hook payload."
  if [ -z "$fleet_listed" ]; then
    refuse "agent type '$1' runs on '$fleet_model', which has no effort rungs in models.json, so the call's effort cannot be checked; nothing is allowed for it until the model is listed there."
  fi
  ladder=$(fleet_ladder)
  levels=$(printf '%s\n' "$ladder" | awk 'NF { printf "%s%s", (n++ ? ", " : ""), $0 }')
  if [ -z "$ladder" ]; then
    if [ -n "$effort" ]; then
      refuse "'$fleet_model' has no adjustable reasoning effort, so '$1' takes no effort parameter (requested '$effort'). Call it without effort."
    fi
    rung=default
    return 0
  fi
  case $effort in
    '')
      refuse "agent type '$1' needs a named effort: pass effort as one of $levels, the level chosen with fleet:selecting-subagent-model. Without it the agent would run at an effort no rule was asked about." ;;
    lower | higher)
      refuse "effort '$effort' is relative and is not accepted for a fleet agent: pass a named level of '$fleet_model' ($levels), the one chosen with fleet:selecting-subagent-model." ;;
    *[!a-z]*)
      refuse "effort '$effort' is not a level of '$fleet_model'. Its levels: $levels." ;;
  esac
  case "
$ladder
" in *"
$effort
"*) ;; *)
    refuse "effort '$effort' is not a level of '$fleet_model'. Its levels: $levels." ;;
  esac
  rung=$effort
}

snapshot=
cleanup() {
  [ -z "$snapshot" ] || rm -f "$snapshot"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM

# require_rules: reads the rules file once, into a private copy, checks the copy and points every
# query at it. A rules file that is not exactly one JSON object (or null) would read as empty
# rules, dropping the denylists, or, with several documents, let one document's answer stand for
# another's (fleet_rules_valid). Called only where rules are read, so a broken file does not stop
# the main session's own calls.
require_rules() {
  snapshot=$(mktemp "${TMPDIR:-/tmp}/fleet-rules.XXXXXX") ||
    refuse "the fleet guard could not make a private copy of the rules file ($rules_path); nothing is allowed until it can."
  cp "$rules_path" "$snapshot" 2>/dev/null ||
    refuse "fleet rules file could not be read ($rules_path); nothing is allowed until it can."
  rules=$snapshot
  fleet_rules_valid "$rules" ||
    refuse "fleet rules file is invalid ($rules_path): it must hold exactly one JSON object, and an empty file, several documents or text that is not JSON is refused; fleet checks refuse everything until it is fixed."
}

if [ ! -f "$rules_path" ]; then
  refuse "fleet rules file not found ($rules_path); nothing is allowed until it exists."
fi
if ! command -v jq >/dev/null 2>&1; then
  refuse "the fleet guard needs jq on PATH."
fi

event=$(field '.hook_event_name')
tool=$(field '.tool_name')
agent_type=$(field '.agent_type')
agent_id=$(field '.agent_id')

# ---- a subagent starting ----------------------------------------------------

# Here agent_type is the agent being started, not a caller. Only fleet agents
# get the limits, including one whose definition file is gone; the text goes to
# the new agent. Exit 2 at this event shows the message to the user and does not
# stop the agent.
if [ "$event" = SubagentStart ]; then
  fleet_agent "$agent_type" || fleet_prefixed "$agent_type" || exit 0
  require_rules
  fleet_read '.disallowed_skills | list | join(", ")'
  skills=$fleet_lines
  fleet_read '.disallowed_commands | list | join(", ")'
  commands=$fleet_lines
  [ -n "$skills$commands" ] || exit 0
  context='Fleet limits for this agent (from the fleet rules in force now):'
  if [ -n "$skills" ]; then
    context="$context
- Skills you cannot load: $skills. Do not call them. Their absence is not a reason to stop: carry on with the tools and the other skills you have, within the brief."
  fi
  if [ -n "$commands" ]; then
    context="$context
- Commands you cannot run: $commands. A step that needs one of them is a blocker: report what needs it."
  fi
  jq -n --arg context "$context" \
    '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: $context}}'
  exit 0
fi

# ---- main session ---------------------------------------------------------

# The caller: a fleet agent when its type resolves. One that carries the fleet
# prefix but resolves to nothing is a fleet agent the guard cannot place, and
# nothing it calls passes; built-in treatment would leave it ungoverned.
caller=
caller_known=
if fleet_agent "$agent_type"; then
  caller=$fleet_model
  caller_known=1
elif [ -n "$agent_id" ] && fleet_prefixed "$agent_type"; then
  refuse "agent type '$agent_type' is a fleet agent with no definition under agents/ and no entry in models.json; nothing it calls is allowed."
fi

if [ -z "$caller_known" ] && [ -z "$agent_id" ]; then
  [ "$tool" = Agent ] || exit 0
  require_rules

  requested=$(field '.tool_input.subagent_type')
  model=$(field '.tool_input.model')

  if fleet_agent "$requested"; then
    # The effort is checked even when main.fleet allows everything: it is what the agent runs at.
    check_effort "$requested"
    nonempty '.main.fleet' || exit 0
    if [ -n "$model" ]; then
      refuse "fleet agent types carry their own model; '$requested' cannot be given '$model'. Pick the type that already runs on the model you need."
    fi
    allowed .main.fleet "$fleet_model" "$rung" && exit 0
    matrix .main.fleet
    refuse "agent type '$requested' at effort '$rung' is not enabled for the main session. Enabled fleet agents (model: efforts):
$fleet_lines"
  fi
  if fleet_prefixed "$requested"; then
    refuse "agent type '$requested' is not defined in this fleet: no definition under agents/ and no entry in models.json."
  fi

  [ -n "$model" ] || exit 0
  nonempty '.main.builtin_agent_models' || exit 0
  fleet_read '.main | section | .builtin_agent_models | list | .[]'
  printf '%s\n' "$fleet_lines" | grep -qx -e "$model" && exit 0
  fleet_read '.main | section | .builtin_agent_models | list | join(", ")'
  refuse "model '$model' is not enabled for built-in agents. Enabled: $fleet_lines"
fi

# ---- inside a subagent ----------------------------------------------------

# Built-in agents are outside the fleet and outside these rules.
[ -n "$caller_known" ] || exit 0
require_rules

case "$tool" in
  Agent)
    model=$(field '.tool_input.model')
    if [ -n "$model" ]; then
      refuse "the model parameter is not available here (requested '$model'). Each fleet agent type carries its own model; pick the type that already runs on the model you need."
    fi

    requested=$(field '.tool_input.subagent_type')
    # The effort is checked even when rules allow everything: it is what the agent runs at.
    target=
    if fleet_agent "$requested"; then
      target=1
      check_effort "$requested"
    fi
    nonempty '.rules' || exit 0

    if [ -z "$requested" ]; then
      refuse "subagent_type is required here; the default agent is not available."
    fi

    matrix ".rules[\"$caller\"]"
    row=$fleet_lines
    if [ -z "$row" ]; then
      refuse "no spawn rules exist for a $caller agent; it may not spawn anything."
    fi

    if [ -n "$target" ]; then
      allowed ".rules[\"$caller\"]" "$fleet_model" "$rung" && exit 0
      refuse "agent type '$requested' at effort '$rung' is not available from a $caller agent. Available to you (model: efforts):
$row"
    fi
    refuse "agent type '$requested' is not a fleet agent and is not available from this agent. Available to you (model: efforts):
$row"
    ;;

  Skill)
    skill=$(field '.tool_input.skill')
    fleet_read '.disallowed_skills | list | .[]'
    if [ -n "$fleet_lines" ] && printf '%s\n' "$fleet_lines" | grep -qx -e "$skill"; then
      refuse "skill '$skill' is not available from a fleet agent. This is not a reason to stop: carry on with the tools and the other skills you have, within the brief."
    fi
    ;;

  Workflow)
    refuse "workflows spawn their own agents outside the fleet rules and are not available from a fleet agent."
    ;;

  Bash)
    cmd=$(field '.tool_input.command')
    fleet_read '.disallowed_commands | list | .[]'
    for word in $fleet_lines; do
      # Whole word only, so paths and names such as ~/.claude/ or claude-plugins pass.
      if printf '%s' "$cmd" | grep -qE "(^|[^[:alnum:]_./-])${word}([^[:alnum:]_.-]|\$)"; then
        refuse "'$word' is not available from a fleet agent. Report what needs it instead of working around it."
      fi
    done
    ;;
esac

exit 0
