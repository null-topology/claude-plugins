---
name: search
description: Answer a question about past work from the project's handoff documents when no better source holds the answer, reading file names, front matter and headings instead of whole files. Use it when the user asks what was worked on at some time, which tasks touched something, or where a past task stopped, for example "what did we work on a week ago", "which tasks touched the billing service", "where did that ticket stop", asked in any language. It answers questions; it does not resume work. To continue a past task, use seamless:restore instead.
argument-hint: "[question about past work]"
---

Find past work in the handoff documents kept by the `seamless:save` skill, at the lowest reading
cost: file names first, then front matter, then headings, and only then the few sections that
answer the question. Never read a handoff in full to search it.

This skill answers a question. When the user wants to pick a past task up and continue it, use
`seamless:restore` instead.

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
- its descendants:

  ```sh
  find <startup dir> \( -name .git -o -name node_modules -o -name worktrees -o -name .worktrees \
    -o -name .terraform -o -name vendor \) -prune -o -type d -path '*/.claude/handoffs' -print
  ```

## 3. Three passes, in order of cost

The passes below rank files; they do not throw any away. A file that the filename pass did not
pick may still be the answer, because the term may appear only in its front matter or a heading.

1. Run the filename pass (section 4) over all files. Its matches are read first.
2. Run the front matter pass (section 5) on those matches. Then, **when the passes so far found
   nothing, or the question asks for everything** ("which tasks touched X", "everything on
   billing"), run it on the files not matched yet.
3. Run the heading pass (section 6) on the files that matter so far. Under the same condition,
   run it on the files still not matched by name or front matter.
4. Read only the chosen sections (section 7).

Report "no match" only after all three passes have covered every file in range. Never read a
body whole, at any stage.

## 4. Filename pass

Names are `<YYYY-MM-DD>-[<TICKET>-]<slug>.md`; older files may be `handoff-<slug>-<YYYY-MM-DD>.md`.

- **A time range** ("a week ago", "in March"): compute the dates with `date`, then keep the files
  whose dates overlap the range. What a file's date means depends on its age:
  - a file with a `date` key (the contract of `seamless:save`, since seamless 0.5.0) covers one
    day: its filename date, which equals its `date` key;
  - a file without front matter, or whose front matter holds only `status: frozen` and `next`
    (added when it rolled over), was written before 0.5.0. Then the filename date was the day
    the file was created, and one file covered the task up to its last modification. It covers
    the span from its filename date to its mtime (`ls -l <file>`), or, when a later file
    supersedes it (its `next`, or a newer file of the same task naming it), up to that file's
    date. Treat the mtime with care: `git checkout`, `clone` and `rsync` reset it.
- **A ticket key**: match it in the name.
- **A topic**: match slug words, trying synonyms and both singular and plural.

When the names leave too many files, narrow by time first.

## 5. Front matter pass

Print the front matter of each file, prefixed with its path and line number like `grep -Hn`, so
that every match stays tied to its file. The block ends at the closing `---`, at the first line
when the file has no front matter, and after 40 lines when the closing `---` is missing; CRLF
line endings are stripped:

```sh
for f in <dir>/*.md; do
  [ -f "$f" ] || continue
  awk '{sub(/\r$/,"")} NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>40{exit} NR>1{print FILENAME":"NR":"$0}' "$f"
done
```

Replace `<dir>/*.md` with the files of the current stage, and match keys on this output, never
on whole files (a `ticket:` or `summary:` line in a body is not a key):

- a ticket, exactly (`ABC-123` must not match `ABC-1234`):
  `| grep -E ':[0-9]+:ticket: *"?ABC-123"? *(#.*)?$'`
- every summary: `| grep -E ':[0-9]+:summary:'`
- a word in any key (`task`, `summary`, `key_points`, `tags`, `repos`, ...): `| grep -i 'billing'`

Filter on `task`, `ticket`, `date`, `started`, `status`, `summary`, `key_points`, `repos` and
`tags`. The `summary` line, with `key_points` when present, often answers a "what were we doing"
question on its own.

## 6. Heading pass

List the headings with line numbers, skipping the front matter (whose YAML comments also start
with `#`) and fenced code blocks (whose shell comments do too):

```sh
awk '{sub(/\r$/,"")} NR==1&&$0=="---"{f=1;next} f{if($0=="---"||NR>40)f=0;next} /^(```|~~~)/{c=!c;next} !c&&/^#+ /{print NR": "$0}' <file>
```

The H1, the first `# ` line printed, states the task; the H2 sections are `Current state`,
`Decisions`, `Proven`, `Broken`, `Open`, `Plan`, `Next action`, `Suggested skills`, `References`,
with sub-topics in H3. Do not use `grep '^#'`: it also returns YAML and code comments.

## 7. Read only the chosen sections

Read the sections that answer the question by line range, from a heading's line to the line
before the next heading of the same or a higher level (`sed -n '<from>,<to>p' <file>` or a ranged
read). Nothing else.

## 8. Walk a task's days

A task keeps one file per day. To follow it, read the front matter of each file and go back
through `previous` or forward through `next`; the files sit in the same directory. Files with
the same `task` key form the task even when a link is missing. The active file is the one whose
`status` is `active`. `done` marks a task finished on that day, but the work may have resumed
later: a done file may have a `next`, or a later file of the same `task` may name it in
`previous`.

## 9. Files without front matter

Older handoffs have no front matter, or only the `status: frozen` and `next` keys added when they
rolled over. Use the filename for the topic, the dating rule of section 4
for the time span, and the heading command above for the structure, then read the sections you
need by line range.

## 10. Report

A handoff records what its session believed at the time, not what is true now. Before acting on
anything it says, verify the current state (code, tracker, deployed resources); say when a
handoff and the present disagree.

Answer the question directly, and cite each finding as `path:line`: the file and the line of the
front matter key or section it comes from. When the handoffs do not answer the question, say what
you searched (directories, date range, words, and which passes covered which files) and that
nothing matched.
