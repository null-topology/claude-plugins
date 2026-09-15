# claude-plugins

A Claude Code plugin marketplace.

```
claude plugin marketplace add null-topology/claude-plugins
claude plugin install <plugin>@null-topology
```

## Plugins

| Plugin | What it does |
|---|---|
| [seamless](plugins/seamless/) | `/clear` at any time and the next session carries on: a living handoff document, a skill that restores it, and a `SessionStart` hook that hands the fresh session the previous one's context and the rule to keep the handoff living. |

## Layout

Each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json` and README.
`.claude-plugin/marketplace.json` at the root lists them.

To try a plugin from a local checkout instead of GitHub:

```
claude plugin marketplace add /path/to/claude-plugins
claude plugin install <plugin>@null-topology
```
