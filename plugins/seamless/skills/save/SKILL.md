---
name: save
description: Write or update the handoff document that lets a fresh session continue this work after /clear, a compaction or a restart. Use it as soon as a non-trivial task has a clear scope, again after each finished block of work, when a decision is taken or a blocker appears, and whenever the user says they are about to clear, stop, pause or hand the work over.
argument-hint: "[what the next session should focus on]"
---

Write the state of the current work into a handoff document, so that a session with no memory of
this conversation can continue without asking the user what was going on.

The document is **living**: it is created early and edited in place as the work proceeds. It is
not a summary written at the end, because the end may never come — the user may `/clear` at any
moment, and the point of this skill is that doing so costs nothing.

## Where the document lives

Resolve the target directory explicitly. Never derive it from the shell's current directory; the
shell drifts as commands `cd` around, and a handoff written into a random subdirectory is lost.

1. **`AGENT_WORKING_DIR` is set** (check with `printenv AGENT_WORKING_DIR`): you are inside a
   sandboxed agent container whose `$AGENT_WORKING_DIR/workspace/` is bind-mounted from the host.
   Write to `$AGENT_WORKING_DIR/workspace/handoffs/`. Anything left in the container's temp
   directory dies with the container, which is exactly the moment a handoff is needed most.
2. **Otherwise** write to `<startup directory>/.claude/handoffs/`. The startup directory is, in
   order of preference:
   - the `Startup directory:` line of the session-start context injected by this plugin's hook;
   - the primary working directory stated in the system prompt;
   - the first `cwd` recorded in this session's transcript:
     `jq -r 'select(.cwd) | .cwd' ~/.claude/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl | head -1`.
3. **A sub-project may own its handoff.** If the work is confined to one service or package below
   the startup directory and that directory already has its own `.claude/handoffs/`, update the
   document there. A handoff below the startup directory is normal, not a mistake.

Create the directory if it is missing. Never write the document to the OS temp directory.

## How the file is named

`<YYYY-MM-DD>-<TICKET>-<slug>.md` when the work has a ticket, `<YYYY-MM-DD>-<slug>.md` when it
does not. Date first, so a plain `ls` sorts chronologically. The date is the **creation** date of
the document and does not change when the document is updated; the filename stays stable for the
life of the topic.

One document per topic. Before creating a new file, look for an existing handoff on the same
topic in the target directory (any naming) and update that one instead. If the existing file uses
the older `handoff-<slug>-<YYYY-MM-DD>.md` form, rename it to the current form at this point
(`git mv` when it is tracked, plain `mv` otherwise) and say so.

## When to write

- **Invoked right after `seamless:restore`, at the start of a session:** the session-start
  context asks for this so that the rules above and below are in this session's context before
  it ever edits the document. If nothing has changed since the document was last updated, write
  nothing: confirm the path of the document you will keep updating and carry on with the work.
  Update it only if the restore already revealed something the document does not hold (a step
  the previous session finished after its last update, a fact the code contradicts).
- **Create** the document as soon as the scope of a non-trivial task is clear: perimeter and
  access (accounts, profiles, contexts, hosts, ids), the user's decisions so far, the plan.
- **Update** it once per finished block of work, not after every command: a change applied, a
  service rolled, a decision taken, a blocker that hands a step to the user. Record the result and
  any new identifiers (instance, pipeline, job, commit).
- Before a block that will run long unattended, add an "in progress, resume like this" note
  **before** starting it.
- When the user says they are about to clear, stop or pause, bring the document fully up to date
  and report its path.

## What to write

Write for a reader who knows the domain but did not see this conversation:

- **Current state** in one paragraph: what the work is, where it stopped.
- **What is proven**, with the evidence and identifiers verbatim (paths, ids, versions, commands
  that were run and what they returned).
- **What is broken**, on what, and what has already been ruled out.
- **What is open and whose step it is** — the user's, yours, someone else's.
- **Decisions already taken by the user**, marked so the next session does not reopen them.
- **The remaining plan**, and the exact next action.
- **Suggested skills** the next session should invoke.
- **Superseded handoffs**, named explicitly, when this document replaces older ones.

Do not narrate history beyond what is needed to continue. Do not duplicate what other artifacts
already hold (specs, plans, ADRs, issues, commits, diffs) — reference them by path or URL.
Write in the language the project's documentation uses. Redact secrets, tokens, passwords and
personal data.

If the user passed arguments, treat them as the focus of the next session and shape the document
around it.

Always report the full path of the document you wrote or updated.
