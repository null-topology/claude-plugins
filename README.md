# claude-plugins

A Claude Code plugin marketplace.

```
claude plugin marketplace add null-topology/claude-plugins
claude plugin install <plugin>@null-topology
```

## Plugins

| Plugin | What it does |
|---|---|
| [fleet](plugins/fleet/) | Executor subagents, one per model and reasoning effort, held to a single rules file: which model may spawn which at what effort, which skills and commands a subagent may not use, and which agents the main session may spawn. One skill picks the model for a task, another shapes the brief, and a hook refuses a fleet spawn whose prompt lacks the brief's structure. |
| [kiro-sidecar](plugins/kiro-sidecar/) | Delegates work to Kiro CLI agent sessions over the Agent Client Protocol, in a Docker container that sees only the mounted directories or locally on the host. Each call returns at once; when a turn ends, a hook pushes its result into the conversation, and the same session takes the next prompt. Needs Node.js 22 and, for Docker mode, the Kiro image. |
| [seamless](plugins/seamless/) | `/clear` at any time and the next session carries on: a living handoff document, a skill that restores it, and a `SessionStart` hook that hands the fresh session the previous one's context and the rule to keep the handoff living. |

## Layout

Each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json` and README.
`.claude-plugin/marketplace.json` at the root lists them.

To try a plugin from a local checkout instead of GitHub:

```
claude plugin marketplace add /path/to/claude-plugins
claude plugin install <plugin>@null-topology
```
