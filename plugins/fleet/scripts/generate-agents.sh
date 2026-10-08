#!/bin/sh
# Generates the fleet from models.json: replaces agents/*.md with one agent file per
# model and effort, and rewrites the benchmark reference the selection skill refers
# to: the table, the escalation ladder and the substitutions derived from it. Run it
# after editing models.json and commit the output; the plugin ships the generated
# files because agent definitions are read from disk, not built at runtime.
#
# With --rules, it narrows agents/ to the agents that rules file lets anyone reach and
# touches nothing else: the benchmark reference stays as shipped. It renders every agent
# as above, keeps the reachable ones, writes only a file that is missing or differs (each
# through a rename, so a reader never sees half a file), then deletes the rest, and
# prints one line per change: "added <name>", "updated <name>" or "removed <name>".
# Nothing printed means nothing changed. The rule readers are the guard's
# (fleet-rules.sh), so an agent is kept exactly when some call the guard allows can
# reach it.
#
# A run is all or nothing up to its install. It takes a lock (agents/.sync.lock), copies
# models.json (and the rules file) into a staging directory, checks the copies and reads
# nothing else, so a save in the middle of the run cannot mix two versions. It renders every
# agent and, without --rules, the reference into the staging directory; a failure up to there
# changes nothing. Only then does it install, still under the lock: every agent to keep that
# is missing or differs, then the deletions, then the reference through one rename. Runs from
# several sessions take turns. A lock whose holder has exited, or that is older than two
# minutes, is stale and is broken; a run refreshes the lock's age before it installs, and a
# run that lost its lock installs nothing. Temporary files an interrupted run left are removed.
#
# Exit status: 0 done; 1 an error (no jq, a rendering failure), nothing changed when it
# happens before the install; 3 invalid input, nothing changed: a rules file that is not
# exactly one JSON object (or null) or that has a section of the wrong type for a query the
# closure needs (an allowlist that is a string, a number or a list where a section belongs,
# for one), a models file that is missing or not of the shape
# models_valid describes, or models that render no agent; 64 usage; 75 another run held the
# lock for FLEET_SYNC_LOCK_WAIT seconds (default 20), or took it over, nothing changed.
#
# Usage: generate-agents.sh                    (from anywhere; paths resolve from the script)
#        generate-agents.sh --rules <file>

set -eu

usage() {
  echo 'usage: generate-agents.sh [--rules <rules-file>]' >&2
  exit 64
}
filter=
case $# in
  0) ;;
  # An empty path would read as no filter and widen agents/ to the full set.
  2) { [ "$1" = --rules ] && [ -n "$2" ]; } || usage; filter=$2 ;;
  *) usage ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
# The models file is read once, by the copy step under the lock; everything else reads $staged.
models=$root/models.json
template=$root/templates/agent.md
agents=$root/agents
reference=$root/skills/selecting-subagent-model/references/benchmark.md
refdir=$(dirname "$reference")
lock=$agents/.sync.lock

command -v jq >/dev/null 2>&1 || { echo "generate-agents.sh needs jq on PATH" >&2; exit 1; }

if [ -n "$filter" ]; then
  if [ ! -f "$root/scripts/fleet-rules.sh" ]; then
    echo "generate-agents.sh: $root/scripts/fleet-rules.sh is missing; agents/ left as it is" >&2
    exit 1
  fi
  plugin_root=$root
  data_dir=
  . "$root/scripts/fleet-rules.sh"
  # A rules query that fails (a section of the wrong type) marks the run, from a subshell too; the
  # run then stops before the install, where the guard would refuse every call that reads it. The
  # mark keeps the first failing query, the one the message names; later failures follow from it.
  fleet_unreadable() { [ -f "$out/unreadable" ] || printf '%s\n' "$1" > "$out/unreadable"; }
fi

