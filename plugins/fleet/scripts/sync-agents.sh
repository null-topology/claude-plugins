#!/bin/sh
# Fleet agent sync: the plugin's SessionStart and FileChanged hook. Keeps agents/ to the agents
# the rules in force let anyone reach (generate-agents.sh --rules), so the session's agent list
# offers only what the guard can let through. A convenience: the guard stays the enforcement.
#
# Usage: sync-agents.sh <plugin-root> <data-dir>        (hook payload on stdin)
#
# SessionStart, any source: on "startup" it first seeds the rules file (seed-rules.sh); then it
# syncs and returns watchPaths, the rules files whose changes concern the fleet:
# <data-dir>/fleet.json, plus the shipped default while it is the file in force.
# FileChanged on one of those paths: syncs and returns the same list. Other paths are ignored.
#
# The session is told when the agent set differs from the one it was last told about: a
# systemMessage asks for /reload-plugins (agent definitions load at session start and a running
# session does not see a change until then), and on SessionStart the same text also goes to
# additionalContext. Per session, <data-dir>/sessions/<session_id> records the set (name and
# checksum per agent) the session was last told about, so every session watching the file hears
# of a change, not only the one whose run wrote it. A SessionStart from startup, resume or fork,
# and a clear (a new session id) with no record, compares with the set on disk before its sync
# instead, since that session has just loaded it. Every run of a session refreshes the age of its
# record, and SessionStart prunes the records of sessions inactive for thirty days. A FileChanged
# or compact run of a session that has no record is told once that its loaded set is unknown,
# and then gets one. Nothing changed: no message.
# Invalid input (see generate-agents.sh) leaves agents/ as it is and says so; a run that waited
# out another session's lock is skipped and says so.
#
# Not synced and not watched: FLEET_RULES is set (agents/ is shared by every session of the
# installed plugin; the guard applies FLEET_RULES to each call of this session); FLEET_SYNC_AGENTS=0;
# or the plugin root is a git work tree that tracks agents/ (a checkout loaded with --plugin-dir),
# unless FLEET_SYNC_AGENTS=1. A work tree that cannot be asked because git is not on PATH counts as
# tracking, and the session hears of it once in additionalContext.
# Always exits 0: a sync that fails must not get in the way of the session.

set -u

plugin_root=${1:?usage: sync-agents.sh <plugin-root> <data-dir>}
data_dir=${2:-}
here=$(dirname "$0")
payload=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  # Without jq the payload is matched as text. JSON may put any whitespace, line breaks included,
  # around a key's colon, so it is all removed first; a key is matched only after { or , so a
  # string value holding the same text (its quotes escaped) does not match.
  flat=$(printf '%s' "$payload" | tr -d ' \t\n\r')
  if printf '%s' "$flat" | grep -q '[{,]"source":"startup"'; then
    sh "$here/seed-rules.sh" "$plugin_root" "$data_dir" >/dev/null 2>&1 || true
  fi
  # Fixed text, so it needs no escaping; on SessionStart it also goes to the context, as every
  # SessionStart notice does.
  text='fleet: jq is not on PATH, so agents/ was not synced to the rules and the fleet guard refuses its checked calls. Install jq and start a new session.'
  if printf '%s' "$flat" | grep -q '[{,]"hook_event_name":"SessionStart"'; then
    printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}, "systemMessage": "%s"}\n' "$text" "$text"
  else
    printf '{"systemMessage": "%s"}\n' "$text"
  fi
  exit 0
fi

field() {
  printf '%s' "$payload" | jq -r "$1 // \"\"" 2>/dev/null || true
}

event=$(field .hook_event_name)
source=$(field .source)
changed=$(field .file_path)

context=
notice=
if [ "$event" = SessionStart ] && [ "$source" = startup ]; then
  if seeded=$(sh "$here/seed-rules.sh" "$plugin_root" "$data_dir" 2>&1); then
    context=$seeded
  else
    notice="fleet: seeding the rules file failed: $seeded"
  fi
fi

absolute() {
  case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac
}

# The path with its directory's symlinks resolved, so a watcher that reports the real path still
# matches the path that was registered.
resolved() {
  if d=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P); then
    printf '%s/%s\n' "$d" "$(basename "$1")"
  else
    printf '%s\n' "$1"
  fi
}

