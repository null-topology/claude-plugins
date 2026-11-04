#!/bin/sh
# Fleet guard: the plugin's PreToolUse hook for Agent, Skill, Workflow and Bash,
# and its SubagentStart hook, which hands a starting fleet agent the skills and
# commands it cannot use, so that it does not try them.
#
# Usage: subagent-guard.sh <plugin-root> <data-dir>        (hook payload on stdin)
#
# Who is calling comes from the payload. An empty agent_id means the main
# session, governed by the main section, whatever agent_type says (the main
# thread may carry an agent_type when the session runs as
# `claude --agent <name>`). Otherwise the caller is a subagent: a fleet
# agent_type resolves to a definition under agents/, or, when the file is gone,
# to a model the rules in force mention; its model is the caller the rules
# section is keyed by. A type with this plugin's prefix (fleet:) that resolves
# to neither is still a fleet agent and is refused; a type with another
# plugin's prefix is not a fleet agent. Anything else is a built-in subagent,
# which is not governed here and passes, but only once the rules have been
# read: a bare type with no definition is told from a fleet agent whose file is
# gone by the rules, so rules that cannot be read refuse the call instead. The
# requested agent type of an Agent call is resolved the same way.
#
# There is one fleet agent per fleet model, and the fleet models are the ones
# the rules file mentions (fleet-rules.sh); the reasoning effort is the Agent
# call's effort parameter. An Agent call to a fleet agent, from the main
# session or from a fleet agent, is refused when the rules do not mention its
# model. Otherwise it must pass one of the levels the rules give that model, any
# named level when they give it none, or no effort for a model the rules give
# only "default"; "default" beside named levels, or an effort entry that is not
# one of low, medium, high, xhigh, max and default, refuses every call to that
# model as a configuration error. A refusal for a missing, relative or
# off-level effort lists the levels the section that applies (main.fleet, or
# the caller's row) gives the model, when it lists it, so that the corrected
# call can pass. The (model, effort) pair is then authorized against the rules
# as before. The caller's own effort is not needed: rules are keyed by the
# caller's model. models.json plays no part here.
#
# Rules come from $FLEET_RULES when it is set (and must exist), else from
# <data-dir>/fleet.json (seeded from the shipped fleet.default.json on first
# session start), else from the shipped default. The file is read once per
# call, into a private copy that is checked and then answers every query, so a
# file replaced or removed during the call cannot change the answer. A call
# that needs the rules is refused when the copy is invalid; a query that fails
# (a section of the wrong type) refuses the call.
# The rule readers and the agent-type resolution live in fleet-rules.sh, shared
# with the generator. The schema is described in README.md. Exit 2 refuses the
# call and hands the message to the calling model; exit 0 lets the call through.
# A payload that is not one JSON object, or whose tool_input is not an object,
# is refused, and so is any other failure: the guard exits 0 or 2 and nothing
# else, since Claude Code blocks a call only on 2.

set -eu

# Every exit goes through here: the private copy of the rules goes, and a status other than 0 or 2
# (a failed command under set -e, an unset variable) becomes a refusal.
snapshot=
on_exit() {
  status=$?
  if [ -n "$snapshot" ]; then rm -f "$snapshot" 2>/dev/null || :; fi
  case $status in
    0 | 2) ;;
    *)
      printf 'Refused: the fleet guard stopped on an unexpected error (status %s), so the call could not be checked; nothing is allowed until it is fixed.\n' "$status" >&2
      exit 2
      ;;
  esac
}
trap on_exit EXIT
trap 'exit 2' HUP INT TERM

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

refuse() {
  # printf, not echo: some shells' echo expands backslashes, and a message may quote call input.
  printf 'Refused: %s\n' "$1" >&2
  exit 2
}

# field <expression>: a value of the payload, which has been checked to be one object whose
# tool_input, when present, is an object, so the expression cannot fail on its shape.
field() {
  printf '%s' "$payload" | jq -r "$1 // \"\""
}

# A query on the rules that fails refuses the call: read as an empty list, a denylist of the
# wrong type would let everything through.
fleet_unreadable() {
  refuse "the fleet rules ($rules_path) could not be read: the query $1 failed, so a section has the wrong type; fleet checks refuse everything until it is fixed."
}

