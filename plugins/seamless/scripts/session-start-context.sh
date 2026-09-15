#!/bin/sh
# SessionStart hook for the seamless plugin. POSIX sh: runs under dash, ash, bash and zsh.
#
# On a fresh session (source "startup" or "clear") it looks at the previous session's transcript
# in the current project's own directory under ~/.claude/projects/ and hands the new session a few
# facts: the startup directory, what the previous session was asked and what it last did, the
# handoff documents that exist for this project, the files edited most recently, and the standing
# rule to keep a living handoff so the user can /clear at any time.
#
# Which transcript is "the previous session":
#   - after /clear: the one the SessionEnd hook marked as cleared, if the marker is fresh; otherwise
#     the newest transcript in the project directory other than the current one;
#   - at startup: the newest transcript in the project directory other than the current one, which
#     is simply the last time Claude Code ran in this directory. A directory that has never had a
#     session yields no previous-session lines.
#
# jq is optional. Without it the transcript cannot be parsed, so the previous session's prompt,
# message and edited files are replaced by a note asking the user to install jq; everything that
# comes from the filesystem (previous session id, handoff documents, standing rule) still works.
#
# It reads only the current project's transcript directory, so context from other projects never
# surfaces. The only thing it writes is the removal of the marker it consumed.
#
# Usage: session-start-context.sh <plugin data dir>

set -u

input=$(cat)

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1

# --- helpers -------------------------------------------------------------------------------------

json_str() {
  # Top-level field "$1" of the JSON on stdin, as a string. Without jq a sed fallback that is good
  # enough for the flat hook input and the marker file (plain strings and numbers).
  if [ "$have_jq" -eq 1 ]; then
    jq -r --arg k "$1" '.[$k] // "" | tostring'
  else
    tr -d '\n' | sed -n "s/.*\"$1\":[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1
  fi
}

json_escape() {
  # stdin -> the body of a JSON string (no surrounding quotes). Used only when jq is missing.
  tab=$(printf '\t')
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" \
    | awk 'BEGIN { ORS = "" } { if (NR > 1) printf "\\n"; printf "%s", $0 }'
}

mtime_human() {
  # "YYYY-MM-DD HH:MM" for a file, on both BSD and GNU userlands.
  stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" 2>/dev/null || stat -c '%y' "$1" 2>/dev/null | cut -c1-16
}

mtime_epoch() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null
}

date_epoch() {
  # Epoch for a YYYY-MM-DD string, on both BSD and GNU userlands.
  date -j -f '%Y-%m-%d' "$1" '+%s' 2>/dev/null || date -d "$1" '+%s' 2>/dev/null
}

