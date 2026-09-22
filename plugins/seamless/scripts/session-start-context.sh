#!/bin/sh
# SessionStart hook for the seamless plugin. POSIX sh: runs under dash, ash, bash and zsh.
#
# On "resume" and "compact" it says one sentence: load the save skill before working on. The
# resumed or compacted session has its context already; the sentence only makes sure the rules
# of the save skill get loaded, since a summary may have dropped them or the session may predate
# the plugin. Whatever the source, it records the session in onboarded/<session id> under the
# plugin data directory (content: the pid of the Claude Code process); the UserPromptSubmit hook
# uses the file to spot a session that never got any SessionStart from this plugin (installed
# while the session was running), and later starts use the pid to skip sessions still running.
#
# On a fresh session (source "startup" or "clear") it looks at the previous session's transcript
# in the current project's own directory under ~/.claude/projects/ and hands the new session a few
# facts: the startup directory, what the previous session was asked and what it last did, the
# handoff documents that exist for this project, the files edited most recently, and the standing
# rule to keep a living handoff so the user can /clear at any time.
#
# Which session is "the previous session" is resolved the same way on every source:
#   1. the chain: <plugin data>/chain/<old id>=<this id> exists when this session already consumed
#      its bridge once (a resume or a respawn keeps the session id, so the link is found again);
#   2. the bridge: <plugin data>/bridge/<key>=<old id>, left by the SessionEnd hook of the session
#      that /clear just closed in this same process (<key> identifies the process, see
#      session-end-mark.sh). It is turned into a chain entry and deleted;
#   3. neither: no predecessor on record. On "startup" and "clear" the hook then falls back to the
#      newest transcript in the project directory other than the current one, skipping sessions
#      recorded as still running in another process, and says that it guessed.
# The chain is the durable record: one empty file per transition, any depth by walking it.
#
# jq is optional. Without it the transcript cannot be parsed, so the previous session's prompt,
# message, edited files and handoffs are replaced by a note asking the user to install jq;
# everything that comes from the filesystem (previous session id, handoff directories, standing
# rule) still works.
#
# It reads only the current project's transcript directory (and, for a session id from the
# chain, that session's own transcript), so context from other projects never surfaces. It
# writes only under the plugin data directory: the chain entry, the pid of this session in
# onboarded/<session id>, and the removal of the bridge it consumed.
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
    jq -r --arg k "$1" 'if has($k) and .[$k] != null then (.[$k] | tostring) else "" end'
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

describe_handoff_dir() {
  # One line per handoff directory: newest file, its mtime, the file count and a date-mismatch
  # warning when the date in the filename and the mtime disagree by more than a day.
  dh_newest=$(ls -t "$1"/*.md 2>/dev/null | head -1)
  [ -n "$dh_newest" ] || return 0
  dh_count=$(ls "$1"/*.md 2>/dev/null | wc -l | tr -d ' ')
  dh_line="  $dh_newest (modified $(mtime_human "$dh_newest"); $dh_count file(s) in this directory)"
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

cache_status() {
  # One clause about the prompt cache, from the fields Claude Code adds to the hook input on
  # "resume" (2.1.25x and later): seconds_since_last_response, context_tokens,
  # prompt_cache_likely_expired, estimated_cache_write_usd. Prints nothing when they are missing.
  cs_expired=$(printf '%s' "$input" | json_str prompt_cache_likely_expired)
  case "$cs_expired" in true|false) ;; *) return 0 ;; esac
  cs_idle=$(printf '%s' "$input" | json_str seconds_since_last_response)
  cs_tokens=$(printf '%s' "$input" | json_str context_tokens)
  cs_usd=$(printf '%s' "$input" | json_str estimated_cache_write_usd)
  cs_idle=${cs_idle%%.*}
  cs_tokens=${cs_tokens%%.*}
  cs_when=""
  case "$cs_idle" in
    ''|*[!0-9]*) ;;
    *) if [ "$cs_idle" -ge 3600 ]; then
         cs_when="$(( cs_idle / 3600 ))h $(( (cs_idle % 3600) / 60 ))m"
       else
         cs_when="$(( cs_idle / 60 ))m"
       fi ;;
  esac
  cs_size=""
  case "$cs_tokens" in
    ''|*[!0-9]*) ;;
    *) if [ "$cs_tokens" -ge 1000 ]; then cs_size="$(( cs_tokens / 1000 ))k tokens"; else cs_size="$cs_tokens tokens"; fi ;;
  esac
  cs_cost=""
  case "$cs_usd" in
    ''|*[!0-9.]*|.|*.*.*) ;;
    *) cs_cost=$(awk -v v="$cs_usd" 'BEGIN { printf "about $%.2f", v }') ;;
  esac
  if [ "$cs_expired" = true ]; then
    printf 'prompt cache is COLD%s: the first request re-caches %s%s. /clear costs nothing and a fresh session resumes from the handoff.' \
      "${cs_when:+ after $cs_when idle}" "${cs_size:-the whole context}" "${cs_cost:+ ($cs_cost)}"
  else
    cs_detail="${cs_when:+idle $cs_when}"
    [ -n "$cs_size" ] && cs_detail="${cs_detail:+$cs_detail, }$cs_size cached"
    printf 'prompt cache still warm%s.' "${cs_detail:+ ($cs_detail)}"
  fi
}

bridge_key() {
  # The identity of the Claude Code process both hooks of a /clear run in. Same function in the
  # SessionEnd hook; the two must agree. Only the checksum of the token is ever used.
  if [ -n "${CLAUDE_CODE_MESSAGING_TOKEN:-}" ]; then
    printf 'tok-%s' "$(printf '%s' "$CLAUDE_CODE_MESSAGING_TOKEN" | cksum | cut -d' ' -f1)"
  elif [ -n "${CLAUDE_PID:-}" ]; then
    printf 'pid-%s' "$CLAUDE_PID"
  else
    printf 'pid-%s' "$PPID"
  fi
}

chain_prev() {
  # Predecessor of session $1 according to the chain, or nothing.
  for cp_f in "$data_dir/chain/"*"=$1"; do
    [ -e "$cp_f" ] || return 0
    cp_name=${cp_f##*/}
    printf '%s' "${cp_name%%=*}"
    return 0
  done
}

