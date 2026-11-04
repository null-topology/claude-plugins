---
name: search
description: Answer questions about past work from the project's handoff documents when no better source holds the answer, reading front matter and headings instead of whole files. Use it when the user asks what was worked on at some time, which tasks touched something, or where a past task stopped, for example "what did we work on a week ago", "which tasks touched the billing service", "where did that ticket stop", asked in any language.
argument-hint: "[question about past work]"
---

Find past work in the handoff documents kept by the `seamless:save` skill, at the lowest reading
cost: file names first, then front matter, then headings, and only then the few sections that
answer the question. Never read a handoff in full to search it.

## 1. Prefer a better source

Handoffs are the fallback. When a better source for the question exists and is reachable, use it
first: the issue tracker for tickets and their state, `git log` for what changed and when, the
team's knowledge base, your memory or the project's notes. Turn to handoffs when those do not hold
the answer, or to add what they lack (decisions, dead ends, whose step was open).

## 2. Locate the handoff directories

Resolve the startup directory as `seamless:restore` does (the `Startup directory:` line of the
session-start context, else the primary working directory in the system prompt, else the first
`cwd` in this session's transcript). Inside a sandboxed agent container (`AGENT_WORKING_DIR` set)
include `$AGENT_WORKING_DIR/workspace/handoffs/`. Then collect every `.claude/handoffs/` in:

- the startup directory itself;
- its ancestors, stopping before `$HOME`;
- its descendants: `find <startup dir> \( -name .git -o -name node_modules -o -name worktrees \)
  -prune -o -type d -path '*/.claude/handoffs' -print`.

## 3. Filename pass

Filter by name before opening anything. Names are `<YYYY-MM-DD>-[<TICKET>-]<slug>.md`, where the
date is the day the file covers; older files may be `handoff-<slug>-<YYYY-MM-DD>.md`.

- **A time range** ("a week ago", "in March"): compute the dates with `date`, then keep the files
  whose filename date falls in the range.
- **A ticket key**: match it in the name.
- **A topic**: match slug words, trying synonyms and both singular and plural.

When the names leave too many files, narrow by time first. When they leave none, widen the range
or the words before concluding there is nothing.

## 4. Front matter pass

For each remaining file read only the block between the first two `---` lines:

```sh
awk 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit} NR>1' <file>
```

Filter on `task`, `ticket`, `date`, `started`, `status`, `summary`, `repos` and `tags`. To find
files whose name does not give them away, grep the keys across the directories, for example
`grep -l '^ticket: ABC-123' <dir>/*.md` or `grep -H '^summary:' <dir>/*.md`. The `summary` line
often answers a "what were we doing" question on its own.

## 5. Heading pass

For the files that still matter, list the headings with line numbers:

```sh
grep -n '^#' <file>
```

The H1 states the task; the H2 sections are `Current state`, `Decisions`, `Proven`, `Broken`,
`Open`, `Plan`, `Next action`, `Suggested skills`, `References`, with sub-topics in H3.

## 6. Read only the chosen sections

Read the sections that answer the question by line range, from a heading's line to the line
before the next heading of the same or a higher level (`sed -n '<from>,<to>p' <file>` or a ranged
read). Nothing else.

## 7. Walk a task's days

A task keeps one file per day. To follow it, read the front matter of each file and go back
through `previous` or forward through `next`; the files sit in the same directory. Files with
the same `task` key form the task even when a link is missing. The active file is the one whose
`status` is `active`; `done` marks a finished task.

## 8. Files without front matter

Older handoffs have no front matter. Use the filename for the date and topic and
`grep -n '^#'` for the structure, then read the sections you need by line range, as above.

## 9. Report

A handoff records what its session believed at the time, not what is true now. Before acting on
anything it says, verify the current state (code, tracker, deployed resources); say when a
handoff and the present disagree.

Answer the question directly, and cite each finding as `path:line`: the file and the line of the
front matter key or section it comes from. When the handoffs do not answer the question, say what
you searched (directories, date range, words) and that nothing matched.