# check_effort <requested-type>: the call's effort against the levels the rules give the model
# fleet_agent resolved for the requested type; sets rung to the rung the rules are read for, or
# refuses. The rules must mention the model: one they do not is not in the fleet. A model with
# named levels needs one of them: a missing effort would run the agent at the caller's session
# effort, a relative one (lower, higher) is not a level the rules list, and any other value is
# refused so that a typo does not pass for a level. A model the rules give no levels takes any
# named level, still by name; the pair check after this lets it through only where the section
# allows every pair. A model the rules give only "default" takes no effort at all, so a call
# cannot set what the rules call "default"; "default" beside named levels is a configuration
# error, and no call to that model passes until the rules are fixed.
check_effort() {
  # A value that is not a plain lowercase word is read as JSON text, so that no line break or other
  # character can be trimmed away into a level that matches.
  effort=$(printf '%s' "$payload" | jq -r '.tool_input.effort
    | if . == null then "" elif type == "string" and test("\\A[a-z]+\\z") then . else tojson end' 2>/dev/null) ||
    refuse "the effort of the call to '$1' could not be read from the hook payload."
  fleet_levels_of "$fleet_model"
  if [ -z "$fleet_member" ]; then
    refuse "agent type '$1' runs on '$fleet_model', which the fleet rules in force ($rules_path) do not mention, so it is not a fleet model; nothing is allowed for it until the rules name it."
  fi
  if [ -n "$fleet_bad" ]; then
    refuse "the fleet rules ($rules_path) give '$fleet_model' the effort entries $fleet_bad, which are not levels: an effort entry is one of low, medium, high, xhigh, max, or default alone for a model without effort control, so the efforts of '$1' cannot be checked; nothing is allowed for it until the rules are fixed."
  fi
  levels=$(printf '%s\n' "$fleet_levels" | awk 'NF { printf "%s%s", (n++ ? ", " : ""), $0 }')
  case "
$fleet_levels
" in *"
default
"*)
    if [ "$fleet_levels" != default ]; then
      refuse "the fleet rules ($rules_path) give '$fleet_model' both 'default' and named levels ($levels): 'default' marks a model without effort control and stands alone, so the efforts of '$1' cannot be checked; nothing is allowed for it until the rules are fixed."
    fi
    if [ -n "$effort" ]; then
      refuse "'$fleet_model' has no adjustable reasoning effort, so '$1' takes no effort parameter (requested '$effort'). Call it without effort."
    fi
    rung=default
    return 0
    ;;
  esac
  ladder=$fleet_levels
  if [ -z "$ladder" ]; then
    # No levels in the rules: any named level.
    ladder=$(printf '%s\n' $fleet_named_levels)
    levels=$(printf '%s\n' "$ladder" | awk 'NF { printf "%s%s", (n++ ? ", " : ""), $0 }')
  fi
  # The levels a corrected call is pointed to: those the section that applies ($2) lists for the
  # model, in ladder order, when it lists any; else the model's levels. Pointing to a level of the
  # model that the section does not allow would turn a correctable refusal into a final one.
  efforts "$2" "$fleet_model"
  offer=$(printf '%s\n' "$fleet_lines" | awk -v ladder="$(printf '%s ' $ladder)" '
    NF { listed[$0] = 1 }
    END { n = split(ladder, l, " "); for (i = 1; i <= n; i++) if (l[i] in listed) printf "%s%s", (k++ ? ", " : ""), l[i] }')
  if [ -z "$offer" ] || [ "$offer" = "$levels" ]; then
    offer=$levels
    offer_note="Its levels: $levels."
  else
    offer_note="The levels available here: $offer."
  fi
  case $effort in
    '')
      refuse "agent type '$1' needs a named effort: pass effort as one of $offer, the level chosen with fleet:selecting-subagent-model. Without it the agent would run at an effort no rule was asked about." ;;
    lower | higher)
      refuse "effort '$effort' is relative and is not accepted for a fleet agent: pass a named level of '$fleet_model' ($offer), the one chosen with fleet:selecting-subagent-model." ;;
    *[!a-z]*)
      refuse "effort '$effort' is not a level of '$fleet_model'. $offer_note" ;;
  esac
  case "
$ladder
" in *"
$effort
"*) ;; *)
    refuse "effort '$effort' is not a level of '$fleet_model'. $offer_note" ;;
  esac
  rung=$effort
}

if [ ! -f "$rules_path" ]; then
  refuse "fleet rules file not found ($rules_path); nothing is allowed until it exists."
fi
if ! command -v jq >/dev/null 2>&1; then
  refuse "the fleet guard needs jq on PATH."
fi

# The payload: exactly one JSON object, whose tool_input, when present, is an object. Anything else
# cannot be checked, and a failed read of it must not end the guard with a status that lets the
# call through.
payload=$(cat) || refuse "the hook payload could not be read."
if ! printf '%s' "$payload" | jq -e -s 'length == 1 and (.[0] | type == "object"
    and ((has("tool_input") | not) or (.tool_input | type == "object")))' >/dev/null 2>&1; then
  refuse "the hook payload is not one JSON object whose tool_input, when present, is an object, so the call cannot be checked."
fi