session_live() {
  # True when session $1 is recorded as running in a Claude Code process other than this one:
  # the SessionStart and UserPromptSubmit hooks write the pid into onboarded/<session id>, and
  # that pid still belongs to a live claude process. Sessions the plugin never saw are not live.
  sl_pid=$(head -1 "$data_dir/onboarded/$1" 2>/dev/null | tr -dc '0-9')
  [ -n "$sl_pid" ] || return 1
  [ "$sl_pid" = "${CLAUDE_PID:-$PPID}" ] && return 1
  kill -0 "$sl_pid" 2>/dev/null || return 1
  ps -o command= -p "$sl_pid" 2>/dev/null | grep -q claude
}

transcript_of() {
  # Transcript of session id $1: this project's directory first, any other project otherwise
  # (the chain does not care where a session started).
  if [ -f "$project_dir/$1.jsonl" ]; then
    printf '%s' "$project_dir/$1.jsonl"
    return 0
  fi
  for to_t in "$config_dir/projects"/*/"$1.jsonl"; do
    [ -f "$to_t" ] || continue
    printf '%s' "$to_t"
    return 0
  done
}

handoffs_edited() {
  # Handoff documents the transcript $1 wrote or edited, most recent first, still on disk.
  jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")
      | select(.name=="Write" or .name=="Edit" or .name=="MultiEdit")
      | .input.file_path // empty' "$1" 2>/dev/null \
    | grep -e '/handoffs/[^/]*\.md$' \
    | awk '{ a[NR] = $0 } END { for (i = NR; i > 0; i--) print a[i] }' \
    | awk '!seen[$0]++' \
    | while IFS= read -r he_p; do [ -f "$he_p" ] && printf '%s\n' "$he_p"; done
}

# --- input ---------------------------------------------------------------------------------------

source=$(printf '%s' "$input" | json_str source)
case "$source" in
  startup|clear|resume|compact) ;;
  *) exit 0 ;;
esac

transcript=$(printf '%s' "$input" | json_str transcript_path)
hook_cwd=$(printf '%s' "$input" | json_str cwd)
session_id=$(printf '%s' "$input" | json_str session_id)

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
case "$session_id" in
  */*|*=*|.*) session_id="" ;;
esac

# --- chain: which session this one continues ----------------------------------------------------