watched() {
  target=$(resolved "$1")
  printf '%s\n' "$watch" | (
    while IFS= read -r p; do
      if [ -n "$p" ] && { [ "$p" = "$1" ] || [ "$(resolved "$p")" = "$target" ]; }; then exit 0; fi
    done
    exit 1
  )
}

add_notice() {
  notice="${notice:+$notice
}$1"
}
add_context() {
  context="${context:+$context
}$1"
}

# Per-session state: only for a session id that is a plain file name.
sid=$(field .session_id)
state=
case $sid in
  '' | .* | *[!A-Za-z0-9._-]*) ;;
  *) [ -z "$data_dir" ] || state=$data_dir/sessions/$sid ;;
esac
# Records of sessions inactive for thirty days go on SessionStart. This session's own record and
# stamp stay: every run of this session refreshes their age (below), so it is its inactivity. A
# session whose record went anyway is told its loaded set is unknown (see the sync below).
own=${state##*/}
if [ "$event" = SessionStart ] && [ -n "$data_dir" ] && [ -d "$data_dir/sessions" ]; then
  find "$data_dir/sessions" -type f -mtime +30 ! -name "$own" ! -name "$own.nogit" -exec rm -f {} + 2>/dev/null || true
fi

sync=1
nogit=
rules=
watch=
if [ -n "${FLEET_RULES:-}" ]; then
  # agents/ is shared by every session of the installed plugin; one session's override must not
  # narrow it for the others.
  sync=
  add_context "fleet: FLEET_RULES is set ($FLEET_RULES), so agents/ is not narrowed to it: agents/ is shared by every session of this plugin version. The guard applies that file to every checked call, so a listed agent it does not allow is refused."
elif [ -f "$here/fleet-rules.sh" ]; then
  . "$here/fleet-rules.sh"
  rules=$(absolute "$(fleet_rules_path)")
  if [ -z "$data_dir" ]; then
    watch=$rules
  else
    watch=$(printf '%s\n%s\n' "$(absolute "$data_dir/fleet.json")" "$rules" | awk '!seen[$0]++')
  fi
else
  sync=
  add_notice "fleet: $here/fleet-rules.sh is missing, so agents/ was not synced and the fleet guard refuses everything. Reinstall the plugin."
fi

if [ "$event" = FileChanged ]; then
  [ -n "$changed" ] && watched "$changed" || exit 0
fi

# This session is active: refresh the age of its record and stamp (-c: none is created here), so
# pruning removes only the records of sessions inactive for thirty days.
[ -z "$state" ] || touch -c "$state" "$state.nogit" 2>/dev/null || true

case ${FLEET_SYNC_AGENTS:-} in
  0) sync= ;;
  1) ;;
  *)
    # A checkout that tracks agents/ is where the full set is generated and committed; filtering
    # it would show up as deleted files. Without git to ask, a .git above the root counts.
    dir=$(cd "$plugin_root" 2>/dev/null && pwd -P) || dir=
    while [ -n "$sync" ] && [ -n "$dir" ]; do
      if [ -e "$dir/.git" ]; then
        if ! command -v git >/dev/null 2>&1; then
          sync=
          nogit=1
        elif (cd "$plugin_root" && git ls-files --error-unmatch -- agents >/dev/null 2>&1); then
          sync=
        fi
        break
      fi
      [ "$dir" = / ] && break
      dir=$(dirname "$dir")
    done
    ;;
esac

if [ -n "$nogit" ] && [ "$event" = SessionStart ]; then
  if [ -z "$state" ] || [ ! -f "$state.nogit" ]; then
    add_context "fleet: agents/ was not synced to the rules: the plugin root is inside a git work tree and git is not on PATH, so the plugin cannot tell whether agents/ is tracked and leaves it as it is. Set FLEET_SYNC_AGENTS=1 to sync anyway, or FLEET_SYNC_AGENTS=0 to say it is meant."
    if [ -n "$state" ]; then
      mkdir -p "${state%/*}" 2>/dev/null && : > "$state.nogit" 2>/dev/null || true
    fi
  fi
fi

# listing: one "<name> <checksum>-<size>" line per agent file, sorted; the agent set as a session
# loads it.
listing() {
  (cd "$plugin_root/agents" 2>/dev/null && cksum -- *.md 2>/dev/null) |
    awk '{ n = $3; sub(/\.md$/, "", n); print n, $1 "-" $2 }' | LC_ALL=C sort
}

