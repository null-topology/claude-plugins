# fleet

A fleet of executor subagents, one per model and reasoning effort, plus the guard that keeps them
inside a policy written in one place.

## What it ships

- `agents/<model>-<effort>.md` — the fleet, generated from `models.json`. Each file fixes a model
  and, where the model supports effort control, an effort in its frontmatter; no hooks, no rules —
  those live elsewhere. The repository ships every agent; an installed copy keeps only the ones
  your rules can reach (see [Registered agents](#registered-agents)).
- `models.json` — the models the plugin knows: id, name, vendor, the effort rungs each one
  supports, and a dated benchmark snapshot per rung (`null` where a figure is not published,
  `"provisional": true` on a model whose figures the source marks as preliminary, for example a
  re-run pending or a cost that does not yet include a pricing tier; the reason is in the
  benchmark run's evidence ledger).
  The single place to edit when a model or a provider appears.
- `scripts/generate-agents.sh` — regenerates `agents/*.md` from `models.json`, then rewrites the
  benchmark reference under `skills/selecting-subagent-model/references/`: the table, the
  escalation ladder and the substitutions derived from it. Its output is committed; the plugin
  ships files, not a build step. With `--rules <file>` it only narrows `agents/` to what that
  rules file reaches and leaves the reference alone. A run is all or nothing up to its install:
  under a lock it reads one copy of `models.json` (and of the rules file), checks that copy's
  shape, and renders every agent and the reference into a staging directory before it touches
  anything. A models file that is not one JSON object with a snapshot and a non-empty `models`
  array, a figure (`index`, `usd`, `tps`) that is not a number or null, a `usd` of zero, a
  `provisional` or `usd_estimated` that is not a boolean, an unknown effort rung, an empty name,
  a name or snapshot string holding a control character or line break, a model id that does not
  start with a letter or that YAML would read as a boolean (`yes`, `off`, `null`, ...), or models
  that render no agent change nothing (exit 3); so does a failure while rendering (exit 1). The
  reference is installed last, with one rename, after the agents. Each agent's `description` is
  written as a double-quoted YAML string, so a name such as `Fable: 5.1`, `# one` or `*star`
  parses as written. Per the Claude Code subagents documentation, a plugin subagent whose
  frontmatter does not parse still loads, under its file name; the check it names for frontmatter
  that does not parse is `claude plugin validate <dir>` (Claude Code v2.1.233 or later).
- `fleet.default.json` — the default rules. On the first session start the plugin copies it to
  `~/.claude/plugins/data/fleet-<marketplace>/fleet.json` and reads it from there; that copy is
  yours to edit and plugin updates never touch it.
- `scripts/subagent-guard.sh` — the guard, a `PreToolUse` hook on `Agent|Bash|Skill|Workflow`
  declared once in the plugin's `hooks.json`. It tells the caller from the hook payload: a fleet
  `agent_type` resolves to its definition or, when that file is gone, to its name in
  `models.json`, and its model is the row the rules are keyed by; a type with the plugin's
  prefix that resolves to neither is refused. Otherwise an empty `agent_id` means the main
  session (which may still carry an `agent_type` when the session runs as
  `claude --agent <name>`); anything else is a built-in subagent and passes. The same script is
  the `SubagentStart` hook that hands a starting fleet agent its denylists. Needs `jq`.
- `scripts/fleet-rules.sh` — the rule readers, the rules-file validity test and the agent-type
  resolution, sourced by the guard, the generator's `--rules` mode, the sync and the brief check,
  so all of them read the rules and tell a fleet agent the same way.
- `scripts/sync-agents.sh` — the `SessionStart` and `FileChanged` hook that seeds the rules file
  on startup, keeps `agents/` to what the rules reach, watches the rules file and tells each
  session when its agent list is out of date.
- `scripts/seed-rules.sh` — the one-time copy of the default rules, run by the sync on startup.
- `skills/selecting-subagent-model` — how to pick a model and effort for a task: the user's
  standing overrides first, then `references/task-routing.md` (the model family per class of
  work and task complexity, from independent benchmarks); `references/vendor-guide.md` there
  covers choosing between vendors and briefing each.
- `skills/delegating-task` — how to write the prompt for the agent that was picked, with worked
  examples under `examples/`.
- `scripts/delegation-contract.sh` — a second `PreToolUse` hook, on `Agent` only, that checks the
  shape of that prompt when the call targets a fleet agent. Needs `jq` and `awk`.
- `tests/delegation/` — fixture tests for the hook alone and next to the guard and the generator.
- `tests/sync/` — fixture tests for the sync, with the guard as the oracle for reachability.

## Why one file per model and effort

A subagent's model can come from three places, in this order: the `model` parameter of the Agent
tool call, the `model:` key of the agent's frontmatter, or the process-wide
`CLAUDE_CODE_SUBAGENT_MODEL` variable. Only the frontmatter takes an arbitrary model id:

- the call-time `model` is a closed enum, `sonnet | opus | haiku | fable`. Nothing extends it,
  not an agent definition, not a model picker entry, and a `PreToolUse` hook that rewrites the
  call's input is checked against the same enum and rejected;
- the environment variable applies to every subagent of the process at once and is read at
  start-up, so it cannot pick a model per call;
- effort has no call-time parameter at all. It is frontmatter-only and otherwise inherited from
  the session.

So a model outside that enum, at a chosen effort, is reachable in exactly one way: an agent
definition that names both. That is what the fleet is. The files are dull on purpose: four
frontmatter keys and a shared body. `models.json` holds what varies, the generator holds what
does not, and adding a provider is one entry plus one run of the generator, not a batch of
hand-written definitions.

The guard is not in the agent files either, and not by choice: `hooks:` in the frontmatter of
an agent shipped by a plugin is ignored (the loader says so at startup). The plugin's own
`hooks.json` hooks do run inside subagents, and the payload there names the agent type, which is
all the guard needs.

A model with no effort control (Haiku 4.5) gets one file, `agents/<model>.md`, without an effort
key. The rules refer to its single rung as `default`.

### Adding a model

1. Add it to `models.json` with the rungs it supports and the benchmark figures you have.
2. Run `sh scripts/generate-agents.sh` and review the diff under `agents/` and `references/`.
3. Add rows for it to `fleet.default.json` where it may be called from, and to your own
   `fleet.json`.
4. Agent definitions load at session start; start a new session. An installed plugin registers
   the new agents only where your rules reach them, so list the model in your `fleet.json` too.

## The rules file

Every section is optional. `main.fleet`, `main.builtin_agent_models` and `rules` are allowlists:
missing or empty, they allow everything; non-empty, they allow only what they list.
`disallowed_skills` and `disallowed_commands` are denylists: what they list is refused, and an
empty list refuses nothing.

```json
{
  "main": {
    "fleet": {
      "gpt-6-astra": ["low"],
      "gpt-6-luna": ["medium", "high", "xhigh", "max"]
    },
    "builtin_agent_models": ["opus", "fable"]
  },
  "rules": {
    "gpt-6.1-sol": {
      "gpt-6-luna": ["medium", "high", "xhigh", "max"],
      "claude-haiku-4-5": ["default"]
    }
  },
  "disallowed_skills": ["code-review", "ultrareview", "simplify", "security-review"],
  "disallowed_commands": ["sudo", "doas", "claude"]
}
```

- `main` — the main session, unrestricted by default.
  - `fleet`: fleet agents it may spawn, model → efforts.
  - `builtin_agent_models`: the `model` values it may pass to a built-in agent
    (`general-purpose`, `Explore`, `Plan`, ...). The Agent tool accepts only the aliases `sonnet`,
    `opus`, `haiku`, `fable`. A call without `model` runs on the session model and always passes.
- `rules` — fleet subagents: caller model → callee model → efforts the caller may request. A
  caller with no row may spawn nothing. Built-in agents are not fleet agents and are never
  reachable from a fleet subagent while this section is non-empty. The shipped default lets each
  model call the tiers below its own at every effort; trim it in your copy.
- `disallowed_skills` — skills a fleet subagent may not invoke. The shipped entries fork the
  session onto a model of their own choosing and spawn their own agents, which would lift the
  subagent above its tier; add any skill here for any reason.
- `disallowed_commands` — commands a fleet subagent may not run from Bash, matched as whole words
  in the command line. `claude` is listed because a nested session would start with none of these
  rules.

Regardless of the sections, a fleet subagent may never pass `model` to the Agent tool (the model
belongs to the agent definition) and may not use `Workflow`. A refusal names what the caller may
do instead, read from the rules file.

A fleet agent learns both denylists when it starts: the `SubagentStart` hook adds them to its
context, read from the rules file in force at that moment, so the agent does not try what would be
refused. A refused skill closes only that skill: the agent carries on with its other tools and
skills. A step that needs a refused command is a blocker the agent reports. Built-in agents get
nothing.

To read the rules from somewhere else, set `FLEET_RULES` to the file's path. It must exist: when
it does not, the guard refuses every call it matches rather than falling back to another file.

The rules file must hold exactly one JSON document, an object (`null` reads as an empty object).
An empty or whitespace-only file, a file with several documents, a top-level array or string, and
text that is not JSON are all invalid. An invalid file is refused the same way wherever the guard
reads the rules: every checked call is refused with a message that the rules file is invalid, and
a fleet agent that starts meanwhile gets the error shown to the user instead of its limits; the
main session's calls other than `Agent` still pass. The guard, the generator and the sync share
this one test (`fleet_rules_valid` in `scripts/fleet-rules.sh`).

The guard reads the rules file once per call: it copies the file to a private temporary file,
checks that copy and answers every question from it, so a file saved or removed while it decides
cannot change the answer halfway. A section of the wrong type (a denylist that is a string, a
`main` that is a list, an allowlist such as `main.fleet` or `rules` that is `""`, `0` or `false`)
makes its query fail, and a failed query refuses the call with a message that the rules could not
be read; it never reads as an empty list, so it never opens an allowlist. Only a missing (or
`null`) allowlist, an empty object or an empty list counts as empty. The sync reads the rules the
same way: a query its closure needs that fails leaves `agents/` as it is (exit 3 from the
generator), and the session is told like for any invalid rules file.

## Registered agents

The session's agent list shows only the fleet agents your rules can reach. On every session
start (startup, resume, clear, compact, fork) and whenever the rules file changes,
`scripts/sync-agents.sh` runs `generate-agents.sh --rules <file>`, where the file is
`<data-dir>/fleet.json`, or the shipped default while that is missing (`FLEET_RULES` is not
synced; see below). That renders every agent from
`models.json`, keeps those the guard would let someone start, and deletes the rest from the
installed plugin's `agents/`. "Someone" is the main session through `main.fleet`, then, model by
model, every agent it can reach through `rules`. The readers are the guard's own
(`scripts/fleet-rules.sh`), so the reading is the same:

- an empty or missing allowlist allows everything;
- `default` is the rung of a model without effort control;
- a missing data-directory file falls back to the shipped default.

Only `agents/` changes; the benchmark reference stays as shipped. A file is written only when it
is missing or differs, so a sync with nothing to change writes nothing to `agents/` and says
nothing.

- **`FLEET_RULES`.** The installed `agents/` is shared by every session of that plugin version,
  so a session with `FLEET_RULES` set does not narrow it to its own file and watches nothing for
  it; its context says so at session start. The guard still applies `FLEET_RULES` to every
  checked call of that session, so a listed agent the file does not allow is refused.
- **Watching.** The hook hands Claude Code a `watchPaths` list: `<data-dir>/fleet.json`, plus the
  shipped default while that is the file in force. Saving the file fires `FileChanged`, and the
  sync runs again. Every `SessionStart` source syncs, for two reasons. The hooks documentation
  does not say whether a later `SessionStart` keeps an earlier watch list. And an edit made while
  no session was watching is picked up on the next start. A sync costs about a second.
- **Taking turns.** The generator changes `agents/` only while it holds a lock
  (`agents/.sync.lock`), from copying `models.json` and the rules to the last deletion, and it
  writes the whole new set before deleting anything. Syncs from several sessions therefore run
  one after another; the last one leaves the set its rules reach, never an empty or mixed one. A
  `models.json` saved during a run does not reach that run: it reads only the copy it took, so
  the agents and the reference come from one version of the file. A lock whose holder has exited,
  or that is older than two minutes, is broken; a run refreshes the lock's age once it has
  rendered, and a run whose lock was broken and taken over meanwhile installs nothing (exit 75).
  A run that waits 20 seconds (`FLEET_SYNC_LOCK_WAIT`) without getting the lock changes nothing,
  and its session is told the sync was skipped as busy. Temporary files an interrupted run left
  in `agents/` or beside the reference are removed by the next run.
- **Reloading.** Agent definitions load at session start. When the agent set differs from the
  one a session was last told about, that session gets a notice with the counts and
  `Run /reload-plugins`; until then it keeps the list it loaded. The hook keeps, per session, the
  set it last told it about (`<data-dir>/sessions/<session_id>`), so every session watching the
  file hears of a change, also those whose own run found the directory already synced by
  another session. A session that has just loaded `agents/` (startup, resume, fork) compares
  with the directory as it found it; after a compaction it compares with its record. `/clear`
  starts a new session with a new session id, so it normally has no record and compares like a
  startup, with the directory as it found it (a record under that id, if one exists, is used).
  The accepted residual: when another session changed `agents/` before the clear, the cleared
  session is not told, the same as a startup after such a change.
  Every sync a session runs refreshes the age of its record (and of its missing-git stamp, below),
  and a session start prunes the records of sessions that have run no sync for thirty days, never
  its own. A session that finds no record of its own on a rules change or a compaction (pruned
  meanwhile, or never written) cannot tell which set it loaded, since another session may
  already have synced the directory; it gets one notice that its loaded set is unknown and
  `Run /reload-plugins`, and a record from then on.
- **Where the notice appears.** On `FileChanged` it is the hook's `systemMessage`. On
  `SessionStart` it is both the `systemMessage` and part of `additionalContext`, because the hooks
  documentation does not say whether `SessionStart` shows a `systemMessage`; from the context the
  assistant can pass it on. Without `jq` on `PATH` the hook cannot sync; it says so the same way
  (both fields on `SessionStart`, `systemMessage` on `FileChanged`).
- **After a plugin update.** An update installs a new versioned directory holding every agent.
  The first session on it registers the full set, its start-up sync narrows the directory, and
  the notice asks for `/reload-plugins`. Later sessions start with the narrowed set.
- **A broken rules or models file.** A rules file that is missing or invalid (see
  [The rules file](#the-rules-file): empty, several documents, not one JSON object) leaves
  `agents/` as it is, and the notice says so. The sync runs again when the file changes. An
  editor saving the file can leave it briefly empty or half-written; that must not wipe the
  fleet. A `models.json` that fails the generator's shape check, or that renders no agent, leaves
  `agents/` as it is too; the notice says a fixed `models.json` is picked up at the next session
  start or rules change. A session whose record is behind the directory still gets a notice
  then, worded as "agents/ differs from the set this session loaded", since the directory does
  not follow the invalid file.
- **A convenience, not the enforcement.** Filtering decides only which agent types the session
  lists. The guard still checks every call against the rules in force, whatever is registered.
  - A fleet agent whose file a sync removed has no definition to resolve. That covers one that
    was running at the time and one its session loaded before the sync. The guard resolves it
    by name against `models.json` and applies its model's row.
  - A type with the plugin's prefix that resolves neither way is refused, never passed as
    built-in.
- **A git checkout loaded with `--plugin-dir`.** The plugin root is the checkout, and git tracks
  `agents/` there. The sync leaves the directory alone (filtering it would show up as deleted
  files) and watches nothing; seeding still runs.
  - `FLEET_SYNC_AGENTS=1` syncs a checkout anyway. Run `sh scripts/generate-agents.sh` before
    committing to restore the full set.
  - `FLEET_SYNC_AGENTS=0` switches the sync off everywhere.
  - A checkout is a plugin root with a `.git` above it whose `agents/` git tracks, or any `.git`
    above it when git is not on `PATH`. In that second case the session's context says once that
    the sync was skipped because git could not be asked.

```sh
uv run tests/sync/test_sync.py --fleet-root . --shell /bin/sh
```

## The delegation brief

A spawned agent sees none of the caller's conversation, so the prompt has to carry the target,
the limits and the finish line. `fleet:delegating-task` tells the caller how to write it, and the
hook refuses an `Agent` call to a fleet agent whose prompt lacks the shape. A fleet agent is a
`subagent_type` the guard treats as one: a definition under `agents/` or a name in `models.json`,
prefixed or bare, or any type with the plugin's prefix, so an agent a sync removed is still
inspected. Calls to any other agent type, and calls without a type, are not inspected.

Required `##` sections, each once and nonempty: `Objective`, `Context and Evidence`,
`Scope Boundary`, `Acceptance Criteria`, `Return and Stop`. Optional, but unique and nonempty when
present: `Epistemic Boundary`, `Constraints`, `Additional Context`. The skill still expects
`Epistemic Boundary` unless every claim in the result is checked directly by the acceptance
criteria and all the data is in the brief; the hook leaves that judgment to the caller.
Spelling is exact, order is free, other headings are allowed. Headings inside code fences or HTML comments do not count, so a
brief wrapped in a fence is refused; a section holding only a rule, a subheading, an empty fence or
a comment is empty.

The hook is silent on success and never grants a permission: every other check still runs. A
refusal starts with `FLEET_DELEGATION_INVALID` and lists what is missing, empty or duplicated; the
caller fixes the brief from what it already knows and repeats the call, and this is the only
refusal an agent may act on that way. `FLEET_DELEGATION_ERROR` marks a malformed payload or a
missing dependency and is to be reported. The hook reads the prompt and nothing else: it opens no
file the brief names, runs nothing, rewrites nothing and keeps no state.

```sh
uv run tests/delegation/test_contract.py --shell /bin/sh
uv run tests/delegation/test_integration.py --fleet-root . --shell /bin/sh
```

The tests use the Python standard library only and any Python 3.9+ runs them; the hook itself
never calls Python.

## Limits

- The brief check looks at shape, not meaning: a brief naming the wrong account, or filled with
  `TODO`, passes. It covers the `Agent` tool only, not messages sent to an agent already running.
  It parses a small Markdown subset, not CommonMark.
- Agent definitions load at session start. The guard reads the rules file on every call, but a
  new, changed or removed agent file reaches a running session only through `/reload-plugins`
  or a new session. The first session after a plugin update lists every agent until then.
- Sessions share the installed `agents/` directory, and it follows the data-directory rules
  file only. A session with `FLEET_RULES` lists that set, not its own; the guard applies its own
  file to each call.
- `watchPaths` replaces a session's dynamic watch list. The documentation does not say whether
  each plugin keeps its own list, so another plugin that sets watch paths may replace the fleet's
  list, or the fleet may replace its.
- Editors that save by deleting and recreating the file can trigger two syncs, the first against
  the shipped default; the second puts the right set back.
- Plugin updates leave `fleet.json` alone, but `claude plugin uninstall` removes the plugin's
  data directory with it. Copy the file aside before uninstalling if the rules took work.
- Built-in subagents (`general-purpose`, `Explore`, forked skills, ...) are not governed when they
  are the caller: whatever they spawn or run passes. Spawning them is governed on the caller's
  side — `main.builtin_agent_models` for the main session, and a fleet subagent cannot reach
  them at all while `rules` is non-empty.
- The benchmark figures in the agent descriptions and in the reference table are a dated
  snapshot from `models.json`, not live data.
- The command check is word matching over the command line. It stops a cooperating agent from
  drifting; it is not a security boundary.
