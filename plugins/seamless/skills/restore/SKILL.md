---
name: restore
description: Recover the state of previous work at the start of a session, after /clear, a compaction or a cold start, by reading the project's newest handoff document. Invoke it before asking the user what they were working on, whenever the session-start context lists handoff documents, or when the user refers to earlier work you have no context on.
---

Read the handoff document left by the previous session and continue from it, instead of asking
the user to explain what was going on.

## 1. Find the candidates

If the session-start context injected by this plugin's hook lists `Handoff documents`, start from
that list — it was built at startup from the real filesystem and names the newest file in every
handoff directory that belongs to this project.

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

## 2. Choose one

- **One directory has handoffs** — read its newest document.
- **Several directories do** — do not pick by mtime or by depth; any heuristic eventually picks
  wrong silently. Show the candidates (path, filename date, mtime, first heading) and ask the user
  which one applies. One question costs a line; a wrong guess costs the session.
- A document that another handoff explicitly supersedes is not a candidate.

## 3. Rename old-format files on the way

If the chosen file is named `handoff-<slug>-<YYYY-MM-DD>.md`, rename it to `<YYYY-MM-DD>-<slug>.md`
(`git mv` when tracked, plain `mv` otherwise) and mention the rename. When the slug starts with a
ticket key such as `ABC-123`, keep the key right after the date. Rename only the file you open;
never mass-rename a directory.

## 4. Read and continue

Read the chosen document in full. Follow its references (plans, specs, tickets) only when the next
action needs them.

Then report, briefly: what the work is, where it stopped, what is already proven, what is open and
whose step it is. Continue from the document's next action. Treat facts it marks as verified as
verified, and decisions it marks as taken as taken — do not re-derive or reopen them. When the
document and the code disagree, the code wins; say what differs.

Keep the document living: update it with the `seamless:save` skill as the work proceeds.

## 5. When there is no handoff

Use what the session-start context offers — the previous session's last prompt and the files it
edited most recently — to form a hypothesis, and confirm it with the user in one precise question
rather than an open "what were we working on". Once the scope is clear, create a handoff with
`seamless:save` so the next `/clear` resumes from it.
