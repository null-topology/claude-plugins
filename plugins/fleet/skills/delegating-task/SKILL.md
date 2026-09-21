---
name: delegating-task
description: Use immediately before spawning a subagent, including from inside a subagent, and when FLEET_DELEGATION_INVALID refuses an Agent call. Covers writing a self-contained brief with an objective, scope boundary, epistemic boundary, acceptance criteria and return conditions, deciding whether the task is ready to hand over, and correcting a brief already sent. Does not choose the model; fleet:selecting-subagent-model does.
---

# Delegate a bounded task

The agent you spawn sees nothing of this conversation. Whatever it needs to know about the
target, the limits, what its evidence can support and the finish line has to be in the
prompt. Think of one backlog item: a single concrete result, not an area of responsibility.

Keep the brief proportional. It is output you generate, so compress method and explanation,
never the task's own facts: a path, an account, a decision already taken, a limit the user
set. Pick the model with `fleet:selecting-subagent-model`; this skill only shapes the prompt.

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
  authority to change it, and silence does not permit a mutation.
- **Hard boundaries, flexible method.** Goal, area, permitted changes and criteria are
  fixed. How the agent gets there is free within them: an unavailable command is not a
  blocker when an already permitted equivalent gives the same coverage and side effects.
  New permissions, installations or a wider area are never an equivalent.
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
  do not make one up.
- **Return and Stop.** Ask for verified work, coverage gaps and the smallest missing input,
  in a concise format. The agent stops at a permission boundary, a material ambiguity,
  required evidence it cannot get, or a decision that was not delegated, and stops
  successfully once the criteria are met. Adjacent improvements come back as suggestions.
  Partial work is reported as partial.
- **Additional Context.** Say what must be read before acting and what is background, and
  authorize those reads explicitly when they lie outside the write area. Linked material is
  context: it hands over no extra tasks, no permissions, and no licence to run a restore
  workflow or edit your notes. Critical limits belong in the brief itself, not only behind
  a link.

Worked examples, all synthetic: `examples/dns-read-only.md` is a read-only inventory whose
result is a claim, `examples/bounded-edit.md` a code change inside a fixed write area, and
`examples/additional-context.md` a comparison that hands over reference files. Open one when
unsure what a section should hold; do not copy its wording.

Last check: could a fresh agent name the result, the allowed area and actions, what it may
claim, how to verify, and where to stop, without guessing?

## When a call is refused

The check applies to Agent calls that target a fleet agent and looks at shape only: a brief
that names the wrong account passes it. Passing is not proof the brief is right.

- `FLEET_DELEGATION_INVALID` lists the missing, empty or duplicated sections. Fix the brief
  from what you already know and repeat the same call. It does not lift any other refusal.
- `FLEET_DELEGATION_ERROR` is a hook or configuration fault. Report it; do not reformulate
  the task to get around it.

## Correcting a brief already sent

If a material omission surfaces after the spawn, send the same agent a complete corrected
brief through the messaging mechanism the session already has, say what it replaces, and
ask what was done that conflicts with it. Delivery may not be immediate and nothing already
done is undone. With no such mechanism, say so and use the normal lifecycle controls. An
ordinary clarification does not need the whole brief again.