prev_id=""
prev_how=""
key=$(bridge_key)
if [ -n "$session_id" ]; then
  prev_id=$(chain_prev "$session_id")
  if [ -n "$prev_id" ]; then
    prev_how="the session this one continues from, on record"
  else
    # Several bridges under one key happen only when an earlier SessionStart hook died before
    # deleting its bridge; the newest is the right one.
    bridge=$(ls -t "$data_dir/bridge/$key="* 2>/dev/null | head -1)
    if [ -n "$bridge" ]; then
      bridge_name=${bridge##*/}
      old_id=${bridge_name#*=}
      if [ -n "$old_id" ] && [ "$old_id" != "$session_id" ]; then
        mkdir -p "$data_dir/chain" 2>/dev/null && : > "$data_dir/chain/$old_id=$session_id" 2>/dev/null
        prev_id="$old_id"
        prev_how="the session that was just cleared"
      fi
    fi
  fi
fi
# Whatever answered, a bridge under this process's key was left by this process and is spent.
rm -f "$data_dir/bridge/$key="* 2>/dev/null
# A bridge nobody consumed within an hour belongs to a process that died between /clear and the
# next start; its key can never match again.
find "$data_dir/bridge" -type f -mmin +60 -delete 2>/dev/null

# Handoff documents the predecessors kept, nearest session first, at most five, following the
# chain up to five steps. This is the list that names the document to read.
chain_handoffs=""
if [ "$have_jq" -eq 1 ] && [ -n "$prev_id" ]; then
  ch_cur="$prev_id"
  ch_depth=0
  while [ -n "$ch_cur" ] && [ "$ch_depth" -lt 5 ]; do
    ch_t=$(transcript_of "$ch_cur")
    [ -n "$ch_t" ] && chain_handoffs="$chain_handoffs
$(handoffs_edited "$ch_t")"
    ch_cur=$(chain_prev "$ch_cur")
    ch_depth=$(( ch_depth + 1 ))
  done
  chain_handoffs=$(printf '%s\n' "$chain_handoffs" | awk 'NF && !seen[$0]++' | head -5)
fi

# SEAMLESS_DEBUG=1 appends one line per hook run to <plugin data>/debug.log, for troubleshooting.
case "${SEAMLESS_DEBUG:-}" in
  1|true|yes) mkdir -p "$data_dir" 2>/dev/null && printf '%s SessionStart source=%s session_id=%s prev_id=%s bridge=%s transcript=%s cwd=%s cache_expired=%s idle_s=%s context_tokens=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$source" "$session_id" "${prev_id:-none}" "$key" "$transcript" "$hook_cwd" \
    "$(printf '%s' "$input" | json_str prompt_cache_likely_expired)" \
    "$(printf '%s' "$input" | json_str seconds_since_last_response)" \
    "$(printf '%s' "$input" | json_str context_tokens)" >> "$data_dir/debug.log" 2>/dev/null ;;
esac

# --- onboarding marker ---------------------------------------------------------------------------

emit() {
  # $1 = context for the model, $2 = status line for the user. Also records this session in
  # onboarded/<session id>: its presence tells the UserPromptSubmit hook that the session has heard
  # from the plugin, its content (the pid of the Claude Code process) lets a later start tell a
  # session that is still running from one that ended. Records older than a month are dropped so
  # the directory does not grow without bound; chain entries older than three months likewise.
  if [ "$have_jq" -eq 1 ]; then
    jq -n --arg ctx "$1" --arg msg "$2" \
      '{systemMessage: $msg, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
  else
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
      "$(printf '%s' "$2" | json_escape)" "$(printf '%s' "$1" | json_escape)"
  fi
  if [ -n "$session_id" ]; then
    mkdir -p "$data_dir/onboarded" 2>/dev/null \
      && printf '%s\n' "${CLAUDE_PID:-$PPID}" > "$data_dir/onboarded/$session_id" 2>/dev/null
  fi
  find "$data_dir/onboarded" -type f -mtime +30 -delete 2>/dev/null
  find "$data_dir/chain" -type f -mtime +90 -delete 2>/dev/null
}

if [ "$source" = "resume" ] || [ "$source" = "compact" ]; then
  msg="seamless: $source; the session is asked to load the save skill before working on."
  # On resume Claude Code also reports how stale the prompt cache is. Once it has gone cold the
  # first request re-sends the whole context, so the price of continuing is shown next to the
  # alternative this plugin exists for: /clear costs nothing when the handoff is in place.
  if [ "$source" = "resume" ]; then
    cache_note=$(cache_status)
    [ -n "$cache_note" ] && msg="seamless: resume; $cache_note The session is asked to load the save skill before working on."
  fi
  ctx="[seamless] seamless is installed: before any further work, invoke the seamless:save skill once to load its rules, and keep the handoff living."
  # A resumed session has its context back, but the handoff documents its predecessors kept are
  # the ones it should go on updating; a compacted session already knows them.
  if [ "$source" = "resume" ] && [ -n "$chain_handoffs" ]; then
    ctx="$ctx
Handoff documents kept by the session(s) this one continues from (nearest first):"
    while IFS= read -r p; do
      ctx="$ctx
  $p"
    done <<EOF_CHAIN
$chain_handoffs
EOF_CHAIN
  fi
  emit "$ctx" "$msg"
  exit 0
fi

# --- previous session ----------------------------------------------------------------------------

prev=""
skipped=0

if [ -n "$prev_id" ]; then
  prev=$(transcript_of "$prev_id")
elif [ -d "$project_dir" ]; then
  # No chain and no bridge: an older Claude Code, a hook that did not run, or a process that died
  # between /clear and this start. Take the newest other transcript in this project, skipping
  # sessions recorded as still running in another process: those are neighbours, not predecessors.
  prev_list=$(ls -t "$project_dir"/*.jsonl 2>/dev/null)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$f" = "$transcript" ] && continue
    if session_live "$(basename "$f" .jsonl)"; then
      skipped=$(( skipped + 1 ))
      continue
    fi
    prev="$f"
    break
  done <<EOF_PREV
$prev_list
EOF_PREV
  if [ "$source" = "clear" ]; then
    prev_how="the newest transcript in this project, presumably the session that was just cleared (no bridge was found for this process)"
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
  [ "$skipped" -gt 0 ] && prev_note="$prev_note; $skipped transcript(s) of sessions still running in parallel were skipped"
  ctx="$ctx
Previous session: $prev_id — $prev_how (last activity $prev_when$prev_note)"
elif [ -n "$prev_id" ]; then
  ctx="$ctx
Previous session: $prev_id — $prev_how; its transcript is no longer on disk, so nothing can be quoted from it."
else
  ctx="$ctx
Previous session: none found for this project.$([ "$skipped" -gt 0 ] && printf ' %s transcript(s) belong to sessions still running in parallel and were skipped.' "$skipped")"
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
  $p"
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

if [ -n "$chain_handoffs" ]; then
  ctx="$ctx
Handoff documents kept by the previous session(s) (nearest session first; the first one is the document to read):"
  while IFS= read -r p; do
    ctx="$ctx
  $p"
  done <<EOF_CHAIN
$chain_handoffs
EOF_CHAIN
fi

if [ -n "$(printf '%s' "$handoff_lines" | tr -d '[:space:]')" ]; then
  ctx="$ctx
Handoff documents (newest per directory, absolute paths):
$(printf '%s' "$handoff_lines")"
  if [ -n "$chain_handoffs" ]; then
    ctx="$ctx
Now: before asking the user what they were working on, read the first document listed under \"kept by the previous session(s)\" with the seamless:restore skill; other sessions may be running in this directory, so a newer file in the per-directory list is not necessarily this session's. Right after that, invoke the seamless:save skill once, even though there is nothing to write yet: that loads its rules (where the document lives, how it is named, when and what to write) into this session, which has not read them. Without that step the document gets edited by guesswork."
  else
    ctx="$ctx
Now: before asking the user what they were working on, read the newest handoff with the seamless:restore skill. If more than one directory is listed, ask the user which one applies instead of guessing. Right after that, invoke the seamless:save skill once, even though there is nothing to write yet: that loads its rules (where the document lives, how it is named, when and what to write) into this session, which has not read them. Without that step the document gets edited by guesswork."
  fi
else
  ctx="$ctx
Handoff documents: none found under the startup directory or its ancestors.
Now: if the user continues earlier work, use the lines above to form a hypothesis and confirm it with one precise question; once the scope is clear, create the handoff with the seamless:save skill."
fi

ctx="$ctx
Standing rule: the user relies on this plugin to /clear at any moment without losing the thread. Keep a living handoff document: as soon as a non-trivial task has a clear scope, invoke the seamless:save skill to create it, and update it after each finished block of work, decision or blocker — not after every command. Before a long unattended step, note how to resume it. Never create or edit a handoff document in a session that has not invoked the seamless:save skill: the skill holds the rules, and this block does not repeat them."

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

# SEAMLESS_VERBOSE=1 shows the user the whole block the model receives, for debugging. The UI
# truncates systemMessage at 4000 characters, so the standing rule at the end may be cut off.
case "${SEAMLESS_VERBOSE:-}" in
  1|true|yes) msg="$msg
$ctx" ;;
esac

emit "$ctx" "$msg"
