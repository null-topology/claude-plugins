# fleet

A fleet of executor subagents, one per model and reasoning effort, plus the guard that keeps them
inside a policy written in one place.

## What it ships

- `agents/<model>-<effort>.md` — the fleet, generated from `models.json`. Each file fixes a model
  and, where the model supports effort control, an effort in its frontmatter; no hooks, no rules —
  those live elsewhere.
- `models.json` — the models the plugin knows: id, name, vendor, the effort rungs each one
  supports, and a dated benchmark snapshot per rung. The single place to edit when a model or a
  provider appears.
- `scripts/generate-agents.sh` — deletes `agents/*.md` and regenerates them from `models.json`,
  then rewrites the benchmark table under `skills/selecting-subagent-model/references/`. Its
  output is committed; the plugin ships files, not a build step.
- `fleet.default.json` — the default rules. On the first session start the plugin copies it to
  `~/.claude/plugins/data/fleet-<marketplace>/fleet.json` and reads it from there; that copy is
  yours to edit and plugin updates never touch it.
- `scripts/subagent-guard.sh` — the guard, a `PreToolUse` hook on `Agent|Bash|Skill|Workflow`
  declared once in the plugin's `hooks.json`. It tells the caller from the hook payload: a fleet
  `agent_type` resolves to its definition, whose model is the row the rules are keyed by;
  otherwise an empty `agent_id` means the main session (which may still carry an `agent_type`
  when the session runs as `claude --agent <name>`); anything else is a built-in subagent and
  passes. Needs `jq`.
- `scripts/seed-rules.sh` — the one-time copy of the default rules.
- `skills/selecting-subagent-model` — how to pick a model and effort for a task.
- `skills/delegating-task` — how to write the prompt for the agent that was picked, with worked
  examples under `examples/`.
- `scripts/delegation-contract.sh` — a second `PreToolUse` hook, on `Agent` only, that checks the
  shape of that prompt when the call targets a fleet agent. Needs `jq` and `awk`.
- `tests/delegation/` — fixture tests for the hook alone and next to the guard and the generator.

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

A model with no effort control (Haiku) gets one file, `agents/<model>.md`, without an effort
key. The rules refer to its single rung as `default`.

### Adding a model

1. Add it to `models.json` with the rungs it supports and the benchmark figures you have.
2. Run `sh scripts/generate-agents.sh` and review the diff under `agents/` and `references/`.
3. Add rows for it to `fleet.default.json` where it may be called from, and to your own
   `fleet.json`.
4. Agent definitions load at session start; start a new session.

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
      "gpt-5.6-luna": ["medium", "high", "xhigh", "max"]
    },
    "builtin_agent_models": ["opus", "fable"]
  },
  "rules": {
    "gpt-5.6-sol": {
      "gpt-5.6-luna": ["medium", "high", "xhigh", "max"],
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

To read the rules from somewhere else, set `FLEET_RULES` to the file's path. It must exist: when
it does not, the guard refuses every call it matches rather than falling back to another file.

## The delegation brief

A spawned agent sees none of the caller's conversation, so the prompt has to carry the target,
the limits and the finish line. `fleet:delegating-task` tells the caller how to write it, and the
hook refuses an `Agent` call to a fleet agent whose prompt lacks the shape. A fleet agent is a
`subagent_type` with a definition under `agents/`, prefixed or bare; calls to any other agent
type, and calls without a type, are not inspected.

Required `##` sections, each once and nonempty: `Objective`, `Context and Evidence`,
`Scope Boundary`, `Acceptance Criteria`, `Return and Stop`. Optional, but unique and nonempty when
present: `Epistemic Boundary`, `Constraints`, `Additional Context`. Spelling is exact, order is
free, other headings are allowed. Headings inside code fences or HTML comments do not count, so a
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
- Agent definitions load at session start; the rules file is read on every call, but a new or
  changed agent file needs a new session.
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
