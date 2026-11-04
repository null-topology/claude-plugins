# Shared by subagent-guard.sh, generate-agents.sh, sync-agents.sh and delegation-contract.sh, so
# that the agents the plugin registers, the calls the guard lets through and the briefs the
# contract checks follow one reading of the rules: which file is in force, whether it is valid,
# how a section is read, which models the fleet has and which efforts each takes, and which model
# an agent type stands for. Sourced, not run.
#
# The rules file is the only source of the fleet. Its models are every model it mentions: the keys
# of main.fleet, the keys of rules (the callers) and the keys of every row of rules. An effort
# entry is one of the words low, medium, high, xhigh, max and default, as a string written
# exactly so; any other entry ("lower", "ultra", "low\nmax", a number) is a configuration error
# (fleet_bad), never a level. A model's levels are the union of the valid entries given for it
# anywhere in main.fleet and the rows: exactly "default" means a model without effort control;
# "default" beside named levels is a configuration error; none at all (a model named only as a
# caller, or only with empty lists) means it takes any named level (fleet_named_levels), which a
# call can use only where the section that applies is empty and so allows every pair. models.json
# is benchmark data for the descriptions and the reference, and decides none of this.
#
# The caller sets plugin_root and data_dir, then rules (usually from fleet_rules_path) before it
# uses the readers, and may redefine fleet_unreadable (see fleet_read). fleet_agent also reads
# fleet_rules_ok (set it to 1 once $rules has passed fleet_rules_valid). Needs jq, awk and sed.

# The named levels a call can pass, in ladder order; what a model the rules give no levels takes.
fleet_named_levels='low medium high xhigh max'

# fleet_rules_path: the rules file in force. $FLEET_RULES when it is set, as given, whether or not
# it exists; else <data-dir>/fleet.json when there is a data directory and the file exists; else
# the shipped default.
fleet_rules_path() {
  if [ -n "${FLEET_RULES:-}" ]; then
    printf '%s\n' "$FLEET_RULES"
  elif [ -n "${data_dir:-}" ] && [ -f "$data_dir/fleet.json" ]; then
    printf '%s\n' "$data_dir/fleet.json"
  else
    printf '%s\n' "$plugin_root/fleet.default.json"
  fi
}

# fleet_rules_valid <file>: the file holds exactly one JSON document, an object or null (null reads
# as empty rules). An empty or whitespace-only file, several documents, any other type or text
# that is not JSON is invalid: read as rules, each would drop the denylists or, with several
# documents, let one document's answer stand for another's.
fleet_rules_valid() {
  [ -f "$1" ] &&
    [ "$(jq -s 'length == 1 and (.[0] | type == "object" or type == "null")' "$1" 2>/dev/null)" = true ]
}

# fleet_unreadable <expression>: called when a query on the rules fails. It does nothing here;
# the guard redefines it to refuse the call.
fleet_unreadable() { :; }

# The jq definitions every query gets: a list or a section that is missing (null) reads as empty,
# and one of another type is an error, so the query fails instead of reading as something else
# (an object iterated as a list, for one). size is the number of entries of a list or a section;
# jq's own length also measures a string or a number (0 for "" and for 0), which would read a
# wrong-typed allowlist as an empty one and so as "everything allowed".
#
# The fleet: fleet_ids is the list of models the rules mention, in the order they first appear
# (main.fleet, then the callers, then the rows). fleet_word holds for a valid effort entry: a
# string that is exactly one of fleet_words. fleet_levels($m) is the union of the valid entries
# given for $m, in the order of fleet_words (the ladder, then "default"); fleet_bad($m) is the list
# of the other entries given for it, each once, which make the model a configuration error.
fleet_defs='def list: if . == null then [] elif type == "array" then . else error("a list is \(type)") end;
def section: if . == null then {} elif type == "object" then . else error("a section is \(type)") end;
def size: if . == null then 0 elif type == "array" or type == "object" then length else error("an allowlist is \(type)") end;
def dedupe: reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end);
def fleet_ids: [(.main.fleet | section | keys_unsorted[]), (.rules | section | keys_unsorted[]),
  (.rules | section | .[] | section | keys_unsorted[])] | dedupe;
def fleet_ladder: ["low", "medium", "high", "xhigh", "max"];
def fleet_words: fleet_ladder + ["default"];
def fleet_word: type == "string" and (. as $x | fleet_words | any(.[]; . == $x));
def fleet_entries($m): (.main.fleet | section | .[$m]), (.rules | section | .[] | section | .[$m]) | list | .[];
def fleet_levels($m): [fleet_entries($m) | select(fleet_word)] as $l
  | [fleet_words[] | select(. as $c | $l | any(.[]; . == $c))];
def fleet_bad($m): [fleet_entries($m) | select(fleet_word | not)] | dedupe;'

# fleet_read <expression>: runs a jq expression on the rules file ($rules) and sets fleet_lines to
# its output, null lines dropped. The readers write their expressions with list and section, so
# that a missing section or entry reads as empty and a failure means a section of the wrong type
# or a file that could not be read: fleet_read then calls fleet_unreadable and returns 1, and a
# failure never reads as an empty list. Call it in the current shell, not in $(...), so that
# fleet_unreadable can end the caller. The expression reads $fleet_arg as $arg, so that a value
# such as a model id reaches jq as data, not as program text.
fleet_read() {
  if ! fleet_lines=$(jq -r --arg arg "${fleet_arg:-}" "$fleet_defs $1" "$rules" 2>/dev/null); then
    fleet_lines=
    fleet_unreadable "$1"
    return 1
  fi
  fleet_lines=$(printf '%s\n' "$fleet_lines" | grep -v '^null$') || fleet_lines=
}

