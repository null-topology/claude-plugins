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
#   mcp_permits <name> <allow> <deny> <frames>  JSON texts; 0 permitted, 1 refused (the refusal
#                                               in mcp_verdict), 3 an invalid tool name
#   mcp_block <brief>                           the per-spawn block of one brief (JSON text):
#                                               0 valid, 1 invalid (mcp_block_error)
#   mcp_block --record <transcript>             the same, of the brief an agent's transcript
#                                               opens with; also 3, no such brief
#   mcp_bind <payload>                          0 sets mcp_frames, the frames of a fleet agent's
#                                               call; 1 a refusal (mcp_fault), never 2

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
# A line read with a byte-order mark, blanks, tabs and carriage returns around it dropped: whether
# it reads ---, and whether it starts with allow: or deny:. Both patterns are anchored at the start
# of the line and do not trim it: a pattern for a trailing run is tried at every position of a long
# run of blanks inside a line, which takes time quadratic in the length of the line.
def mcp_block_fence:
  test("\\A[﻿ \t\r]*---[﻿ \t\r]*\\z");
def mcp_block_keyed:
  test("\\A[﻿ \t\r]*(allow|deny):");
def mcp_block_fault($n; $why):
  {error: ("MCP policy: line " + ($n | tostring) + ": " + $why + ".")};
def mcp_block_line:
  if endswith("\r") then .[:-1] else . end;