# The one read of the rules file: a private copy, checked once, that every query reads. The copy is
# taken for every call, since telling a fleet agent whose definition is gone from a built-in one
# needs the fleet models; only the main session's calls other than Agent pass when the copy failed
# or is invalid (require_rules, resolve).
copy_failed=
read_failed=
fleet_rules_ok=
if snapshot=$(mktemp "${TMPDIR:-/tmp}/fleet-rules.XXXXXX" 2>/dev/null); then
  if cp "$rules_path" "$snapshot" 2>/dev/null; then
    rules=$snapshot
    if fleet_rules_valid "$rules"; then fleet_rules_ok=1; fi
  else
    read_failed=1
  fi
else
  snapshot=
  copy_failed=1
fi

# require_rules: the call needs the rules: the private copy must exist and be valid. A rules file
# that is not exactly one JSON object (or null) would read as empty rules, dropping the denylists,
# or, with several documents, let one document's answer stand for another's (fleet_rules_valid).
# Called only where rules are read, so a broken file does not stop the main session's own calls.
require_rules() {
  [ -z "$copy_failed" ] ||
    refuse "the fleet guard could not make a private copy of the rules file ($rules_path); nothing is allowed until it can."
  [ -z "$read_failed" ] ||
    refuse "fleet rules file could not be read ($rules_path); nothing is allowed until it can."
  [ -n "$fleet_rules_ok" ] ||
    refuse "fleet rules file is invalid ($rules_path): it must hold exactly one JSON object, and an empty file, several documents or text that is not JSON is refused; fleet checks refuse everything until it is fixed."
}

# resolve <agent-type>: sets kind to "fleet" for a fleet agent (fleet_model set), "stray" for a
# type with this plugin's prefix that resolves to nothing, or "other". A type fleet_agent cannot
# place because the rules could not be read refuses the call: taken for "other", a fleet agent
# whose definition is gone would pass as a built-in one.
resolve() {
  resolved=0
  fleet_agent "$1" || resolved=$?
  case $resolved in
    0) kind=fleet ;;
    1) if fleet_prefixed "$1"; then kind=stray; else kind=other; fi ;;
    *)
      require_rules
      fleet_unreadable fleet_ids
      ;;
  esac
}

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
  resolve "$agent_type"
  [ "$kind" != other ] || exit 0
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

# An empty agent_id is the main session, whatever agent_type says: a session
# started with `claude --agent <name>` carries that type on its own calls.
if [ -z "$agent_id" ]; then
  [ "$tool" = Agent ] || exit 0
  require_rules

  requested=$(field '.tool_input.subagent_type')
  model=$(field '.tool_input.model')

  resolve "$requested"
  if [ "$kind" = fleet ]; then
    # Before any early exit: an open main.fleet allows every pair, not another model.
    if [ -n "$model" ]; then
      refuse "fleet agent types carry their own model; '$requested' cannot be given '$model'. Pick the type that already runs on the model you need."
    fi
    # The effort is checked even when main.fleet allows everything: it is what the agent runs at.
    check_effort "$requested" .main.fleet
    nonempty '.main.fleet' || exit 0
    allowed .main.fleet "$fleet_model" "$rung" && exit 0
    matrix .main.fleet
    refuse "agent type '$requested' at effort '$rung' is not enabled for the main session. Enabled fleet agents (model: efforts):
$fleet_lines"
  fi
  if [ "$kind" = stray ]; then
    refuse "agent type '$requested' is not defined in this fleet: no definition under agents/, and the fleet rules in force do not mention such a model."
  fi

  [ -n "$model" ] || exit 0
  nonempty '.main.builtin_agent_models' || exit 0
  fleet_read '.main | section | .builtin_agent_models | list | .[]'
  printf '%s\n' "$fleet_lines" | grep -qx -e "$model" && exit 0
  fleet_read '.main | section | .builtin_agent_models | list | join(", ")'
  refuse "model '$model' is not enabled for built-in agents. Enabled: $fleet_lines"
fi

# ---- inside a subagent ----------------------------------------------------

# The caller: a fleet agent when its type resolves. One that carries the fleet
# prefix but resolves to nothing is a fleet agent the guard cannot place, and
# nothing it calls passes; built-in treatment would leave it ungoverned.
# Built-in agents, and other plugins' agents, are outside the fleet and outside
# these rules.
resolve "$agent_type"
case $kind in
  fleet) caller=$fleet_model ;;
  stray)
    # Without valid rules the type could not be looked up; that is the fault to report.
    require_rules
    refuse "agent type '$agent_type' is a fleet agent with no definition under agents/, and the fleet rules in force do not mention its model; nothing it calls is allowed." ;;
  *) exit 0 ;;
esac
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
    resolve "$requested"
    if [ "$kind" = fleet ]; then
      target=1
      check_effort "$requested" ".rules[\"$caller\"]"
    elif [ "$kind" = stray ]; then
      refuse "agent type '$requested' is not defined in this fleet: no definition under agents/, and the fleet rules in force do not mention such a model."
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