# models_valid <file>: the shape the renderer and the reference need. One JSON object with a
# snapshot (benchmark and date strings) and a non-empty models array; each model with an id
# usable as a file name, a non-empty string name and an efforts object keyed by known rungs; per
# rung, index, usd and tps each a number or null, usd above zero (the reference divides by it),
# and usd_estimated a boolean when present; provisional a boolean when present. A models file
# that is empty, holds several documents or lists no models would render nothing and so delete
# every agent; invalid model input leaves agents/ and the reference as they are.
# The text reaches each agent's YAML frontmatter: the name and the snapshot strings go into the
# description, which render quotes, but no quoting carries a control character or line break as
# written, so those are refused. The id is written unquoted as name and model, so it starts with
# a letter and is not a word YAML reads as a boolean or null (yes, no, on, off, null, ...).
models_valid() {
  [ -f "$1" ] && [ "$(jq -s '
    def number_or_null: type == "number" or type == "null";
    def boolean_if_present($key): (has($key) | not) or (.[$key] | type == "boolean");
    def text: type == "string" and (test("[\\p{Cc}\\p{Zl}\\p{Zp}\\x{FFFE}\\x{FFFF}]") | not);
    length == 1 and (.[0] | type == "object"
      and (.snapshot | type == "object" and (.benchmark | text) and (.date | text))
      and (.models | type == "array" and length > 0 and all(.[];
        type == "object"
        and (.id | type == "string" and test("^[A-Za-z][A-Za-z0-9._-]*$")
          and (test("^(y|yes|n|no|true|false|on|off|null)$"; "i") | not))
        and (.name | text and length > 0)
        and boolean_if_present("provisional")
        and (.efforts | type == "object" and all(to_entries[];
          (.key | IN("low", "medium", "high", "xhigh", "max", "default"))
          and (.value | type == "object"
            and (.index | number_or_null) and (.usd | number_or_null) and (.tps | number_or_null)
            and (.usd == null or .usd > 0)
            and boolean_if_present("usd_estimated")))))))' "$1" 2>/dev/null)" = true ]
}

# One sentence per effort rung, the same for every model: what the rung is for.
guidance() {
  case $1 in
    low)     echo "Use for straightforward tasks of any size, where the steps are clear and there are no real decision points." ;;
    medium)  echo "Use for tasks of moderate complexity, with a few interacting parts and shallow decision points." ;;
    high)    echo "Use for tasks where interactions must be held in mind and easy-to-miss details noticed." ;;
    xhigh)   echo "Use for intricate tasks, where the reasoning is visibly tangled or a lower effort has already fallen short." ;;
    max)     echo "Use when xhigh was not enough; this is the model's reasoning ceiling." ;;
    default) echo "Reasoning effort is not adjustable on this model." ;;
    *)       echo "generate-agents.sh: unknown effort '$1' in models.json" >&2; exit 1 ;;
  esac
}

# render <name> <description> <model> <effort>: the template with its placeholders filled.
# An empty effort drops the effort line, so the agent inherits the session's effort. The
# description is free text (it holds the model name and the benchmark name) and goes in as a
# double-quoted scalar: a backslash and a double quote are escaped, and models_valid admits no
# character that would need more (control characters, line separators). That is also a JSON
# string, so YAML 1.1 and 1.2 readers parse it alike. The values reach awk through the
# environment, since -v would expand backslash escapes in them. Each placeholder is replaced
# left to right and the description last, so text holding a placeholder is not substituted again.
render() {
  FLEET_NAME=$1 FLEET_DESCRIPTION=$2 FLEET_MODEL=$3 FLEET_EFFORT=$4 awk '
    function repl(s, t, r,    out, i) {
      out = ""
      while ((i = index(s, t)) > 0) { out = out substr(s, 1, i - 1) r; s = substr(s, i + length(t)) }
      return out s
    }
    function quoted(s,    out, i, c) {
      out = ""
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "\\" || c == "\"") out = out "\\"
        out = out c
      }
      return "\"" out "\""
    }
    BEGIN {
      name = ENVIRON["FLEET_NAME"]; model = ENVIRON["FLEET_MODEL"]; effort = ENVIRON["FLEET_EFFORT"]
      description = quoted(ENVIRON["FLEET_DESCRIPTION"])
    }
    /^effort: \{\{EFFORT\}\}$/ { if (effort == "") next; print "effort: " effort; next }
    { print repl(repl(repl($0, "{{NAME}}", name), "{{MODEL}}", model), "{{DESCRIPTION}}", description) }
  ' "$template"
}