if [ -n "$sync" ]; then
  before=$(listing)
  report=$(sh "$here/generate-agents.sh" --rules "$rules" 2>&1)
  status=$?
  case $status in
    0) ;;
    3)
      reason=$(printf '%s\n' "$report" | tail -n 1 | sed 's/^generate-agents\.sh: //')
      case $reason in
        models.json*) add_notice "fleet: $reason. A fixed models.json is picked up at the next session start or rules change." ;;
        *) add_notice "fleet: $reason. The sync runs again when the rules file changes." ;;
      esac
      ;;
    75) add_notice "fleet: the agents/ sync was skipped, busy: another session's sync held the lock, so agents/ may not match the rules in force yet. It syncs again on the next rules change or session start." ;;
    *) add_notice "fleet: syncing agents/ to the rules failed, so it may not match them: $(printf '%s\n' "$report" | tail -n 1)" ;;
  esac
  if [ "$status" = 0 ] || [ "$status" = 3 ]; then
    after=$(listing)
    # The set this session holds: for a session that has just loaded agents/ (startup, resume,
    # fork), the set on disk before this run; otherwise the one it was last told about. A clear
    # starts a new session with a new session id, so it has a record only in the rare case one
    # exists under that id; without one it has just loaded agents/ and compares like a startup.
    # A rules change or a compaction (same session id) with no record (pruned, or never written)
    # cannot know what the session loaded: the set on disk may already be another session's sync,
    # so it is told once to reload, and the record written below makes the next comparison exact.
    # Without a session id there is no record to keep, and the set on disk before this run stands in.
    baseline=$before
    unknown=
    case $event:$source in
      FileChanged:* | SessionStart:compact)
        if [ -n "$state" ]; then
          if [ -f "$state" ]; then baseline=$(cat "$state"); else unknown=1; fi
        fi
        ;;
      SessionStart:clear)
        if [ -n "$state" ] && [ -f "$state" ]; then baseline=$(cat "$state"); fi
        ;;
    esac
    if [ -n "$unknown" ]; then
      add_notice "fleet: this session has no record of the agent set it loaded, so its agent list may not match agents/. Run /reload-plugins to bring it in line."
    elif [ "$baseline" != "$after" ]; then
      counts=$(printf '%s\n--\n%s\n' "$baseline" "$after" | awk '
        $0 == "--" { second = 1; next }
        !NF { next }
        !second { old[$1] = $2; next }
        { new[$1] = $2 }
        END {
          for (n in new) { if (!(n in old)) a++; else if (old[n] != new[n]) u++ }
          for (n in old) if (!(n in new)) r++
          printf "%d added, %d removed, %d updated", a, r, u
        }')
      # After an invalid rules file (status 3) agents/ was left as it is, so it holds what an
      # earlier run reached, not what the rules in force reach.
      if [ "$status" = 0 ]; then
        add_notice "fleet: agents/ now holds the agents the rules in force can reach ($counts). Run /reload-plugins to apply it to this session."
      else
        add_notice "fleet: agents/ differs from the set this session loaded ($counts). Run /reload-plugins to apply it to this session."
      fi
    fi
    if [ -n "$state" ] && { [ ! -f "$state" ] || [ "$(cat "$state")" != "$after" ]; }; then
      { mkdir -p "${state%/*}" && printf '%s\n' "$after" > "$state.$$" && mv -f "$state.$$" "$state"; } 2>/dev/null ||
        rm -f "$state.$$"
    fi
  fi
else
  watch=
fi

paths=$(printf '%s\n' "$watch" | jq -R . | jq -sc 'map(select(. != ""))')

if [ "$event" = SessionStart ]; then
  # The notice also goes to the context: the hooks reference does not say whether SessionStart
  # shows systemMessage, and with it there the assistant can pass it on.
  [ -z "$notice" ] || add_context "$notice"
  jq -n --arg context "$context" --arg notice "$notice" --argjson paths "$paths" '
    {hookSpecificOutput: ({hookEventName: "SessionStart"}
      + (if $context != "" then {additionalContext: $context} else {} end)
      + (if ($paths | length) > 0 then {watchPaths: $paths} else {} end))}
    + (if $notice != "" then {systemMessage: $notice} else {} end)'
elif [ "$event" = FileChanged ]; then
  jq -n --arg notice "$notice" --argjson paths "$paths" '
    (if ($paths | length) > 0 then {watchPaths: $paths} else {} end)
    + (if $notice != "" then {systemMessage: $notice} else {} end)'
fi
exit 0
