---
name: restore
description: Recover the state of previous work at the start of a session, after /clear, a compaction or a cold start, by reading the handoff document the previous session kept. Invoke it before asking the user what they were working on, whenever the session-start context lists handoff documents, or when the user refers to earlier work you have no context on and wants to continue it.
---

Read the handoff document left by the previous session and continue from it, instead of asking
the user to explain what was going on.

Handoffs follow the contract of the `seamless:save` skill: YAML front matter (`task`, `ticket`,
`date`, `started`, `status`, `previous`, `next`, `summary`, optionally `key_points`, ...), one H1
stating the task, fixed H2 sections. A task keeps one file per day; an older day's file is
`status: frozen` and names the next one in `next`. Files written before the contract have no
front matter.

Two read-only commands describe a file without reading its body. The front matter (CRLF line
endings tolerated; stops at the closing `---`, at the first line when there is no front matter,
and after 40 lines when the closing `---` is missing):

```sh
awk '{sub(/\r$/,"")} NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>40{exit} NR>1' <file>
```

The headings with their line numbers, skipping the front matter (whose YAML comments also start
with `#`) and fenced code blocks (whose shell comments do too):

```sh
awk '{sub(/\r$/,"")} NR==1&&$0=="---"{f=1;next} f{if($0=="---"||NR>40)f=0;next} /^(```|~~~)/{c=!c;next} !c&&/^#+ /{print NR": "$0}' <file>
```

The H1 is the first `# ` line it prints. Do not use `grep '^#'` or the file's first line for
either: in a file with front matter the first line is `---`, and a `#` at column 0 may be a YAML
or shell comment.

## 1. Find the candidates

**The chain names documents.** If the session-start context injected by this plugin's hook lists
`Handoff documents kept by the previous session(s)`, the hook followed the chain of sessions this
one continues (the one just cleared, the one before it, up to five steps) and took the handoffs
they wrote or edited, nearest session first. Read the front matter of each entry in order. Skip an
entry that is `status: frozen`: follow its `next` (step 3) and treat the file you land on as that
entry, so a frozen day and its successor count as one candidate, not two. The first entry left
after that is the document. Other sessions may be running in the same directory, so a newer file
in the per-directory list below it is not necessarily yours.

**No chain, but a per-directory list.** If the context lists only `Handoff documents (newest per
directory)`, each line is a pointer to a handoff directory, not a candidate: it names only the
newest file there, which may be a neighbour's or a frozen day. It was built at startup from the
real filesystem and covers every handoff directory that belongs to this project. List the
handoff files in each of those directories (`ls <dir>/*.md`) and describe each one by its front
matter (`status`, `task`, `summary`) or, without front matter, by its H1. Those are the
candidates for step 2. Without the chain, nothing ties any of them to this session: other
sessions may be running in the same directory and keeping them.

**No list.** Otherwise resolve the startup directory (the `Startup directory:` line of that
context, else the primary working directory in the system prompt, else the first `cwd` in this
session's transcript:
`jq -r 'select(.cwd) | .cwd' ~/.claude/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl | head -1`) and
look for handoff files (`*.md`) in:

- `$AGENT_WORKING_DIR/workspace/handoffs/`, when `AGENT_WORKING_DIR` is set (a sandboxed agent
  container, where `seamless:save` writes);
- `<startup dir>/.claude/handoffs/`;
- `.claude/handoffs/` in its ancestors, stopping before `$HOME`;
- `.claude/handoffs/` in its descendants:

  ```sh
  find <startup dir> \( -name .git -o -name node_modules -o -name worktrees -o -name .worktrees \
    -o -name .terraform -o -name vendor \) -prune -o -type d -path '*/.claude/handoffs' -print
  ```

Describe every file found as above.

Within a directory, order by the date in the filename first and by mtime second. When the two
disagree by more than two days on an `active` file or a file without front matter, say so:
`git checkout`, `clone` and `rsync` reset mtimes, so an old document can look fresh. Do not raise
it for `status: frozen` or `done` files: their last edit (the freeze, a correction of `next`)
normally comes days after the date they cover.

## 2. Choose one

- **The chain names a document** — read it; the questions below do not arise.
- **The user named the work** — match what they named against all the candidates, not only the
  newest per directory: their `task`, `ticket`, `summary` or `key_points`, or the filename and H1
  of a file without front matter. Read the one that matches.
- **Otherwise** — do not pick by mtime or by depth, not even when only one directory has
  handoffs: the newest file there may belong to a session still running next to this one, and
  any heuristic eventually picks wrong silently. Offer the `status: active` candidates and those
  without front matter (path, filename date, mtime, `status` and `summary`, else the H1), leave
  out frozen and done files, and ask the user which one applies. One question costs a line; a
  wrong guess costs the session.
- A document that another handoff explicitly supersedes is not a candidate.

## 3. Follow `next` to the active file

If the chosen file is `status: frozen`, it is history: open the file its `next` names, in the
same directory, and repeat until the file is not frozen. Say which file you started from and
which one you landed on. If `next` is missing or names a file that does not exist, look in the
directory for a later file of the same `task` (or the same ticket key and slug); if there is none,
say so and continue from the frozen file — the next update rolls the task over to a new file.

A file with `status: done` is not always the end of the task: the work may have resumed on a
later day in a new file. Before reporting it as finished, read the front matter of the other
files in its directory and look for a later file with the same `task`, or one whose `previous`
names this file (follow its `next` first when it has one). If there is one, land on it, as for a
frozen file, and say so. Only when there is none, report the task as finished and confirm with
the user before continuing work on it.

## 4. Read and continue

Read the front matter first. Then read the body: in full when the file is short; when it is long
(more than about 300 lines, `wc -l`), and always for a large file without front matter, list its
headings first with the `awk` command above and read the sections the next action needs by line
range, starting with the current state, the open points and the next action. Follow its
references (plans, specs, tickets) and its `previous` file only when the next action needs them.

Do not rename the file, even when it has the older `handoff-<slug>-<YYYY-MM-DD>.md` name: the
rename belongs to `seamless:save`, right before its first edit of the file, so that the edit
records the new path for the next session.

Then report, briefly: what the work is, where it stopped, what is already proven, what is open and
whose step it is. Continue from the document's next action. Treat facts it marks as verified as
verified, and decisions it marks as taken as taken — do not re-derive or reopen them. When the
document and the code disagree, the code wins; say what differs.

Keep the document living: update it with the `seamless:save` skill as the work proceeds. If its
`date` is before today, the first update rolls it over to today's file.

## 5. When there is no handoff

Use what the session-start context offers — the previous session's last prompt and the files it
edited most recently — to form a hypothesis, and confirm it with the user in one precise question
rather than an open "what were we working on". Once the scope is clear, create a handoff with
`seamless:save` so the next `/clear` resumes from it.
