# Shared by subagent-guard.sh, generate-agents.sh, sync-agents.sh and delegation-contract.sh, so
# that the agents the plugin registers, the calls the guard lets through and the briefs the
# contract checks follow one reading of the rules: which file is in force, whether it is valid,
# how a section is read, which models the fleet has and which efforts each takes, and which model
# an agent type stands for. Sourced, not run.
#
# The rules file is the only source of the fleet. Its models are every model it mentions: the keys
# of main.fleet, the keys of rules (the callers) and the keys of every row of rules. A model's
# levels are the union of the effort lists given for it anywhere in main.fleet and the rows:
# exactly "default" means a model without effort control; "default" beside named levels is a
# configuration error; none at all (a model named only as a caller, or only with empty lists)
# means it takes any named level (fleet_named_levels), which a call can use only where the
# section that applies is empty and so allows every pair. models.json is benchmark data for the
# descriptions and the reference, and decides none of this.
#
# The caller sets plugin_root and data_dir, then rules (usually from fleet_rules_path) before it
# uses the readers, and may redefine fleet_unreadable (see fleet_read). fleet_agent also reads
# fleet_rules_ok (set it to 1 once $rules has passed fleet_rules_valid). Needs jq and awk.

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
# (main.fleet, then the callers, then the rows). fleet_levels($m) is the union of the levels given
# for $m, the named ones in ladder order first; only entries a call could pass are levels (a plain
# lowercase word: the guard reads any other effort as JSON text, which matches nothing).
fleet_defs='def list: if . == null then [] elif type == "array" then . else error("a list is \(type)") end;
def section: if . == null then {} elif type == "object" then . else error("a section is \(type)") end;
def size: if . == null then 0 elif type == "array" or type == "object" then length else error("an allowlist is \(type)") end;
def dedupe: reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end);
def fleet_ids: [(.main.fleet | section | keys_unsorted[]), (.rules | section | keys_unsorted[]),
  (.rules | section | .[] | section | keys_unsorted[])] | dedupe;
def fleet_ladder: ["low", "medium", "high", "xhigh", "max"];
def fleet_levels($m): [(.main.fleet | section | .[$m]), (.rules | section | .[] | section | .[$m])
  | list | .[] | select(type == "string" and test("\\A[a-z]+\\z"))] | dedupe
  | . as $l | [fleet_ladder[] | select(. as $c | $l | any(.[]; . == $c))]
    + [$l[] | select(. as $x | fleet_ladder | any(.[]; . == $x) | not)];'

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
# per row; a missing section has no rows.
matrix() {
  fleet_read "$1 | section | to_entries[] | \"  \" + .key + \": \" + (.value | list | join(\", \"))"
}

# efforts <section> <model>: sets fleet_lines to the efforts the section lists for the model, one
# per line; none when the section or the model's entry is missing.
efforts() {
  fleet_arg=$2
  fleet_read "$1 | section | .[\$arg] | list | .[]" || { fleet_arg=; return 1; }
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
# model), and fleet_levels to its levels, one per line (fleet_levels in fleet_defs): "default" for a
# model without effort control, named levels, both (a configuration error the caller reports), or
# none (any named level). A query that fails calls fleet_unreadable and returns 1.
fleet_levels_of() {
  fleet_member=
  fleet_levels=
  fleet_arg=$1
  fleet_read '(if fleet_ids | any(.[]; . == $arg) then "member" else "absent" end), fleet_levels($arg)[]' ||
    { fleet_arg=; return 1; }
  fleet_arg=
  case $fleet_lines in member*) fleet_member=1 ;; esac
  fleet_levels=$(printf '%s\n' "$fleet_lines" | sed 1d)
}

# fleet_names <id>: the rules in force ($rules, once fleet_rules_ok is 1) mention the model. Any
# failure (no valid rules, a section of the wrong type) reads as "no": it only decides whether a
# type without a definition is still a fleet agent, and a type with the fleet prefix is one anyway
# (fleet_prefixed).
fleet_names() {
  [ "${fleet_rules_ok:-}" = 1 ] && [ -n "${rules:-}" ] &&
    jq -e --arg arg "$1" "$fleet_defs fleet_ids | any(.[]; . == \$arg)" "$rules" >/dev/null 2>&1
}

# fleet_agent <agent-type>: whether the type, with or without a plugin prefix, is a fleet agent;
# when it is, sets fleet_model. There is one agent per fleet model, named by the model's id; the
# effort is a parameter of each call. Its definition under agents/ decides when it exists. Without
# one (agents/ holds only what the rules in force can reach, and a session keeps the definitions it
# loaded before a regeneration) the name is resolved against the models the rules in force
# mention (fleet_names), the source every definition is generated from, so a fleet agent of a
# fleet model never passes for a built-in one because its file is gone.
fleet_agent() {
  fleet_model=
  bare=${1##*:}
  # No agent name holds a slash; a type that does is a path, not a fleet agent.
  case $bare in '' | */*) return 1 ;; esac
  f="$plugin_root/agents/$bare.md"
  if [ -f "$f" ]; then
    fleet_model=$(frontmatter "$f" model)
    return 0
  fi
  fleet_names "$bare" || return 1
  fleet_model=$bare
}

# fleet_prefixed <agent-type>: the type carries this plugin's prefix, as every agent the plugin
# ships does. Such a type is a fleet agent even when fleet_agent cannot resolve it.
fleet_prefixed() {
  case $1 in *:*) ;; *) return 1 ;; esac
  plugin_name=$(jq -r '.name // empty' "$plugin_root/.claude-plugin/plugin.json" 2>/dev/null) || plugin_name=
  [ "${1%%:*}" = "${plugin_name:-fleet}" ]
}
