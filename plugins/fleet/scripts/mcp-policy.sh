# Fleet MCP policy: the rules that govern a fleet agent's MCP tool calls. Sourced, not run; POSIX sh
# and jq.
#
# A rule is one string compared with the complete tool name: a complete name, or a mask in which
# `*` stands for any run of characters, none included (several in a row count as one). A valid rule
# is 1 to 256 bytes of [A-Za-z0-9_.*-] and starts with `mcp__` or `*`; a list holds at most 256
# rules. Validation anchors with \A and \z, so a rule ending in a line break is invalid.
#
# The matcher uses no regular expression and no shell pattern: it splits the rule at `*`, the first
# piece must open the name, the last must close it, and each piece between is searched leftmost from
# where the previous one ended, inside what the closing piece leaves free. Its time grows linearly
# with the name for each piece. Rules and names reach jq as data, never as program text. A name with
# a character outside printable ASCII is an error, and an error is never read as "no match".
#
# A frame is one fleet agent's own lists: {"self": true, "allow": [...], "deny": [...]} for the
# caller, {"id": "<agent id>", "allow": [...], "deny": [...]} for a fleet agent above it. Frame f
# permits a tool when no rule of the global deny list or of f's deny list matches it, and the
# global allow list plus f's allow list is empty or holds a rule that matches it. A call passes when
# every frame permits it.
#
# Functions, each answering by its status (and 2 when a query fails):
#   mcp_rule_valid <rule>                       0 valid, 1 invalid
#   mcp_match <rule> <name>                     0 match, 1 no match, 2 error (an invalid rule or name)
#   mcp_lists <rules-file>                      0 sets mcp_allow and mcp_deny (JSON arrays), 1 invalid
#   mcp_permits <name> <allow> <deny> <frames>  JSON arguments; 0 permitted, 1 refused (the refusal
#                                               in mcp_verdict), 3 an invalid tool name

mcp_nl='
'

# The jq definitions every query of the policy shares.
mcp_defs='
def mcp_rule_ok:
  type == "string" and test("\\A[A-Za-z0-9_.*-]{1,256}\\z") and (startswith("mcp__") or startswith("*"));
def mcp_name_ok:
  type == "string" and (explode | all(.[]; . >= 32 and . <= 126));
def mcp_list_ok:
  type == "array" and length <= 256 and all(.[]; mcp_rule_ok);
def mcp_hit($name):
  split("*") as $p
  | if ($p | length) == 1 then $name == .
    else
      $p[0] as $first | $p[-1] as $last
      | (($name | length) - ($last | length)) as $end
      | if $end < ($first | length) or ($name | startswith($first) | not) or ($name | endswith($last) | not)
        then false
        else
          reduce ($p[1:-1][] | select(length > 0)) as $m ($first | length;
            if . == null then null
            else ($name[. : $end] | index($m)) as $i | if $i == null then null else . + $i + ($m | length) end
            end)
          | . != null
        end
    end;
def mcp_first_hit($name):
  [.[] | select(mcp_hit($name))][0];
def mcp_frames_ok:
  type == "array" and length > 0
  and all(.[]; type == "object" and (.allow | mcp_list_ok) and (.deny | mcp_list_ok)
    and (.self == true or (.id | type == "string" and test("\\A[A-Za-z0-9_-]+\\z"))));
def mcp_verdict($name; $allow; $deny; $frames):
  if ($name | mcp_name_ok | not) then "badname"
  elif ($allow | mcp_list_ok | not) or ($deny | mcp_list_ok | not) or ($frames | mcp_frames_ok | not) then
    error("the rules handed to the evaluation are not valid lists")
  else
    ("deny FLEET_MCP_DENIED: " + ($name | tojson) + ": ") as $head
    | ($deny | mcp_first_hit($name)) as $global
    | [$frames[] | . as $f | (.deny | mcp_first_hit($name)) as $r | select($r != null) | {frame: $f, rule: $r}][0]
      as $denied
    | [$frames[] | select(($allow + .allow) as $a | ($a | length) > 0 and ($a | mcp_first_hit($name)) == null)][0]
      as $closed
    | if $global != null then $head + "the global rule " + ($global | tojson) + " denies it."
      elif $denied != null and $denied.frame.self == true then
        $head + "the deny rule " + ($denied.rule | tojson) + " of this agent'"'"'s brief matches it."
      elif $denied != null then
        $head + "the deny rule " + ($denied.rule | tojson) + " of the brief of agent " + $denied.frame.id
        + " above matches it."
      elif $closed != null and $closed.self == true then
        $head + "no allow rule matches it (global and this agent'"'"'s brief)."
      elif $closed != null then $head + "no allow rule of agent " + $closed.id + " above matches it."
      else "pass"
      end
  end;
'

# mcp_rule_valid <rule>
mcp_rule_valid() {
  mcp_out=$(jq -nr --arg rule "$1" "$mcp_defs"'$rule | mcp_rule_ok' 2>/dev/null) || return 2
  case $mcp_out in
    true) return 0 ;;
    false) return 1 ;;
  esac
  return 2
}

# mcp_match <rule> <name>
mcp_match() {
  mcp_out=$(jq -nr --arg rule "$1" --arg name "$2" "$mcp_defs"'
    if ($rule | mcp_rule_ok | not) or ($name | mcp_name_ok | not) then "error"
    elif ($rule | mcp_hit($name)) then "match"
    else "none"
    end' 2>/dev/null) || return 2
  case $mcp_out in
    match) return 0 ;;
    none) return 1 ;;
  esac
  return 2
}

# mcp_lists <rules-file>: the global lists, allowed_mcp_tools and disallowed_mcp_tools. A missing
# key or null reads as []; a list of another type, an entry that is not a valid rule or more than
# 256 rules make both lists invalid (status 1), never truncated.
mcp_lists() {
  mcp_allow=
  mcp_deny=
  mcp_out=$(jq -r "$mcp_defs"'
    [(.allowed_mcp_tools, .disallowed_mcp_tools) | if . == null then [] else . end]
    | if all(.[]; mcp_list_ok) then (.[] | tojson) else "invalid" end' "$1" 2>/dev/null) || return 2
  case $mcp_out in
    invalid) return 1 ;;
    \[*"$mcp_nl"\[*) ;;
    *) return 2 ;;
  esac
  mcp_allow=${mcp_out%%"$mcp_nl"*}
  mcp_deny=${mcp_out#*"$mcp_nl"}
  case $mcp_deny in
    *"$mcp_nl"*)
      mcp_allow=
      mcp_deny=
      return 2
      ;;
  esac
  return 0
}

# mcp_permits <name> <allow> <deny> <frames>: every argument is JSON text; the frames list holds
# the caller's own frame and those of the fleet agents above it.
mcp_permits() {
  mcp_verdict=
  mcp_out=$(jq -nr --argjson name "$1" --argjson allow "$2" --argjson deny "$3" --argjson frames "$4" \
    "$mcp_defs"'mcp_verdict($name; $allow; $deny; $frames)' 2>/dev/null) || return 2
  case $mcp_out in
    pass) return 0 ;;
    badname) return 3 ;;
    "deny FLEET_MCP_DENIED: "*)
      case $mcp_out in *"$mcp_nl"*) return 2 ;; esac
      mcp_verdict=${mcp_out#deny }
      return 1
      ;;
  esac
  return 2
}
