---
name: save
description: Write or update the handoff document that lets a fresh session continue this work after /clear, a compaction or a restart. Invoke it once before starting, continuing or resuming any work in a session that has not invoked it yet, so its rules are loaded. Then use it as soon as a non-trivial task has a clear scope, again after each finished block of work, when a decision is taken or a blocker appears, and whenever the user says they are about to clear, stop, pause or hand the work over.
argument-hint: "[what the next session should focus on]"
---

Write the state of the current work into a handoff document, so that a session with no memory of
this conversation can continue without asking the user what was going on.

The document is **living**: it is created early and edited in place as the work proceeds. It is
not a summary written at the end, because the end may never come — the user may `/clear` at any
moment, and the point of this skill is that doing so costs nothing.

A task keeps **one file per day**: the day's file is edited in place that day, and the first
update on a later day rolls the task over to a new file (see "Rollover" below). Five tasks in one
day give five files; one task over seven days gives seven. Older files stay as history.

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
does not. Date first, so a plain `ls` sorts chronologically. The date is the **day the file
covers** (local date, `date +%F`) and equals the `date` key of its front matter. The slug, and the
ticket key when there is one, stay the same for every daily file of the task; only the date
changes from one file to the next.

Before creating a file, look for the task's existing handoff in the target directory: the same
`task` key in the front matter, the same ticket key or slug in the filename, or, for files
without front matter, the same topic under any naming. Continue that task, today's file or a
rollover from its latest one, instead of starting a parallel one. The task's files stay in the
directory where it started, even when the rules above would resolve to another one today.

Write and edit handoff documents with the Write and Edit tools, not through shell commands: the
session-start hook finds the documents a session kept by reading those tool calls in its
transcript, and keeps only the paths that still exist. A file created any other way is not
listed for the next session, and neither is a file renamed after its last Write or Edit.

**Files in the older `handoff-<slug>-<YYYY-MM-DD>.md` form** are renamed by this skill, one at a
time, and only right before this session first edits that file with Write or Edit (an update on
the day it covers, or the freeze of a rollover). Rename it to `<YYYY-MM-DD>-<slug>.md` (`git mv`
when it is tracked, plain `mv` otherwise), keeping a ticket key such as `ABC-123` right after the
date when the slug starts with one, then make that Edit to the new path in the same session and
say that you renamed it. A rename without a following Edit breaks the chain: the transcript names
only the old path, which no longer exists. Use the new name wherever another file's `previous` or
`next` refers to it. Never rename a file you are not about to edit, and never mass-rename a
directory.

## The contract

Every handoff has the same shape, so that a later session can filter handoffs by their front
matter and find its way through a large one by its headings alone.

**Front matter**, YAML between two `---` lines at the very top of the file:

```yaml
---
task: payment-retries             # stable slug, shared by all daily files of the task
ticket: ABC-123                   # when there is one
date: 2026-09-16                  # the day this file covers; equals the filename date
started: 2026-09-14               # first day of the task
status: active                    # active | frozen | done
previous: 2026-09-15-ABC-123-payment-retries.md   # previous day's file; absent on day one
summary: Retry failed payments with backoff; worker merged, alerting still open
key_points:                       # optional: a few facts worth seeing without opening the body
  - worker retries with exponential backoff, capped at 5 minutes
  - alerting on exhausted retries still open
repos: [services/payments]        # optional: paths or URLs of the perimeter
tags: [payments, worker]          # optional
---
```

- `summary` is one line: what the task is and where it stands. Rewrite it on every update.
- `key_points` is optional: a short YAML list of the facts a reader filtering by front matter
  should see (decisions, results, what is still open). Keep it to a few items and keep it current.
- `previous` and `next` hold file names in the same directory, not paths. `next` names the
  following day's file and is added only when the file is frozen, or when a done task resumes on
  a later day (see "Rollover").
- Set `status: done` when the task is finished; a done file is not rolled over again.

**One H1**, right after the front matter: the whole task in one line, so that the heading alone
says what the document is about.

**H2 sections** with these names, in this order, each omitted when it would be empty:

- `## Current state` — one paragraph: what the work is, where it stopped.
- `## Decisions` — decisions already taken by the user, marked so the next session does not
  reopen them.
