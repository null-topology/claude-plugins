#!/bin/sh
# Validate the brief of an Agent call that targets a fleet agent, without
# changing tool input or permissions. Calls to any other agent type pass: the
# plugin governs only the agents it ships.
# Usage: sh delegation-contract.sh <plugin-root> < hook-payload.json
set -eu

plugin_root=${1:-}

error() {
    printf '%s\n' "FLEET_DELEGATION_ERROR: $1" >&2
    printf '%s\n' 'Report the hook/configuration problem; do not route around it.' >&2
    exit 2
}

invalid() {
    printf '%s\n' 'FLEET_DELEGATION_INVALID: delegation brief is incomplete or malformed.' >&2
    printf '%s\n' "$1" >&2
    printf '%s\n' \
        'Apply fleet:delegating-task in the parent session and correct the brief from known context.' \
        'Do not invent scope or permissions. Clarify a known blocker before dispatch.' \
        'Retry the intended call only after correction; any policy-guard refusal still applies.' >&2
    exit 2
}

for dependency in cat jq awk; do
    command -v "$dependency" >/dev/null 2>&1 || error "Required command is unavailable: $dependency."
done

payload=$(cat) || error 'Could not read hook input.'
if ! printf '%s' "$payload" | jq -e -s \
    'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1; then
    error 'Expected exactly one JSON object on stdin.'
fi

if ! printf '%s' "$payload" | jq -e \
    '.hook_event_name == "PreToolUse" and (.tool_name | type == "string" and length > 0)' \
    >/dev/null 2>&1; then
    error 'Expected a PreToolUse payload with a nonempty tool_name.'
fi

tool=$(printf '%s' "$payload" | jq -r '.tool_name') || error 'Could not read tool_name.'
[ "$tool" = Agent ] || exit 0

# A fleet type is one with a definition under agents/, the same test the guard uses.
[ -n "$plugin_root" ] && [ -d "$plugin_root/agents" ] ||
    error 'The plugin root, holding an agents directory, is required as the first argument.'
requested=$(printf '%s' "$payload" | jq -r '.tool_input.subagent_type? | strings') || requested=
bare=${requested##*:}
case $bare in '' | */*) exit 0 ;; esac
[ -f "$plugin_root/agents/$bare.md" ] || exit 0

# Shell variables cannot preserve NUL; reject it before decoding the prompt.
if ! printf '%s' "$payload" | jq -e '
    .tool_input | type == "object" and
    (.prompt | type == "string" and length > 0 and
        (explode | all(. >= 32 or . == 9 or . == 10 or . == 13)))
' >/dev/null 2>&1; then
    invalid 'tool_input.prompt must be a nonempty string without unsupported control characters.'
fi
prompt=$(printf '%s' "$payload" | jq -r '.tool_input.prompt') || error 'Could not decode prompt.'

# Parse a small Markdown subset: ATX headings, fences and HTML comments.
# No file paths or commands inside the brief are opened or executed.
if diagnostics=$(printf '%s\n' "$prompt" | LC_ALL=C awk '
    BEGIN {
        # The first "mandatory" sections must be present; the rest are optional.
        # Every known section must be unique and nonempty when present.
        mandatory = 5
        total = 8
        required[1] = "Objective"
        required[2] = "Context and Evidence"
        required[3] = "Scope Boundary"
        required[4] = "Acceptance Criteria"
        required[5] = "Return and Stop"
        required[6] = "Epistemic Boundary"
        required[7] = "Constraints"
        required[8] = "Additional Context"
        for (i = 1; i <= total; i++) known[required[i]] = i
    }
    function uncomment(s, out, p) {
        out = ""
        while (length(s)) {
            if (in_comment) {
                p = index(s, "-->")
                if (!p) return out
                s = substr(s, p + 3)
                in_comment = 0
            } else {
                p = index(s, "<!--")
                if (!p) return out s
                out = out substr(s, 1, p - 1)
                s = substr(s, p + 4)
                in_comment = 1
            }
        }
        return out
    }
    function run_length(s, c, n) {
        n = 0
        while (substr(s, n + 1, 1) == c) n++
        return n
    }
    function meaningful(s) {
        return s ~ /[^ \t\r]/ && s !~ /^[ \t]*[-*_][ \t*_-]*$/
    }
    function issue(s) {
        print s
        failed = 1
    }
    {
        line = $0
        sub(/\r$/, "", line)
        if (NR == 1) sub(/^\357\273\277/, "", line)
        trimmed = line
        sub(/^ ? ? ?/, "", trimmed)

        if (fence_char != "") {
            n = run_length(trimmed, fence_char)
            rest = substr(trimmed, n + 1)
            if (n >= fence_size && rest ~ /^[ \t]*$/) {
                fence_char = ""
                fence_size = 0
            } else if (current && meaningful(line)) {
                content[current] = 1
            }
            next
        }

        line = uncomment(line)
        trimmed = line
        sub(/^ ? ? ?/, "", trimmed)
        first = substr(trimmed, 1, 1)
        if (first == "`" || first == "~") {
            n = run_length(trimmed, first)
            if (n >= 3) {
                fence_char = first
                fence_size = n
                next
            }
        }

        if (trimmed ~ /^##([ \t]+|$)/) {
            heading = trimmed
            sub(/^##[ \t]*/, "", heading)
            sub(/[ \t]+#+[ \t]*$/, "", heading)
            sub(/[ \t]+$/, "", heading)
            current = known[heading]
            if (current) seen[current]++
            next
        }
        if (trimmed ~ /^#([ \t]+|$)/) {
            current = 0
            next
        }
        if (trimmed ~ /^#+([ \t]+|$)/) next
        if (current && meaningful(line)) content[current] = 1
    }
    END {
        for (i = 1; i <= total; i++) {
            if (!seen[i] && i <= mandatory) issue("Missing: " required[i] ".")
            if (seen[i] > 1) issue("Duplicate: " required[i] ".")
            if (seen[i] && !content[i]) issue("Empty: " required[i] ".")
        }
        if (fence_char != "") issue("Unclosed Markdown code fence.")
        if (in_comment) issue("Unclosed HTML comment.")
        if (failed) exit 1
    }
'); then
    # No explicit allow: all existing permission checks still run.
    exit 0
else
    code=$?
    [ "$code" -eq 1 ] || error 'Markdown validator failed.'
    invalid "$diagnostics"
fi