def mcp_block_read:
  (split("\n") | if length == 0 then [""] else . end) as $parts
  | ($parts | length) as $count
  | ($parts[:-1][:521] | map(mcp_block_line)) as $lines
  | {marked: ($count >= 2 and ($parts[0] | mcp_block_fence) and ($parts[1] | mcp_block_keyed))}
  + (if ($parts[0] | mcp_block_line) == "---" then
      reduce range(1; [$lines | length, 520] | min) as $i
        ({key: null, line: 0, count: 0, seen: {}, allow: [], deny: [], end: null};
        if .end != null then .
        else
          ($i + 1) as $n | $lines[$i] as $l
          | if $l == "allow:" or $l == "deny:" then
              ($l | rtrimstr(":")) as $k
              | if .key != null and .count == 0 then .end = mcp_block_fault(.line; "a key needs at least one rule")
                elif .seen[$k] then .end = mcp_block_fault($n; "duplicate key")
                else .key = $k | .line = $n | .count = 0 | .seen[$k] = true
                end
            elif $l == "---" then
              if .key == null then .end = mcp_block_fault($n; "expected allow or deny")
              elif .count == 0 then .end = mcp_block_fault(.line; "a key needs at least one rule")
              else .end = {allow: .allow, deny: .deny}
              end
            elif .key == null then .end = mcp_block_fault($n; "expected allow or deny")
            elif ($l[:1] | . == " " or . == "\t" or . == "-") or .count == 0 then
              ($l | if startswith("  - \"") and endswith("\"") then (.[4:] | try fromjson catch null) else null end)
                as $r
              | if ($r | type) != "string" then .end = mcp_block_fault($n; "expected a double-quoted rule")
                elif ($r | utf8bytelength) > 256 or .count == 256 then
                  .end = {error: "MCP policy: more than 256 rules, or a rule longer than 256 bytes."}
                elif ($r | mcp_rule_ok | not) then .end = mcp_block_fault($n; "invalid rule " + ($r | tojson))
                else .key as $k | .[$k] += [$r] | .count += 1
                end
            else .end = mcp_block_fault($n; "expected allow or deny")
            end
        end)
      | .end // mcp_block_fault(($lines | length) + 1; "missing closing ---")
    else
      (first(range(0; $count) as $i | select($parts[$i] | startswith("## ")) | $i) // $count) as $heading
      | (first(range(0; $heading) as $i
          | select(($parts[$i] | contains("---")) and ($parts[$i] | mcp_block_fence)
            and (($parts[$i + 1] // "") | mcp_block_keyed))
          | $i) // null) as $at
      | if $at == null then {none: true, allow: [], deny: []}
        else mcp_block_fault($at + 1; "the policy block must start at line 1")
        end
    end);
def mcp_block_text:
  mcp_block_read
  | (if .marked then "M" else "P" end)
    + (if .error then "E" + .error
       elif .none then "N"
       else "B" + ({allow, deny} | tojson)
       end);
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
#
# Each list comes from its own query, which checks both: splitting one list off the other in the
# shell takes time quadratic in its length in some shells (seconds at full size). The file is read
# twice, so it must not change in between; the guard passes its snapshot of the rules.
mcp_lists() {
  mcp_allow=
  mcp_deny=
  mcp_lists_pick "$1" 0 || return $?
  mcp_allow=$mcp_out
  mcp_lists_pick "$1" 1 || {
    mcp_status=$?
    mcp_allow=
    return $mcp_status
  }
  mcp_deny=$mcp_out
  return 0
}

# mcp_lists_pick <rules-file> <0 for the allow list, 1 for the deny list>
mcp_lists_pick() {
  mcp_out=$(jq -r --argjson pick "$2" "$mcp_defs"'
    [(.allowed_mcp_tools, .disallowed_mcp_tools) | if . == null then [] else . end]
    | if all(.[]; mcp_list_ok) then .[$pick] | tojson else "invalid" end' "$1" 2>/dev/null) || return 2
  case $mcp_out in
    invalid) return 1 ;;
    *"$mcp_nl"*) return 2 ;;
    \[*) return 0 ;;
  esac
  return 2
}

# mcp_permits <name> <allow> <deny> <frames>: every argument is JSON text; the frames list holds
# the caller's own frame and those of the fleet agents above it. The four texts reach jq on stdin,
# joined by U+0001, which JSON text cannot hold unescaped: at their largest (32 frames of two lists
# of 256 rules of 256 bytes) they are past the size a process argument may have.
mcp_permits() {
  mcp_verdict=
  mcp_out=$(printf '%s\001%s\001%s\001%s' "$1" "$2" "$3" "$4" | jq -Rrs "$mcp_defs"'
    split("\u0001") as $t
    | if ($t | length) != 4 then error("four JSON texts were expected") else . end
    | ($t[0] | fromjson) as $name | ($t[1] | fromjson) as $allow
    | ($t[2] | fromjson) as $deny | ($t[3] | fromjson) as $frames
    | mcp_verdict($name; $allow; $deny; $frames)' 2>/dev/null) || return 2
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

# mcp_block <brief>: the per-spawn block of one brief, the brief given as JSON text (a JSON
# string), so that neither hook has to carry it through a shell variable that drops NUL or
# trailing line breaks. Both hooks read a brief only through this function: the contract hook at
# the spawn, the guard at every call, so they cannot disagree on a brief.
# mcp_block --record <transcript>: the same, of the brief held by the first line of an agent's
# transcript, read up to that line and at most 1 MiB, in the query that parses the block (one
# process per agent the guard walks, and no copy of the brief through the shell).
#   status 3: the transcript could not be read, or its first line is longer than 1 MiB, or is not a
#             JSON object of type "user" whose message.content is one string
#   status 0: valid; mcp_block_found is 1 when the brief has a block, and mcp_block_lists holds
#             its lists as one JSON object {"allow": [...], "deny": [...]} ([] for a key left out,
#             and both [] without a block)
#   status 1: invalid; mcp_block_error holds the one-line reason (MCP policy: ...)
#   status 2: the brief could not be read (not one JSON string, or a failed query)
# mcp_block_marked is 1 when line 1 reads --- and line 2 starts with allow: or deny:, a byte-order
# mark, blanks and carriage returns around each dropped, whether the block is valid or not: the
# contract hook refuses such a brief for an agent that is not a fleet agent.
#
# A brief has a block when line 1 is exactly --- (a line ends at LF; a CR before it is part of
# the CRLF ending). The block then follows the grammar: allow: and deny:, each at most once, in
# either order, each followed by at least one item of exactly two spaces, "- " and one
# double-quoted JSON string; then a line that is exactly ---, itself ending in a line break.
# Nothing else is allowed inside. Otherwise a line before the first "## " heading that reads ---,
# followed by a line starting with allow: or deny: (both read with the characters above dropped),
# makes the brief invalid: that block would be ignored, and its deny with it. Otherwise the brief
# has no block. The block has at most 2 x 256 items, so its parse is over by line 516; only the
# first 520 lines are looked at for it.
#
# The query answers on one line: a letter for marked or not, a letter for the verdict, then the
# lists or the reason. The shell only strips those fixed-width letters: removing a pattern up to a
# line break far into a value takes time quadratic in its length in some shells (seconds for the
# 64 KiB of a full list), which the guard's time limit cannot afford.
mcp_block() {
  mcp_block_marked=
  mcp_block_found=
  mcp_block_lists='{"allow":[],"deny":[]}'
  mcp_block_error=
  if [ "$1" = --record ]; then
    # The status of a pipeline is its last command's: the reader appends four U+0001 only when it
    # read the file, and the query takes the text as read only when it ends in U+0001, so a reader
    # that fails, even after handing on the whole file, leaves no brief. A raw U+0001 cannot be part
    # of a JSON line, so the text read cannot supply it. Four, because a read that ends inside a
    # character makes jq take up to three bytes after its first into one replacement character.
    mcp_out=$({ dd if="$2" bs=1048577 count=1 2>/dev/null && printf '\001\001\001\001'; } | jq -Rrs "$mcp_defs"'
      if endswith("\u0001") | not then "S"
      else sub("\u0001{1,4}\\z"; "") | split("\n") as $parts
        | if ($parts | length) == 1 and utf8bytelength > 1048576 then "S"
          else $parts[0] | try fromjson catch null
            | if type == "object" and .type == "user" and (.message | type == "object")
                and (.message.content | type == "string")
              then .message.content | mcp_block_text
              else "S"
              end
          end
      end' 2>/dev/null) || return 2
    [ "$mcp_out" != S ] || return 3
  else
    mcp_out=$(printf '%s' "$1" | jq -rs "$mcp_defs"'
      if length == 1 and (.[0] | type == "string") then .[0] | mcp_block_text
      else error("one brief was expected")
      end' 2>/dev/null) || return 2
  fi
  case $mcp_out in
    *"$mcp_nl"*) return 2 ;;
    M?*) mcp_block_marked=1 ;;
    P?*) ;;
    *) return 2 ;;
  esac
  mcp_out=${mcp_out#?}
  case $mcp_out in
    N) return 0 ;;
    E?*)
      mcp_block_error=${mcp_out#?}
      return 1
      ;;
    B\{*)
      mcp_block_lists=${mcp_out#?}
      mcp_block_found=1
      return 0
      ;;
  esac
  return 2
}

# mcp_bind <payload>: the frames of a fleet agent's MCP call, found through the session's transcript
# files from the payload's transcript_path and agent_id alone. The caller of the call is the first
# frame; the walk follows parentAgentId through each agent's metadata until an agent has none, and
# adds a frame for every agent above whose type is a fleet agent's (one that fleet-rules.sh places,
# or one with this plugin's prefix, so an agent whose model left the rules keeps its frame). An
# agent of another type adds none, and its brief is not read. Needs fleet-rules.sh sourced, with
# the variables its fleet_agent reads (plugin_root, rules, fleet_rules_ok); it overwrites that
# library's globals (fleet_model among them). Nothing is cached or written.
#   status 0: mcp_frames holds the frames, the caller's first and then the fleet agents above it,
#             nearest first, as JSON text
#   status 1: mcp_fault holds the reason, one of the FLEET_MCP_ERROR texts of the policy
#
# Each agent's files sit side by side in one directory: agent-<id>.meta.json, its metadata, and
# agent-<id>.jsonl, its transcript, whose first line holds the brief. Every id and the path must be
# safe before a file name is built from them. A file read must be a regular file and not a symbolic
# link; the metadata is read whole up to 64 KiB, the transcript only up to its first line, at most
# 1 MiB.
mcp_bind() {
  mcp_frames=
  mcp_fault=
  mcp_parts=
  mcp_out=$(printf '%s' "$1" | jq -r '
    .agent_id as $id | .transcript_path as $path
    | if ($id | type == "string" and test("\\A[A-Za-z0-9_-]+\\z"))
        and ($path | type == "string" and startswith("/") and endswith(".jsonl")
          and (explode | all(.[]; . >= 32 and . != 127))
          and (split("/") | all(.[]; . != "." and . != "..")))
      then "O" + $id + " "
        + if ($path | test("/subagents/agent-[A-Za-z0-9_-]+\\.jsonl\\z")) then $path | sub("/[^/]*\\z"; "")
          else ($path | .[:-6]) + "/subagents"
          end
      else "B"
      end' 2>/dev/null) || {
    mcp_fault='the policy could not be evaluated'
    return 1
  }
  case $mcp_out in
    *"$mcp_nl"*)
      mcp_fault='the policy could not be evaluated'
      return 1
      ;;
    B)
      mcp_fault='invalid transcript binding'
      return 1
      ;;
    O?*' '/*) ;;
    *)
      mcp_fault='the policy could not be evaluated'
      return 1
      ;;
  esac
  mcp_out=${mcp_out#O}
  mcp_id=${mcp_out%% *}
  mcp_dir=${mcp_out#* }
  mcp_seen=' '
  mcp_count=0
  mcp_self=1
  mcp_known_type=
  mcp_known_kind=
  while :; do
    case $mcp_seen in
      *" $mcp_id "*)
        mcp_fault='agent ancestry unavailable'
        return 1
        ;;
    esac
    mcp_count=$((mcp_count + 1))
    if [ "$mcp_count" -gt 32 ]; then
      mcp_fault='agent ancestry unavailable'
      return 1
    fi
    mcp_seen="$mcp_seen$mcp_id "

    # The metadata: the agent's type and the agent above it.
    mcp_file=$mcp_dir/agent-$mcp_id.meta.json
    if [ ! -e "$mcp_file" ] && [ ! -L "$mcp_file" ]; then
      if [ -n "$mcp_self" ]; then mcp_fault='agent brief unavailable'; else mcp_fault='agent ancestry unavailable'; fi
      return 1
    fi
    mcp_size=
    if [ ! -L "$mcp_file" ] && [ -f "$mcp_file" ]; then
      mcp_size=$(wc -c 2>/dev/null <"$mcp_file") || mcp_size=
    fi
    case $mcp_size in
      *[0-9]*) [ "$((mcp_size))" -le 65536 ] || mcp_size= ;;
      *) mcp_size= ;;
    esac
    if [ -z "$mcp_size" ]; then
      mcp_fault='agent brief unavailable'
      return 1
    fi
    # One line, the verdict letter and the parent id, then the type and a closing dot, so that a
    # type ending in line breaks keeps them.
    mcp_out=$(jq -Rrs '
      try fromjson catch null
      | if type != "object" or (.parentAgentId | . == null or type == "string" | not) then "S"
        elif (.agentType | type) != "string" then "T"
        elif .parentAgentId != null and (.parentAgentId | test("\\A[A-Za-z0-9_-]+\\z") | not) then "U"
        else "P" + (.parentAgentId // "") + "\n" + .agentType + "."
        end' "$mcp_file" 2>/dev/null) || {
      mcp_fault='the policy could not be evaluated'
      return 1
    }
    case $mcp_out in
      S) mcp_fault='agent brief unavailable'; return 1 ;;
      T) mcp_fault='agent ancestry unavailable'; return 1 ;;
      U) mcp_fault='invalid transcript binding'; return 1 ;;
      P*"$mcp_nl"*.) ;;
      *) mcp_fault='the policy could not be evaluated'; return 1 ;;
    esac
    mcp_parent=${mcp_out%%"$mcp_nl"*}
    mcp_parent=${mcp_parent#P}
    mcp_type=${mcp_out#*"$mcp_nl"}
    mcp_type=${mcp_type%.}

    # Whether the agent is a fleet agent: one answer per type in a run, as most chains hold few.
    if [ -z "$mcp_known_kind" ] || [ "$mcp_type" != "$mcp_known_type" ]; then
      mcp_known_kind=0
      fleet_agent "$mcp_type" || mcp_known_kind=$?
      if [ "$mcp_known_kind" -eq 1 ]; then
        mcp_known_kind=0
        fleet_prefixed "$mcp_type" || mcp_known_kind=$?
      fi
      case $mcp_known_kind in
        0) mcp_known_kind=fleet ;;
        1) mcp_known_kind=other ;;
        *)
          mcp_known_kind=
          mcp_fault='the policy could not be evaluated'
          return 1
          ;;
      esac
      mcp_known_type=$mcp_type
    fi

    if [ "$mcp_known_kind" = fleet ]; then
      # The brief: the first line of the transcript, a user record whose content is one string.
      mcp_file=$mcp_dir/agent-$mcp_id.jsonl
      if [ -L "$mcp_file" ] || [ ! -f "$mcp_file" ]; then
        mcp_fault='agent brief unavailable'
        return 1
      fi
      mcp_status=0
      mcp_block --record "$mcp_file" || mcp_status=$?
      case $mcp_status in
        0) ;;
        1) mcp_fault='invalid agent brief'; return 1 ;;
        3) mcp_fault='agent brief unavailable'; return 1 ;;
        *) mcp_fault='the policy could not be evaluated'; return 1 ;;
      esac
      # Each frame goes to a variable of its own, named by the agent's place in the chain, and
      # the frames are joined once at the end: appending each to a growing text copies it again
      # for every frame (a second at full size in some shells). The eval'd text holds only names.
      if [ -n "$mcp_self" ]; then
        mcp_frame='{"self":true,'
      else
        mcp_frame='{"id":"'"$mcp_id"'",'
      fi
      eval "mcp_frame_$mcp_count=\$mcp_frame\${mcp_block_lists#?}"
      mcp_parts="$mcp_parts\${mcp_frame_$mcp_count},"
    elif [ -n "$mcp_self" ]; then
      # The metadata names another agent than the guard resolved from the payload.
      mcp_fault='invalid transcript binding'
      return 1
    fi

    [ -n "$mcp_parent" ] || break
    mcp_id=$mcp_parent
    mcp_self=
  done
  eval "mcp_frames=\"[${mcp_parts%,}]\""
  return 0
}