# nonempty <section>: the section holds at least one entry. One that cannot be read, a section of
# a type that holds no entries ("", 0, false) included, counts as non-empty: fleet_unreadable has
# been called, and the lookups that follow fail too, so nothing passes through it.
nonempty() {
  fleet_read "$1 | size" || return 0
  [ "$fleet_lines" != 0 ]
}

# matrix <section>: sets fleet_lines to the matrix under a section, one "  model: efforts" line
# per row; a missing section has no rows. An entry that is not a valid effort is shown as JSON
# text, so that no line break in it splits the line.
matrix() {
  fleet_read "$1 | section | to_entries[] | \"  \" + .key + \": \" + (.value | list | map(if fleet_word then . else tojson end) | join(\", \"))"
}

# efforts <section> <model>: sets fleet_lines to the valid efforts (fleet_word) the section lists
# for the model, one per line; none when the section or the model's entry is missing. Any other
# entry is left out: it is never a level, and a string holding a line break would otherwise read
# as several (the guard refuses a model with such an entry before it asks, via fleet_levels_of).
efforts() {
  fleet_arg=$2
  fleet_read "$1 | section | .[\$arg] | list | .[] | select(fleet_word)" || { fleet_arg=; return 1; }
  fleet_arg=
}

# allowed <section> <model> <effort>: the section lists the pair.
allowed() {
  efforts "$1" "$2" || return 1
  case "
$fleet_lines
" in *"
$3
"*) return 0 ;; esac
  return 1
}

# frontmatter <file> <key>: the scalar value of a key between the --- fences.
frontmatter() {
  awk -v key="$2:" '/^---$/ { if (++fence == 2) exit; next } fence == 1 && $1 == key { print $2; exit }' "$1"
}

# fleet_levels_of <model>: sets fleet_member to 1 when the rules mention the model (it is a fleet
# model), fleet_levels to its levels, one per line (fleet_levels in fleet_defs): "default" for a
# model without effort control, named levels, both (a configuration error the caller reports), or
# none (any named level); and fleet_bad to the entries given for it that are not valid efforts, as
# JSON text joined with ", " (empty when there are none; any is a configuration error the caller
# reports). A query that fails calls fleet_unreadable and returns 1.
fleet_levels_of() {
  fleet_member=
  fleet_levels=
  fleet_bad=
  fleet_arg=$1
  fleet_read '(if fleet_ids | any(.[]; . == $arg) then "member" else "absent" end),
    (fleet_bad($arg) | map(tojson) | join(", ")), fleet_levels($arg)[]' ||
    { fleet_arg=; return 1; }
  fleet_arg=
  case $fleet_lines in member*) fleet_member=1 ;; esac
  fleet_bad=$(printf '%s\n' "$fleet_lines" | sed -n 2p)
  fleet_levels=$(printf '%s\n' "$fleet_lines" | sed 1,2d)
}

# fleet_names <id>: whether the rules in force ($rules, once fleet_rules_ok is 1) mention the
# model. Returns 0 when they do, 1 when they were read and do not, and 2 when they could not be
# read (no valid copy, or a section of the wrong type), so that a caller never takes "could not
# read" for "not named" and lets a fleet agent whose definition is gone pass as a built-in one.
fleet_names() {
  [ "${fleet_rules_ok:-}" = 1 ] && [ -n "${rules:-}" ] || return 2
  fleet_named=$(jq -r --arg arg "$1" "$fleet_defs fleet_ids | any(.[]; . == \$arg)" "$rules" 2>/dev/null) ||
    return 2
  [ "$fleet_named" = true ]
}

# fleet_agent <agent-type>: whether the type is a fleet agent; when it is, sets fleet_model.
# Returns 0 for a fleet agent, 1 for a type that is not one, and 2 when that cannot be told because
# the rules could not be read (fleet_names); the caller refuses then. A type with a colon is one
# only with this plugin's own prefix (fleet_prefixed): another plugin's agent of the same name is
# not this plugin's to govern or to authorize. There is one agent per fleet model, named by the
# model's id; the effort is a parameter of each call. Its definition under agents/ decides when it
# exists. Without one (agents/ holds only what the rules in force can reach, and a session keeps
# the definitions it loaded before a regeneration) the name is resolved against the models the
# rules in force mention (fleet_names), the source every definition is generated from, so a fleet
# agent of a fleet model never passes for a built-in one because its file is gone.
fleet_agent() {
  fleet_model=
  case $1 in
    *:*) fleet_prefixed "$1" || return 1; bare=${1#*:} ;;
    *) bare=$1 ;;
  esac
  # No agent name holds a slash or a further colon; a type that does is not a fleet agent.
  case $bare in '' | */* | *:*) return 1 ;; esac
  f="$plugin_root/agents/$bare.md"
  if [ -f "$f" ]; then
    fleet_model=$(frontmatter "$f" model)
    return 0
  fi
  fleet_names "$bare" || return $?
  fleet_model=$bare
}

# fleet_prefixed <agent-type>: the type carries this plugin's prefix, as every agent the plugin
# ships does. Such a type is a fleet agent even when fleet_agent cannot resolve it.
fleet_prefixed() {
  case $1 in *:*) ;; *) return 1 ;; esac
  plugin_name=$(jq -r '.name // empty' "$plugin_root/.claude-plugin/plugin.json" 2>/dev/null) || plugin_name=
  [ "${1%%:*}" = "${plugin_name:-fleet}" ]
}
