---
name: delegating-task
description: Use immediately before spawning a subagent, including from inside a subagent, and when FLEET_DELEGATION_INVALID refuses an Agent call. Covers writing a self-contained brief with an objective, scope boundary, epistemic boundary, acceptance criteria and return conditions, deciding whether the task is ready to hand over, and correcting a brief already sent. Does not choose the model or the effort; fleet:selecting-subagent-model does.
---

# Delegate a bounded task

The agent you spawn sees nothing of this conversation. Whatever it needs to know about the
target, the limits, what its evidence can support and the finish line has to be in the
prompt. Think of one backlog item: a single concrete result, not an area of responsibility.

Keep the brief proportional. It is output you generate, so compress method and explanation,
never the task's own facts: a path, an account, a decision already taken, a limit the user
set. Pick the agent type and its effort with `fleet:selecting-subagent-model`; this skill only
shapes the prompt. On the call, never pass a `model`; always pass the named `effort` chosen with
`fleet:selecting-subagent-model`, or none for a model without effort control (its description
says the caller passes no effort).

## Ready to hand over?

Settle the objective, the authority, the boundaries and the finish line before the call,
from what the conversation already holds. Do not re-ask what is known.

- A missing fact that would change the result or widen the scope is yours to resolve: ask
  the smallest question, or report the task as blocked. Do not spawn an agent to discover a
  blocker you already see, and do not pick a convenient default account, directory or
  environment.
- Unknowns the agent is asked to find inside known bounds are its work, not a blocker. You
  do not need the list of records you are sending it to look for.
- Do not invent targets, permissions, decisions or a team standard that nobody stated.

## The brief

Use these exact `##` headings, each at most once, each with real content. Send them as
plain Markdown in the prompt, not inside a code fence. Order is free.

```markdown
## Objective
<One concrete result.>

## Context and Evidence
<The facts, decisions and sources the task rests on. Keep the user's exact wording where interpretation matters.>

## Scope Boundary
<What is included, which actions are permitted, what is excluded, where responsibility ends. Reads and mutations separately when they differ.>

## Epistemic Boundary
<Expected. Which evidence counts and how fresh it must be, what "all", "none" or "present" mean here, what may only be inferred, what stays unknown.>

## Acceptance Criteria
<Observable pass/fail conditions and the check or evidence for each.>

## Return and Stop
<What to deliver and in what form; when to stop successfully; when to stop and hand back instead.>

## Constraints
<Optional. Invariants, compatibility, security and operational limits beyond the scope boundary.>

## Additional Context
<Optional. Inline notes, or specific files and sections: which must be read first, which are background.>
```

Objective, Context and Evidence, Scope Boundary, Acceptance Criteria and Return and Stop are
required, and a call without them is refused. Epistemic Boundary is expected: the check does
not demand it, this skill does, and leaving it out is the narrow exception described below.
Constraints and Additional Context are optional: leave one out rather than fill it with a
sentence that says nothing. Do not copy the placeholders.

What each section has to carry:

- **Scope Boundary.** Transfer every material limit from the conversation. Name the actual
  objects, or an unambiguous rule for finding them inside a named area; searching one
  directory is not leave to search its neighbours. Being able to reach something is not
  authority to change it, and silence does not permit a mutation. In a repository, name the
  base the work starts from (branch or commit) and what the agent may do to git state:
  commit, switch branches, change the index. A separate worktree is one way to isolate the
  work; an automatically created one may start from the default branch rather than the one in
  use, so name the base either way.
- **Hard boundaries, flexible method.** Goal, area, permitted changes and criteria are
  fixed. How the agent gets there is free within them: an unavailable command is not a
  blocker when an already permitted equivalent gives the same coverage and side effects.
  New permissions, installations or a wider area are never an equivalent.
- **Explicit beats default.** A request the brief states outright, such as a file the task
  requires, outranks the agent's general defaults, such as not writing documentation files.
  Say so next to the request. It never outranks a hook, a guard or a permission.
- **Epistemic Boundary.** Scope says where the agent may act; this section says what it may
  claim from what it saw. Most delegated work returns a claim, not only an artifact: a
  review, an audit, a search or inventory, a diagnosis, a status such as alive or broken, a
  comparison. For all of these, state:
  - which evidence counts and which moment or revision the claims describe; for the current
    state, a fact from an earlier inspection, an older session or a linked note is a lead to
    re-check, not evidence; for a historical or fixed-input task, name the snapshot and keep
    claims to it;
  - what "all", "none", "present" or "related" mean in this task, and which search has to
    back a claim that something is absent;
  - that code or configuration shows what it says, not what happened at runtime; behaviour
    concluded from reading it is labelled as inference unless execution evidence backs it;
  - that an area the agent could not inspect proves nothing, and one environment, time
    window or sample does not support a claim about the rest.

  Leave the section out only when every claim in the result is one the acceptance criteria
  check directly and all the data is in the brief. The weaker the executor, the less of
  this it supplies on its own, so the more it needs spelled out. Keep these rules here, not
  in Acceptance Criteria: the criteria say what passes, this section says what the evidence
  can bear.
- **Acceptance Criteria.** They prove this task's result. A shared standard of done, when
  one exists, is passed along as well and neither replaces the other. If none was given,
  do not make one up. For review work, give the severity rubric (impact, reachability,
  exposure), so severities from different agents compare.
