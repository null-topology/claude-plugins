# seamless

`/clear` at any time. The next session carries on.

## Why, when there is `/compact`

Picture a real afternoon. You are deep in a task, the session has grown to several hundred
thousand tokens of context, and you step away for a couple of hours. When you come back, the
prompt cache for that conversation has expired. Now every option is bad:

- **Send the next message** and the whole context is re-read as uncached input, at full price,
  for every message from now on until the cache is warm again.
- **Run `/compact`** and it is worse than it looks. Compaction is a separate request that sends
  the same system prompt, the same tools and the *entire* history back to the model with a
  "summarise this" instruction. With a warm cache that is cheap: the prefix is read from cache
  and you pay mostly for generating the summary. With a cold cache there is nothing to read
  from, so the summarisation processes the full history as uncached input. `/compact` is at its
  most expensive exactly when you are most tempted to use it: on resuming an old session.
- **Run `/clear`** and it costs nothing. But the fresh session knows nothing and opens with
  "what were we working on?", and you retype the state from memory.

This plugin makes the third option the obvious one. Because a handoff document is kept alive
while you work, and because the fresh session gets the previous one's context injected before
your first message, `/clear` stops being a loss. Two things follow:

1. **Big sessions on a cold cache are no longer a trap.** Come back after a break, `/clear`,
   say "go on", and the work continues from the handoff. No compaction over cold tokens.
2. **You never have to wait for `/compact`.** You do not need the context window to fill up
   before starting fresh. Finished a block? Cache went cold over lunch? `/clear` and keep going.
   Each new session starts small, cheap and warm.

Whether the cache is warm right now is shown by `/usage` in recent versions of Claude Code
(the prompt-cache line for the main conversation); the cache lifetime depends on your plan and
settings.

## What it does

This plugin closes the gap from both sides:

- **`/seamless:save`** keeps a living handoff document in the project (`.claude/handoffs/`),
  created as soon as a task has a scope and updated after each finished block of work.
- **`/seamless:restore`** reads that document in a fresh session and continues from it.
- A **`SessionStart` hook** runs on `startup` and `clear` and hands the new session, before its
  first message: the startup directory, the previous session's last prompt, the handoff documents
  that exist for the project, the files edited most recently, and the standing rule to keep the
  handoff living. That is usually enough to resume without a question, even when no handoff was
  written, and it means nothing has to be added to `CLAUDE.md`.

Both skills are model-invocable: their descriptions and the hook's context tell Claude when to use
them, so in practice the handoff gets written and read without being asked for.

## Install

```
claude plugin marketplace add null-topology/claude-plugins
claude plugin install seamless@null-topology
```

Requires `jq` for the hooks (the skills work without it). The hooks are plain `bash` and run on
macOS and Linux.

## What the hook injects

```
[seamless] This session replaces one the user just cleared. Context recovered:
Startup directory: /path/to/project
Previous session: 6cdafa28-… — the session that was just cleared (last activity 2026-09-15 17:22)
Last prompt of the previous session: add the lock to the sentry stack …
Recently edited in the previous session (most recent first):
  .claude/handoffs/2026-09-15-handoff-plugin.md
  services/analytics/.infrastructure/locals.tf
Handoff documents (newest per directory):
  .claude/handoffs/2026-09-15-handoff-plugin.md (modified 2026-09-15 17:18; 3 file(s) in this directory)
Now: before asking the user what they were working on, read the newest handoff with the seamless:restore skill. …
Standing rule: the user relies on this plugin to /clear at any moment without losing the thread. Keep a living handoff document: …
```

The hook reads only the current project's own transcript directory under `~/.claude/projects/`,
so context from another project never leaks into this one. A directory that has never had a
session gets no previous-session lines, only the standing rule.

It runs on `startup` and `clear` only. `resume` brings the context back by itself, `compact` keeps
the same session with a summary, and `fork` inherits the parent's context.

How it knows which session was the previous one:

- **After `/clear`** a `SessionEnd` hook (reason `clear`) has just written a marker naming the
  transcript that was cleared, in the plugin's data directory. The `SessionStart` hook reads
  exactly that transcript and removes the marker. If the marker is missing or older than ten
  minutes it falls back to the newest transcript in the project other than the current one.
- **At `startup`** it takes the newest transcript in the project other than the current one, which
  is simply the last time Claude Code ran in this directory, and says how old it is.

## Handoff documents

Location: `<startup directory>/.claude/handoffs/`. A sub-project below the startup directory may
hold its own; when more than one directory has candidates, `restore` asks which one applies rather
than guessing.

Naming: `<YYYY-MM-DD>-<TICKET>-<slug>.md`, or `<YYYY-MM-DD>-<slug>.md` without a ticket. Date first
so `ls` sorts chronologically; the date is the creation date and the filename never changes on
update. Files in the older `handoff-<slug>-<date>.md` form are renamed one at a time when
`restore` opens them; nothing is mass-renamed.

Inside a sandboxed agent container (`AGENT_WORKING_DIR` set) the document goes to
`$AGENT_WORKING_DIR/workspace/handoffs/`, which is bind-mounted from the host and survives the
container.

Whether `.claude/handoffs/` is committed or ignored is your call per repository; the plugin does
not touch `.gitignore`.

## Known limits

- **Parallel sessions in one project.** After `/clear` the marker makes the choice exact. On
  `startup` "previous session" is the newest transcript other than the current one; if it was
  written less than a minute ago, the hook says it may belong to a session still running.
- **mtime is not trusted alone.** `git checkout`, `clone` and `rsync` reset it. The date in the
  filename is the reference; when the two disagree by more than a day the hook says so.
- **Only Write/Edit/NotebookEdit calls count as edits.** Files changed through shell commands are
  not listed.
- The previous session's last prompt is cut at 300 characters.

## Layout

```
plugins/seamless/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                  SessionEnd "clear", SessionStart "startup|clear"
├── scripts/
│   ├── session-end-mark.sh           marks the transcript that /clear just closed
│   └── session-start-context.sh      builds the context for the new session
└── skills/
    ├── save/SKILL.md                 /seamless:save
    └── restore/SKILL.md              /seamless:restore
```