- `## Proven` — what is established, with the evidence and identifiers verbatim (paths, ids,
  versions, commands that were run and what they returned).
- `## Broken` — what is broken, on what, and what has already been ruled out.
- `## Open` — what is open and whose step it is: the user's, yours, someone else's.
- `## Plan` — the remaining plan.
- `## Next action` — the exact next action.
- `## Suggested skills` — skills the next session should invoke.
- `## References` — artifacts that hold the rest (specs, plans, ADRs, issues, commits, diffs) by
  path or URL, and superseded handoffs, named explicitly, when this document replaces older ones.

Sub-topics go in H3 (and lower) inside these sections; no other H1 or H2.

## Rollover

Before each update, find the task's latest file in its directory (the highest `date`, else the
filename date). If today's file for the task already exists, because this or another session
already rolled the task over today, edit that file and create no other. Otherwise, before the
first update of the day to a task whose latest file has a `date` before today:

1. **Freeze the old file first.** Edit its front matter: `status: frozen` and
   `next: <new file name>`. Change nothing else in it.
2. **Then write the new file** `<today>-[<TICKET>-]<slug>.md` in the same directory as the old
   file, with the full contract: the same `task`, `ticket` and `started`, `date` set to today,
   `status: active`, `previous` naming the old file. Carry the current state forward and compact
   it: what is still true, still open and still planned moves over; resolved history stays in the
   old file, reachable through `previous`.
3. **From then on edit only the new file** that day.

The order matters. The session-start hook lists the handoffs a session kept, latest touch first,
and the next session restores the first one. Freezing first leaves the new file as the latest
touch, so the next session lands on it directly. Freezing last would put the frozen file first:
the next session would land on it and have to follow its `next` to reach the new file. A reader
can land on a frozen file in other ways too (an older list, a search, a link), and always
follows `next` from it, which is why `status: frozen` and `next` are written in the same edit.

Never edit a frozen file again, except to correct its `next`. A task that is `done` does not roll
over. If the work resumes:

- **The done file is dated today:** set it back to `status: active` and keep editing it. Its
  name is the name of today's file for the task, so a new file would overwrite it.
- **The done file is from an earlier day:** proceed as for a rollover. First edit the done file's
  front matter to add `next: <new file name>`, as for a frozen file, and change nothing else; then
  write today's file with `status: active` and `previous` naming the done file.

**Files without front matter** (written before this contract) are not converted in bulk. Edit
such a file as it is on the day it covers. When it rolls over, give the old file a new front
matter block holding only `status: frozen` and `next: <new file name>`, leave its body untouched,
and write the new file with the full contract.

## When to write

- **Invoked before any work, at the start of a session or right after `seamless:restore`:** the
  plugin's hooks ask for this so that the rules above and below are in this session's context
  before it ever edits the document. If nothing has changed since the document was last updated,
  or no task has a scope yet, write nothing: say which document you will keep updating, or that
  none exists yet, and carry on with the work. Loading the rules is not an update and does not
  trigger a rollover. Update it only if the restore already revealed something the document does
  not hold (a step the previous session finished after its last update, a fact the code
  contradicts).
- **Create** the document as soon as the scope of a non-trivial task is clear: perimeter and
  access (accounts, profiles, contexts, hosts, ids), the user's decisions so far, the plan.
- **Update** it once per finished block of work, not after every command: a change applied, a
  service rolled, a decision taken, a blocker that hands a step to the user. Record the result and
  any new identifiers (instance, pipeline, job, commit). Check the date before the update; roll
  over when the latest file's `date` is before today.
- Before a block that will run long unattended, add an "in progress, resume like this" note
  **before** starting it.
- When the user says they are about to clear, stop or pause, bring the document fully up to date
  and report its path.

## What to write

Write for a reader who knows the domain but did not see this conversation, into the sections of
the contract above.

Do not narrate history beyond what is needed to continue. Do not duplicate what other artifacts
already hold (specs, plans, ADRs, issues, commits, diffs) — reference them by path or URL.
Write in the language the project's documentation uses; the front matter keys and the H2 names
stay as given above. Redact secrets, tokens, passwords and personal data, in the front matter as
well as in the body.

If the user passed arguments, treat them as the focus of the next session and shape the document
around it.

Always report the full path of the document you wrote or updated, and on a rollover the path of
the file you froze.
