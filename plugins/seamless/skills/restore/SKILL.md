---
name: restore
description: Recover the state of previous work at the start of a session, after /clear, a compaction or a cold start, by reading the project's newest handoff document. Invoke it before asking the user what they were working on, whenever the session-start context lists handoff documents, or when the user refers to earlier work you have no context on.
---

Read the handoff document left by the previous session and continue from it, instead of asking
the user to explain what was going on.

Handoffs follow the contract of the `seamless:save` skill: YAML front matter (`task`, `ticket`,
`date`, `started`, `status`, `previous`, `next`, `summary`, ...), one H1 stating the task, fixed H2
sections. A task keeps one file per day; an older day's file is `status: frozen` and names the
next one in `next`. Files written before the contract have no front matter.

## 1. Find the candidates

If the session-start context injected by this plugin's hook lists `Handoff documents kept by the
previous session(s)`, the first file in that list is the document: the hook followed the chain of
sessions this one continues (the one just cleared, the one before it, up to five steps) and took
the handoffs they wrote or edited, nearest session first. Other sessions may be running in the
same directory, so a newer file in the per-directory list below it is not necessarily yours.

Otherwise, if the context lists `Handoff documents (newest per directory)`, start from that
list — it was built at startup from the real filesystem and names the newest file in every
handoff directory that belongs to this project. Without the chain, nothing ties those files to
this session: other sessions may be running in the same directory and keeping them.

Otherwise resolve the startup directory (the `Startup directory:` line of that context, else the
primary working directory in the system prompt, else the first `cwd` in this session's transcript:
`jq -r 'select(.cwd) | .cwd' ~/.claude/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl | head -1`) and
look for `.claude/handoffs/*.md` in:

- the startup directory itself;
- its ancestors, stopping before `$HOME`;
- its descendants (`find <startup dir> -type d -path '*/.claude/handoffs'`, pruning `.git`,
  `node_modules`, `worktrees`).

Within a directory, order by the date in the filename first and by mtime second. When the two
disagree by more than a day, say so: `git checkout`, `clone` and `rsync` reset mtimes, so an old
document can look fresh.

To describe a candidate, read only its front matter (the lines between the first two `---`
lines: `awk 'NR==1 && $0!="---"{exit} NR>1 && $0=="---"{exit} NR>1' <file>`) and its H1
(`grep -m1 '^# ' <file>`), not its first line: in a file with front matter the first line is
`---`.

## 2. Choose one

- **The chain names a document** — read it; the questions below do not arise.
- **The user named the work** — read the document that matches what they named: its `task`,
  `ticket` or `summary`, or its filename for a file without front matter.
- **Otherwise** — do not pick by mtime or by depth, not even when only one directory has
  handoffs: the newest file there may belong to a session still running next to this one, and
  any heuristic eventually picks wrong silently. Show the candidates (path, filename date, mtime,
  `status` and `summary` from the front matter, else the H1) and ask the user which one applies.
  One question costs a line; a wrong guess costs the session.
- A document that another handoff explicitly supersedes is not a candidate.

## 3. Follow `next` to the active file

If the chosen file is `status: frozen`, it is history: open the file its `next` names, in the
same directory, and repeat until the file is not frozen. Say which file you started from and
which one you landed on. If `next` is missing or names a file that does not exist, look in the
directory for a later file of the same `task` (or the same ticket key and slug); if there is none,
say so and continue from the frozen file — the next update rolls the task over to a new file.

A file with `status: done` is a finished task; report it as such and confirm with the user before
continuing work on it.

## 4. Rename old-format files on the way

If the chosen file is named `handoff-<slug>-<YYYY-MM-DD>.md`, rename it to `<YYYY-MM-DD>-<slug>.md`
(`git mv` when tracked, plain `mv` otherwise) and mention the rename. When the slug starts with a
ticket key such as `ABC-123`, keep the key right after the date. Rename only the file you open;
never mass-rename a directory.

## 5. Read and continue

Read the front matter first. Then read the body: in full when the file is short; when it is long
(more than about 300 lines, `wc -l`), and always for a large file without front matter, list its
headings first (`grep -n '^#' <file>`) and read the sections the next action needs by line range,
starting with the current state, the open points and the next action. Follow its references
(plans, specs, tickets) and its `previous` file only when the next action needs them.

Then report, briefly: what the work is, where it stopped, what is already proven, what is open and
whose step it is. Continue from the document's next action. Treat facts it marks as verified as
verified, and decisions it marks as taken as taken — do not re-derive or reopen them. When the
document and the code disagree, the code wins; say what differs.

Keep the document living: update it with the `seamless:save` skill as the work proceeds. If its
`date` is before today, the first update rolls it over to today's file.

## 6. When there is no handoff

Use what the session-start context offers — the previous session's last prompt and the files it
edited most recently — to form a hypothesis, and confirm it with the user in one precise question
rather than an open "what were we working on". Once the scope is clear, create a handoff with
`seamless:save` so the next `/clear` resumes from it.
