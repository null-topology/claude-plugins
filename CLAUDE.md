# Working in this repository

This repository is a Claude Code plugin marketplace. Everything here is public and meant to be
installed by strangers, so the rules below are about shipping something others can rely on.

## Layout

- One plugin per `plugins/<name>/`, self-contained: `.claude-plugin/plugin.json`, `README.md`,
  and whichever of `skills/`, `hooks/`, `scripts/`, `agents/` it needs.
- `.claude-plugin/marketplace.json` at the root lists every plugin with `source: ./plugins/<name>`.
  A plugin that is not listed there does not exist for users.
- The root `README.md` has one table row per plugin. Keep it in sync.

## Plugins ship mechanism, not policy

- Nothing user-specific: no personal paths, account names, client or project names, ticket
  prefixes, language preferences or workflow habits. Conventions like these belong in the user's
  own `~/.claude/`, never in a plugin.
- A plugin must behave sensibly on a machine that is not the author's: macOS and Linux, a missing
  optional dependency, an empty project, a directory that has never seen a session.
- Read only what belongs to the current project. A hook must never surface data from another
  project's transcripts or directories.

## Skills

- Directory name equals the `name` in the SKILL.md frontmatter.
- The `description` states *when* to invoke the skill, in concrete terms, because that is what
  triggers model invocation. Keep skills model-invocable unless there is a stated reason not to.
- The body says *where and how*. It must not depend on facts a fresh session cannot know.

## Hooks

- Plain `bash` plus `jq`. Portable across BSD and GNU userlands: no `mapfile`, no `tac`, no
  `date -d` without a BSD fallback, no bash 4 features (macOS ships bash 3.2).
- Exit `0` silently when a dependency is missing or there is nothing to say. A hook must never
  break a session.
- Address scripts through `${CLAUDE_PLUGIN_ROOT}`; persistent state goes under
  `${CLAUDE_PLUGIN_DATA}` with a fallback when the placeholder is not expanded.
- Set a `timeout` on every hook entry and stay well below it.
- Before committing a hook change, run the script by hand with a stdin JSON that mimics the
  event (`source`, `reason`, `transcript_path`, `cwd`, ...) for every branch it has: the happy
  path, the empty project, the source it must ignore. Then verify in a real session
  (`claude -p` is enough for `startup`).

## Versioning and releases

- Semantic versioning per plugin. The version lives in two places and they must match:
  `plugins/<name>/.claude-plugin/plugin.json` and that plugin's entry in
  `.claude-plugin/marketplace.json`.
- Every user-visible change bumps the version in the same commit. Users get updates only through
  `claude plugin marketplace update`, so an unbumped change is invisible to them.
- Each version bump is tagged on its commit as `<plugin>/v<version>` (annotated tag, one line
  saying what the release is). Tags are pushed together with the commit. One repository, many
  plugins, so tags carry the plugin name.
- Release procedure: bump both version fields, update the plugin README if behaviour changed,
  commit, tag, `git push --follow-tags`, then on the maintainer's machine
  `claude plugin marketplace update <marketplace>` and reinstall to confirm the new version lands.

## Commits

- English. A semantic type prefix (`feat`, `fix`, `docs`, `refactor`, `chore`), a short summary,
  and a body of a few lines saying what changed and why. No ticket prefixes in this repository.
- One concern per commit: a plugin change and a marketplace-wide change are separate commits.

## Documentation

- Every plugin README answers, in this order: why someone would want it, what it does, how to
  install it, what it injects or changes, its known limits, its layout.
- Everything written to this repository is English.

## Local files

- `.claude/` at the repository root is ignored. Session handoffs, plans and notes stay local.