relative_to_start() {
  case "$1" in
    "$start_dir"/*) printf '%s' "${1#"$start_dir"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

describe_handoff_dir() {
  # One line per handoff directory: newest file, its mtime, the file count and a date-mismatch
  # warning when the date in the filename and the mtime disagree by more than a day.
  dh_newest=$(ls -t "$1"/*.md 2>/dev/null | head -1)
  [ -n "$dh_newest" ] || return 0
  dh_count=$(ls "$1"/*.md 2>/dev/null | wc -l | tr -d ' ')
  dh_line="  $(relative_to_start "$dh_newest") (modified $(mtime_human "$dh_newest"); $dh_count file(s) in this directory)"
  dh_date=$(basename "$dh_newest" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  if [ -n "$dh_date" ]; then
    dh_fepoch=$(date_epoch "$dh_date")
    dh_mepoch=$(mtime_epoch "$dh_newest")
    if [ -n "$dh_fepoch" ] && [ -n "$dh_mepoch" ]; then
      dh_diff=$(( dh_mepoch - dh_fepoch ))
      [ "$dh_diff" -lt 0 ] && dh_diff=$(( -dh_diff ))
      if [ "$dh_diff" -gt 172800 ]; then
        dh_line="$dh_line — filename date $dh_date and mtime disagree; mtime may have been reset by git or rsync"
      fi
    fi
  fi
  printf '%s\n' "$dh_line"
}

# --- input ---------------------------------------------------------------------------------------

source=$(printf '%s' "$input" | json_str source)
case "$source" in
  startup|clear) ;;
  *) exit 0 ;;
esac

transcript=$(printf '%s' "$input" | json_str transcript_path)
hook_cwd=$(printf '%s' "$input" | json_str cwd)

start_dir="${CLAUDE_PROJECT_DIR:-$hook_cwd}"
[ -n "$start_dir" ] || start_dir="$PWD"

config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ -n "$transcript" ]; then
  project_dir=$(dirname "$transcript")
else
  project_dir="$config_dir/projects/$(printf '%s' "$start_dir" | sed 's#[/._]#-#g')"
fi

data_dir="${1:-}"
case "$data_dir" in
  ""|*'${CLAUDE_PLUGIN_DATA}'*) data_dir="$config_dir/plugins/data/seamless" ;;
esac
marker="$data_dir/cleared/$(basename "$project_dir").json"

# --- previous session ----------------------------------------------------------------------------

prev=""
prev_how=""

# After /clear, prefer the transcript the SessionEnd hook marked as cleared, if the marker is
# recent (a stale marker would belong to an earlier clear whose successor never started).
if [ "$source" = "clear" ] && [ -f "$marker" ]; then
  marked=$(json_str transcript_path < "$marker")
  marked_at=$(json_str cleared_at < "$marker")
  now=$(date +%s)
  if [ -n "$marked" ] && [ -f "$marked" ] && [ "$marked" != "$transcript" ] \
     && [ $(( now - ${marked_at:-0} )) -lt 600 ]; then
    prev="$marked"
    prev_how="the session that was just cleared"
  fi
  rm -f "$marker" 2>/dev/null
fi

if [ -z "$prev" ] && [ -d "$project_dir" ]; then
  prev_list=$(ls -t "$project_dir"/*.jsonl 2>/dev/null)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$f" = "$transcript" ] && continue
    prev="$f"
    break
  done <<EOF_PREV
$prev_list
EOF_PREV
  if [ "$source" = "clear" ]; then
    prev_how="the newest transcript in this project, presumably the session that was just cleared"
  else
    prev_how="the last time Claude Code ran in this directory"
  fi
fi

# --- handoff directories: startup dir, ancestors below $HOME, descendants --------------------------

handoff_dirs=""
[ -d "$start_dir/.claude/handoffs" ] && handoff_dirs="$start_dir/.claude/handoffs"

parent=$(dirname "$start_dir")
while [ "$parent" != "/" ] && [ "$parent" != "$HOME" ] && [ "$parent" != "$(dirname "$parent")" ]; do
  [ -d "$parent/.claude/handoffs" ] && handoff_dirs="$handoff_dirs
$parent/.claude/handoffs"
  parent=$(dirname "$parent")
done

found_dirs=$(find "$start_dir" -maxdepth 7 \
  \( -name .git -o -name node_modules -o -name worktrees -o -name .terraform -o -name vendor \) -prune \
  -o -type d -path '*/.claude/handoffs' -print 2>/dev/null | sort)
while IFS= read -r d; do
  [ -n "$d" ] || continue
  [ "$d" = "$start_dir/.claude/handoffs" ] && continue
  handoff_dirs="$handoff_dirs
$d"
done <<EOF_FOUND
$found_dirs
EOF_FOUND

# --- assemble ------------------------------------------------------------------------------------

if [ "$source" = "clear" ]; then
  ctx="[seamless] This session replaces one the user just cleared. Context recovered:"
else
  ctx="[seamless] Context recovered for this project at session start:"
fi
ctx="$ctx
Startup directory: $start_dir"

if [ -n "$prev" ]; then
  prev_id=$(basename "$prev" .jsonl)
  prev_when=$(mtime_human "$prev")
  prev_note=""
  if [ "$source" = "startup" ]; then
    if [ -n "$(find "$prev" -mmin -1 2>/dev/null)" ]; then
      prev_note="; written less than a minute ago, so it may be a session still running in parallel"
    elif [ -z "$(find "$prev" -mtime -1 2>/dev/null)" ]; then
      prev_note="; more than a day old, so it may be unrelated to what the user wants now"
    fi
  fi
  ctx="$ctx
Previous session: $prev_id — $prev_how (last activity $prev_when$prev_note)"
else
  ctx="$ctx
Previous session: none found for this project."
fi

if [ -n "$prev" ] && [ "$have_jq" -eq 1 ]; then
  # The user's last prompt is the last "user" entry carrying prompt text. Slash commands are
  # recorded as user entries too (content starts with "<command-name>"), and tool results are
  # user entries whose content is an array of tool_result blocks; both are skipped. The
  # "last-prompt" entry is only a fallback: it is written when a turn ends, so a /clear issued
  # while a turn is still running leaves it one prompt behind.
  last_prompt=$(jq -c 'select(.type=="user" and (.isMeta // false | not))
      | .message.content
      | if type == "string" then .
        elif type == "array" then ([.[] | select(.type == "text") | .text] | join(" "))
        else "" end
      | select(length > 0)
      | select(startswith("<command-name>") | not)
      | select(startswith("<local-command") | not)' "$prev" 2>/dev/null | tail -1)
  if [ -z "$last_prompt" ]; then
    last_prompt=$(jq -c 'select(.type=="last-prompt") | .lastPrompt' "$prev" 2>/dev/null | tail -1)
  fi
  last_prompt=$(printf '%s' "$last_prompt" \
    | jq -r 'gsub("\\s+"; " ") | if length > 300 then .[0:300] + "…" else . end' 2>/dev/null)
  if [ -n "$last_prompt" ]; then
    ctx="$ctx
Last prompt of the previous session: $last_prompt"
  fi

  # What the agent last did. If its last message ended the turn (stop_reason "end_turn"), that
  # message is the closing summary and is quoted whole. Otherwise the session was cleared while a
  # turn was still running: an older summary would misdescribe the state, so instead the last few
  # actions (tool calls and messages, oldest first, with times) are listed, so the new session can
  # work out how far the previous one got after the handoff was last updated.
  last_stop=$(jq -r 'select(.type=="assistant") | .message.stop_reason // "unknown"' "$prev" 2>/dev/null | tail -1)
  if [ "$last_stop" = "end_turn" ]; then
    last_message=$(jq -c 'select(.type=="assistant" and .message.stop_reason=="end_turn")
        | [.message.content[]? | select(.type=="text") | .text] | join("\n") | select(length > 0)' "$prev" 2>/dev/null \
      | tail -1 | jq -r 'if length > 1500 then .[0:1500] + " […cut]" else . end' 2>/dev/null)
    if [ -n "$last_message" ]; then
      ctx="$ctx
Last message of the previous session (its turn was completed):
$last_message"
    fi
  elif [ -n "$last_stop" ]; then
    actions=$(jq -r 'select(.type=="assistant") | .timestamp as $t | .message.content[]?
        | select(.type=="text" or .type=="tool_use")
        | ($t | if . then ((sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | localtime | strftime("%H:%M")) + " ") else "" end) as $when
        | if .type == "text" then
            (.text | gsub("\\s+"; " ") | select(length > 0)
             | $when + "said: \"" + (if length > 300 then .[0:300] + "…" else . end) + "\"")
          else
            (.name as $n | .input as $i
             | ($i.description // $i.file_path // $i.notebook_path // $i.skill // $i.pattern // $i.command // $i.prompt // $i.url
                // ($i | tojson)) | tostring | gsub("\\s+"; " ")
             | $when + "called " + $n + ": " + (if length > 160 then .[0:160] + "…" else . end))
          end' "$prev" 2>/dev/null | tail -3)
    if [ -n "$actions" ]; then
      ctx="$ctx
The previous session was cleared while a turn was still running, so there is no closing summary. Its last actions before that (oldest first):"
      while IFS= read -r a; do
        ctx="$ctx
  $a"
      done <<EOF_ACTIONS
$actions
EOF_ACTIONS
    fi
  fi

  tmp_prefix="${TMPDIR:-/tmp}"
  edited=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
      | select(.name=="Write" or .name=="Edit" or .name=="MultiEdit" or .name=="NotebookEdit")
      | .input.file_path // .input.notebook_path // empty' "$prev" 2>/dev/null \
    | grep -v -e '^/private/tmp/' -e '^/tmp/' -e "^$tmp_prefix" \
    | awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' \
    | awk '!seen[$0]++' | head -5)
  if [ -n "$edited" ]; then
    ctx="$ctx
Recently edited in the previous session (most recent first):"
    while IFS= read -r p; do
      ctx="$ctx
  $(relative_to_start "$p")"
    done <<EOF_EDITED
$edited
EOF_EDITED
  fi
elif [ -n "$prev" ]; then
  ctx="$ctx
Details of that session (its last prompt, its last message or actions, the files it edited) are unavailable: jq is not installed on this machine, and the transcript cannot be read without it. Everything else about this plugin works. Tell the user once, at the start of your first reply: seamless is working, but installing jq (for example \"brew install jq\" or \"apt install jq\"; see https://jqlang.github.io/jq/) would also let it show what the previous session was doing."
fi

handoff_lines=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  handoff_lines="$handoff_lines$(describe_handoff_dir "$d")
"
done <<EOF_DIRS
$handoff_dirs
EOF_DIRS

if [ -n "$(printf '%s' "$handoff_lines" | tr -d '[:space:]')" ]; then
  ctx="$ctx
Handoff documents (newest per directory):
$(printf '%s' "$handoff_lines")
Now: before asking the user what they were working on, read the newest handoff with the seamless:restore skill. If more than one directory is listed, ask the user which one applies instead of guessing."
else
  ctx="$ctx
Handoff documents: none found under the startup directory or its ancestors.
Now: if the user continues earlier work, use the lines above to form a hypothesis and confirm it with one precise question; once the scope is clear, create the handoff with the seamless:save skill."
fi

ctx="$ctx
Standing rule: the user relies on this plugin to /clear at any moment without losing the thread. Keep a living handoff document: as soon as a non-trivial task has a clear scope, invoke the seamless:save skill to create it, and update it after each finished block of work, decision or blocker — not after every command. Before a long unattended step, note how to resume it."

# One visible line for the user (additionalContext goes to the model only), so it is obvious that
# the mechanism fired and that the session is waiting for a message. systemMessage is a top-level
# field of the hook output, not part of hookSpecificOutput; Claude Code ignores it elsewhere.
handoff_count=$(printf '%s' "$handoff_lines" | grep -c '^  ' 2>/dev/null | tr -d ' ')
if [ -n "$prev" ]; then
  prev_summary="previous session found"
else
  prev_summary="no previous session"
fi
if [ "${handoff_count:-0}" -gt 0 ]; then
  if [ "$handoff_count" -eq 1 ]; then dirs_word="directory"; else dirs_word="directories"; fi
  msg="seamless: $prev_summary, $handoff_count handoff $dirs_word listed. Send any message to resume."
else
  msg="seamless: $prev_summary, no handoff documents. Send any message to continue."
fi
if [ "$have_jq" -eq 0 ]; then
  msg="$msg jq is not installed: previous-session details unavailable (brew install jq / apt install jq)."
fi

if [ "$have_jq" -eq 1 ]; then
  jq -n --arg ctx "$ctx" --arg msg "$msg" \
    '{systemMessage: $msg, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
else
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(printf '%s' "$msg" | json_escape)" "$(printf '%s' "$ctx" | json_escape)"
fi