out=$(mktemp -d "${TMPDIR:-/tmp}/fleet-agents.XXXXXX")
mkdir "$out/agents"
staged=$out/models.json
staged_reference=$out/reference.md
reftmp=$refdir/.${reference##*/}.$$
locked=
cleanup() {
  rm -rf "$out"
  rm -f "$agents"/.*.md.$$ "$reftmp"
  if [ -n "$locked" ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$lock"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# stale_lock: the lock's holder has exited, or the lock is older than two minutes (a run takes
# about a second). A lock whose pid is not written yet is fresh.
stale_lock() {
  holder=$(cat "$lock/pid" 2>/dev/null) || holder=
  { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } ||
    [ -n "$(find "$lock" -prune -mmin +2 2>/dev/null)" ]
}

# take_lock: the lock on agents/, waited for up to FLEET_SYNC_LOCK_WAIT seconds. mkdir is atomic;
# the holder's pid inside tells a waiter whether the run that took it is still alive. Breaking a
# stale lock is itself serialized (.sync.lock.break) and re-checked, so two waiters cannot both
# break it and one of them remove the lock the other has just taken.
take_lock() {
  mkdir -p "$agents"
  case ${FLEET_SYNC_LOCK_WAIT:-20} in
    '' | *[!0-9]*) tries=100 ;;
    *) tries=$((${FLEET_SYNC_LOCK_WAIT:-20} * 5)) ;;
  esac
  breaks=0
  while ! mkdir "$lock" 2>/dev/null; do
    if [ "$breaks" -lt 5 ] && stale_lock && mkdir "$lock.break" 2>/dev/null; then
      if stale_lock; then rm -rf "$lock"; fi
      rmdir "$lock.break"
      breaks=$((breaks + 1))
      continue
    fi
    # A breaker that died between its two steps leaves .break behind.
    if [ -n "$(find "$lock.break" -prune -mmin +1 2>/dev/null)" ]; then rmdir "$lock.break" 2>/dev/null || true; fi
    [ "$tries" -gt 0 ] || return 1
    tries=$((tries - 1))
    sleep 0.2 2>/dev/null || sleep 1
  done
  locked=1
  echo "$$" > "$lock/pid"
}

if ! take_lock; then
  echo "generate-agents.sh: another run holds $lock; agents/ left as it is" >&2
  exit 75
fi

# Read models.json once, from a copy taken under the lock: every later step reads the copy, so a
# save in the middle of the run cannot mix two versions, and the copy is checked for the shape the
# renderer and the reference need before anything is rendered.
[ ! -f "$models" ] || cp "$models" "$staged"
if ! models_valid "$staged"; then
  echo "generate-agents.sh: models.json is missing or invalid: it must hold one JSON object with a snapshot and a non-empty models array whose figures are numbers or null; agents/ left as it is" >&2
  exit 3
fi

if [ -n "$filter" ]; then
  # The rules are read from a copy taken under the lock too. An editor saving the file can leave
  # it empty for a moment, and a half-written file does not parse; neither is a policy, so
  # neither may empty agents/.
  rules=$out/rules.json
  [ ! -f "$filter" ] || cp "$filter" "$rules"
  if ! fleet_rules_valid "$rules"; then
    echo "generate-agents.sh: rules file '$filter' is missing or invalid: it must hold exactly one JSON object, and an empty file, several documents or text that is not JSON is refused; agents/ left as it is" >&2
    exit 3
  fi
fi

snapshot=$(jq -r '.snapshot.benchmark + ", " + .snapshot.date' "$staged")

# A figure the benchmark has not published is null in models.json and "none" here. A model marked
# provisional has figures its source marks as preliminary (a re-run pending, a cost that does not
# yet include a pricing tier); the reason is in the benchmark run's evidence ledger. Fields are
# joined with a tab and not passed through @tsv, which would double a backslash in a name: the
# validation above admits no tab, line break or other control character in a name, and an id or a
# figure holds none either, so each line splits back into the fields as written.
jq -r '.models[] | .id as $id | .name as $name | (.provisional // false) as $provisional | .efforts | to_entries[]
       | [$id, $name, .key, (.value.index // "none"), (.value.usd // "none"), (.value.tps // "none"), (.value.usd_estimated // false), $provisional]
       | map(tostring) | join("\t")' \
  "$staged" > "$out/entries.tsv"
while IFS="$(printf '\t')" read -r id name effort index usd tps estimated provisional; do
  figures="Index $index"
  [ "$index" = none ] && figures="Index not published"
  # Costs under a dime keep up to four decimals so they do not collapse to $0.00; trailing zeros
  # beyond the second decimal are dropped ($0.0045, $0.02).
  cost="cost per task not published"
  [ "$usd" = none ] || cost=$(awk -v u="$usd" 'BEGIN { s = sprintf(u < 0.01 ? "%.4f" : u < 0.1 ? "%.3f" : "%.2f", u); while (s ~ /0$/ && length(s) - index(s, ".") > 2) sub(/0$/, "", s); printf "$%s per task", s }')
  [ "$estimated" = true ] && cost="$cost (estimated)"
  speed="$tps output tokens/s"
  [ "$tps" = none ] && speed="output speed not published"
  basis=$snapshot
  [ "$provisional" = true ] && basis="$snapshot, provisional"
  benchmark="Benchmark $basis; $figures, $cost, $speed."
  if [ "$effort" = default ]; then
    agent=$id
    lead="Executor subagent on $name."
    effort_value=""
  else
    agent=$id-$effort
    lead="Executor subagent on $name at $effort reasoning effort."
    effort_value=$effort
  fi
  description="$lead $(guidance "$effort") $benchmark Follows the prompt literally; does not invent scope."
  render "$agent" "$description" "$id" "$effort_value" > "$out/agents/$agent.md"
done < "$out/entries.tsv"

# Models that render no agent (every entry without efforts) would leave an empty set.
set -- "$out/agents"/*.md
if [ ! -f "$1" ]; then
  echo "generate-agents.sh: models.json renders no agent; agents/ left as it is" >&2
  exit 3
fi

if [ -z "$filter" ]; then
  names=$(for f in "$out/agents"/*.md; do basename "$f" .md; done | sort)
else
  # Every agent as "<name> <model> <effort>". When two entries yield one name, the file rendered
  # last is the one that exists, so its model and effort are the ones the guard reads.
  catalog=$(jq -r '
    reduce (.models[] | .id as $id | .efforts | keys_unsorted[]
      | {name: (if . == "default" then $id else "\($id)-\(.)" end), id: $id, effort: .}) as $a
      ({}; .[$a.name] = $a)
    | .[] | "\(.name) \(.id) \(.effort)"' "$staged")

  # The closure, read the way the guard reads the rules. From the main session: everything when
  # main.fleet is empty, else what it lists. From a reachable agent, keyed by its model: everything
  # when rules is empty; nothing when its model has no row; else what the row lists.
  main_open=
  nonempty .main.fleet || main_open=1
  spawn_open=
  nonempty .rules || spawn_open=1

  # allowed, reading each section's list for a model once rather than once per effort. A list
  # that cannot be read allows nothing, as the guard refuses every call that reads it.
  allows() {
    if [ "$1 $2" != "${listed_for:-}" ]; then
      listed_for="$1 $2"
      efforts "$1" "$2" || :
      listed=$fleet_lines
    fi
    case "
$listed
" in *"
$3
"*) return 0 ;; esac
    return 1
  }

  keep=$(printf '%s\n' "$catalog" | while read -r name id effort; do
    if [ -n "$main_open" ] || allows .main.fleet "$id" "$effort"; then echo "$name $id $effort"; fi
  done)
  expanded=' '
  while :; do
    callers=
    for caller in $(printf '%s\n' "$keep" | awk 'NF { print $2 }' | sort -u); do
      case $expanded in *" $caller "*) ;; *) callers="$callers $caller" ;; esac
    done
    [ -n "$callers" ] || break
    for caller in $callers; do
      expanded="$expanded$caller "
      if [ -z "$spawn_open" ]; then
        matrix ".rules[\"$caller\"]" || :
        [ -n "$fleet_lines" ] || continue
      fi
      found=$(printf '%s\n' "$catalog" | while read -r name id effort; do
        if [ -n "$spawn_open" ] || allows ".rules[\"$caller\"]" "$id" "$effort"; then echo "$name $id $effort"; fi
      done)
      keep=$(printf '%s\n%s\n' "$keep" "$found" | awk 'NF && !seen[$1]++')
    done
  done
  names=$(printf '%s\n' "$keep" | awk 'NF { print $1 }' | sort)

  # A query the closure needed failed: the set it computed is not the rules' answer, so nothing
  # changes. The guard refuses the calls that read the same section.
  if [ -f "$out/unreadable" ]; then
    echo "generate-agents.sh: rules file '$filter' could not be read: the query $(cat "$out/unreadable") failed, so a section has the wrong type; agents/ left as it is" >&2
    exit 3
  fi
fi

# Nothing changes unless every agent to keep was rendered.
for name in $names; do
  [ -f "$out/agents/$name.md" ] || { echo "generate-agents.sh: $name was not rendered; agents/ left as it is" >&2; exit 1; }
done

# The reference, rendered into the staging directory before agents/ is touched, so a failure here
# changes nothing; it is installed with one rename after the agents.
if [ -z "$filter" ]; then
  if ! jq -r '.snapshot as $s
  | "# \($s.benchmark), snapshot \($s.date)",
    "",
    "Historical routing priors, not live measurements. Index is higher-is-better; cost is USD per",
    "benchmark task; est. marks a cost the benchmark did not publish; (provisional) marks a model",
    "whose figures the source marks as preliminary, for example a re-run pending or a cost that does",
    "not yet include a pricing tier; the reason is in the benchmark run'\''s evidence ledger.",
    "Generated from models.json.",
    "",
    "| Model | Effort | Index | $ per task | Index per $ | Output tokens/s |",
    "|---|---|---:|---:|---:|---:|",
    (.models[] | "\(.name)\(if .provisional then " (provisional)" else "" end)" as $n | .efforts | to_entries[]
      | "| \($n) | \(if .key == "default" then "n/a" else .key end) | \(.value.index // "not published") | \(if .value.usd then "\(.value.usd)\(if .value.usd_estimated then " est." else "" end)" else "not published" end) | \(if .value.index and .value.usd then (.value.index / .value.usd * 10 | round) / 10 else "n/a" end) | \(.value.tps // "not published") |")
' "$staged" > "$staged_reference"; then
    echo "generate-agents.sh: rendering the benchmark table failed; agents/ and the reference left as they are" >&2
    exit 1
  fi

  # The ladder: every measured point, cheapest first (ties: higher Index first); a point joins when
  # its Index beats every cheaper point. A point off the ladder is substituted by the first ladder
  # step whose Index is at least as high, which by construction costs no more.
  if ! jq -r '
  [.models[] | .name as $n | .efforts | to_entries[]
    | select(.value.index != null and .value.usd != null)
    | {pair: (if .key == "default" then $n else "\($n) \(.key)" end), index: .value.index, usd: .value.usd}]
  | sort_by(.usd, -.index) as $points
  | (reduce $points[] as $p ([]; if length == 0 or $p.index > .[-1].index then . + [$p] else . end)) as $ladder
  | "",
    "## Escalation ladder",
    "",
    "Every measured point, cheapest first; a point is a step when its Index beats every cheaper point.",
    "A point off the ladder is dominated on this benchmark: some step reaches at least its Index for no",
    "more cost per task. The general Index is not task competence; the per-class table decides first.",
    "",
    "| Step | Model and effort | Index | $ per task |",
    "|---:|---|---:|---:|",
    ($ladder | to_entries[] | "| \(.key + 1) | \(.value.pair) | \(.value.index) | \(.value.usd) |"),
    "",
    "## Substitutions",
    "",
    "Each point off the ladder, with the cheapest step whose Index is at least as high.",
    "",
    "| Point | Index / $ per task | Substitute on this benchmark | Index / $ per task |",
    "|---|---|---|---|",
    ($points[] | . as $p | select(any($ladder[]; . == $p) | not)
      | ([$ladder[] | select(.index >= $p.index)][0]) as $s
      | "| \($p.pair) | \($p.index) / \($p.usd) | \($s.pair) | \($s.index) / \($s.usd) |")
' "$staged" >> "$staged_reference"; then
    echo "generate-agents.sh: rendering the escalation ladder failed; agents/ and the reference left as they are" >&2
    exit 1
  fi
fi

# Rendering is done. Refresh the lock's age first, so a slow run is not taken for stale while it
# installs, and then install nothing if the lock was broken and taken over before the refresh
# (-c: a lock already removed is not recreated as a file).
touch -c "$lock" 2>/dev/null || :
if [ "$(cat "$lock/pid" 2>/dev/null)" != "$$" ]; then
  echo "generate-agents.sh: lost $lock to another run; agents/ left as it is" >&2
  exit 75
fi

# Install the new set, still under the lock: first drop the temporary files an interrupted run
# left, then write every agent to keep that is missing or differs, and only then delete the
# agents outside the set. Change lines are printed in --rules mode only.
say() { [ -z "$filter" ] || echo "$1"; }
rm -f "$agents"/.*.md.*
for name in $names; do
  dst=$agents/$name.md
  if [ -f "$dst" ] && cmp -s "$out/agents/$name.md" "$dst"; then continue; fi
  verb=added
  [ -f "$dst" ] && verb=updated
  cp "$out/agents/$name.md" "$agents/.$name.md.$$"
  mv -f "$agents/.$name.md.$$" "$dst"
  say "$verb $name"
done
for dst in "$agents"/*.md; do
  [ -f "$dst" ] || continue
  name=$(basename "$dst" .md)
  printf '%s\n' "$names" | grep -qxF -- "$name" && continue
  rm -f "$dst"
  say "removed $name"
done
[ -z "$filter" ] || exit 0

# The reference last, through one rename in its own directory: a reader sees the old file or the
# new one, never part of one. Temporary copies an interrupted run left go first.
mkdir -p "$refdir"
rm -f "$refdir/.${reference##*/}".*
cp "$staged_reference" "$reftmp"
mv -f "$reftmp" "$reference"

echo "generated $(ls "$agents" | wc -l | tr -d ' ') agents in $agents and $reference"
