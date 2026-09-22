#!/bin/sh
# Generates the fleet from models.json: deletes agents/*.md, writes one agent file
# per model and effort in its place, and rewrites the benchmark table the selection
# skill refers to. Run it after editing models.json and commit the output; the
# plugin ships the generated files because agent definitions are read from disk,
# not built at runtime.
#
# Usage: generate-agents.sh            (from anywhere; paths resolve from the script)

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
models=$root/models.json
template=$root/templates/agent.md
agents=$root/agents
reference=$root/skills/selecting-subagent-model/references/benchmark.md

command -v jq >/dev/null 2>&1 || { echo "generate-agents.sh needs jq on PATH" >&2; exit 1; }
jq empty "$models"

snapshot=$(jq -r '.snapshot.benchmark + ", " + .snapshot.date' "$models")

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
# An empty effort drops the effort line, so the agent inherits the session's effort.
render() {
  awk -v name="$1" -v description="$2" -v model="$3" -v effort="$4" '
    function repl(s, t, r,    i) {
      while ((i = index(s, t)) > 0) s = substr(s, 1, i - 1) r substr(s, i + length(t))
      return s
    }
    /^effort: \{\{EFFORT\}\}$/ { if (effort == "") next; print "effort: " effort; next }
    { print repl(repl(repl($0, "{{NAME}}", name), "{{DESCRIPTION}}", description), "{{MODEL}}", model) }
  ' "$template"
}

mkdir -p "$agents" "$(dirname "$reference")"
rm -f "$agents"/*.md

jq -r '.models[] | .id as $id | .name as $name | .efforts | to_entries[]
       | [$id, $name, .key, .value.index, .value.usd, (.value.tps // "none"), (.value.usd_estimated // false)] | @tsv' "$models" |
while IFS="$(printf '\t')" read -r id name effort index usd tps estimated; do
  # Sub-dime costs keep a third decimal so they do not collapse to $0.00.
  cost=$(awk -v u="$usd" 'BEGIN { s = sprintf(u < 0.1 ? "%.3f" : "%.2f", u); if (u < 0.1) sub(/0$/, "", s); printf "$%s per task", s }')
  [ "$estimated" = true ] && cost="$cost (estimated)"
  speed="$tps output tokens/s"
  [ "$tps" = none ] && speed="output speed not published"
  benchmark="Benchmark $snapshot; Index $index, $cost, $speed."
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
  render "$agent" "$description" "$id" "$effort_value" > "$agents/$agent.md"
done

jq -r '.snapshot as $s
  | "# \($s.benchmark), snapshot \($s.date)",
    "",
    "Historical routing priors, not live measurements. Index is higher-is-better; cost is USD per",
    "benchmark task; est. marks a cost the benchmark did not publish. Generated from models.json.",
    "",
    "| Model | Effort | Index | $ per task | Index per $ | Output tokens/s |",
    "|---|---|---:|---:|---:|---:|",
    (.models[] | .name as $n | .efforts | to_entries[]
      | "| \($n) | \(if .key == "default" then "n/a" else .key end) | \(.value.index) | \(.value.usd)\(if .value.usd_estimated then " est." else "" end) | \((.value.index / .value.usd * 10 | round) / 10) | \(.value.tps // "not published") |")
' "$models" > "$reference"

echo "generated $(ls "$agents" | wc -l | tr -d ' ') agents in $agents and $reference"