- **Return and Stop.** Ask for verified work, coverage gaps and the smallest missing input,
  in a concise format. The agent stops at a permission boundary, a material ambiguity,
  required evidence it cannot get, or a decision that was not delegated, and stops
  successfully once the criteria are met. Adjacent improvements come back as suggestions.
  Partial work is reported as partial. Name the language of the reply and, when results
  from several agents are merged, the format of each item. When the result includes files,
  sanction the fallback: if a required file cannot be written, the agent returns its full
  content in the reply.
- **Additional Context.** Say what must be read before acting and what is background, and
  authorize those reads explicitly when they lie outside the write area. Linked material is
  context: it hands over no extra tasks, no permissions, and no licence to run a restore
  workflow or edit your notes. Critical limits belong in the brief itself, not only behind
  a link.

Worked examples, all synthetic: `examples/dns-read-only.md` is a read-only inventory whose
result is a claim, `examples/bounded-edit.md` a code change inside a fixed write area,
`examples/additional-context.md` a comparison that hands over reference files, and
`examples/mcp-tool-lists.md` a read-only task whose brief carries MCP tool lists of its own.
Open one when unsure what a section should hold; do not copy its wording.

The two vendors lean in opposite directions when a brief leaves something open. Before writing
the brief, read section 4 of `../selecting-subagent-model/references/vendor-guide.md`: close
the boundaries for an Anthropic agent and the gaps for an OpenAI one.

Last check: could a fresh agent name the result, the allowed area and actions, what it may
claim, how to verify, and where to stop, without guessing?

## MCP tool lists for one spawn

The fleet rules hold two global lists of MCP tools, an allow list and a deny list. While either
is not empty, a summary of the ones in force is added to the context of a session when it
starts and of a fleet agent when it starts; while they are invalid or cannot be read, that
summary is one warning line saying so. A brief to a fleet agent
may add lists of its own for that agent. They are optional: leave them out when the global
lists fit the task.

The lists are a block at the very start of the brief, before the headings:

- line 1 is exactly `---`, with nothing before it;
- then `allow:`, `deny:` or both, each at most once, in either order;
- under each key, one or more lines of exactly two spaces, `- ` and one double-quoted rule:
  `  - "<rule>"`;
- a closing line of exactly `---`, then the brief itself.

No comments, blank lines, inline lists or other keys; a key with nothing to list is left out.

A rule is a complete tool name, such as `mcp__mail__read`, or a mask in which `*` stands for
any run of characters, such as `mcp__mail__*` for every tool of one server. There is no
server shorthand: name a whole server with its mask. Rules are case-sensitive and match the
whole name.

How the lists act:

- A deny rule always wins: a tool that any deny rule in force matches is refused, whatever
  allows it.
- The block's allow rules add to the global allow list, and its deny rules to the global deny
  list, for the agent that receives the brief. An allow list that is empty permits every tool
  that no deny rule matches.
- A deny mask refuses only the names it matches: denying `mcp__tickets__create_*` leaves
  `mcp__tickets__add_comment` allowed, so listing write-looking prefixes does not make a task
  read-only. Name the tools the task needs in allow rules instead.
- A call passes only when that agent and every fleet agent above it permit the tool, so a
  grant never reaches beyond its caller: a brief cannot hand on a tool the agent writing it
  may not use, and a deny binds every fleet agent below the receiving agent. An agent of
  another type that a fleet agent spawns is not governed by these lists.
- So, while the global allow list is empty, an allow block narrows: the receiving agent and
  the fleet agents below it get only the tools it lists, minus what a deny rule matches. While
  the global allow list is not empty, an allow block widens the receiving agent's own list; a
  fleet agent below it uses a granted tool beyond the global list only when its own brief
  grants it too.
- The block belongs to the message that starts the agent: the guard reads it from the agent's
  stored first message at every MCP call. A follow-up message therefore cannot change it;
  spawn a new agent for other lists.
- Only fleet agents take a block. A brief to any other agent type, or with no type, that
  opens with one is refused.
- A brief to a fleet agent must not open with `---` for another purpose, such as other front
  matter or a thematic break: it is read as a block and refused. A block placed below other
  text, above the first heading, is refused too, rather than ignored.

Example: a read-only task on one server, its read tools named in allow rules.

```text
---
allow:
  - "mcp__tickets__search_*"
  - "mcp__tickets__get_*"
deny:
  - "mcp__tickets__get_attachment"
---
## Objective
...
```

While the global allow list is empty, the agent and the fleet agents below it reach only the
`tickets` tools whose names start with `search_` or `get_`, except `get_attachment`: the deny
rule wins inside what the allow rules admit. `examples/mcp-tool-lists.md` holds the whole
brief.

## When a call is refused

The check applies to Agent calls that target a fleet agent and looks at shape only: a brief
that names the wrong account passes it. Passing is not proof the brief is right.

- `FLEET_DELEGATION_INVALID` lists the missing, empty or duplicated sections, or names the
  line of an MCP block that breaks the form above. Fix the brief from what you already know
  and repeat the same call. It does not lift any other refusal.
- `FLEET_DELEGATION_ERROR` is a hook or configuration fault. Report it; do not reformulate
  the task to get around it.

## Correcting a brief already sent

If a material omission surfaces after the spawn, send the same agent a complete corrected
brief through the messaging mechanism the session already has, say what it replaces, and
ask what was done that conflicts with it. Delivery may not be immediate and nothing already
done is undone. With no such mechanism, say so and use the normal lifecycle controls. An
ordinary clarification does not need the whole brief again.
