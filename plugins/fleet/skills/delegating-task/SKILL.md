---
name: delegating-task
description: Use immediately before spawning a subagent, including from inside a subagent, and when FLEET_DELEGATION_INVALID refuses an Agent call. Covers writing a self-contained brief with an objective, scope boundary, acceptance criteria and return conditions, deciding whether the task is ready to hand over, and correcting a brief already sent. Does not choose the model; fleet:selecting-subagent-model does.
---

# Delegate a bounded task

The agent you spawn sees nothing of this conversation. Whatever it needs to know about the
target, the limits and the finish line has to be in the prompt. Think of one backlog item:
a single concrete result, not an area of responsibility.

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

## Acceptance Criteria
<Observable pass/fail conditions and the check or evidence for each.>

## Return and Stop
<What to deliver and in what form; when to stop successfully; when to stop and hand back instead.>

## Epistemic Boundary
<Optional. What evidence supports which claims, required coverage, how fresh it must be, what stays unknown.>

## Constraints
<Optional. Invariants, compatibility, security and operational limits beyond the scope boundary.>

## Additional Context
<Optional. Inline notes, or specific files and sections: which must be read first, which are background.>
```

The first five are required. The last three are optional: **leave an optional section out
rather than fill it with a sentence that says nothing.** A tiny task with all its data
inline needs five short sections and no more. Do not copy the placeholders.

What each section has to carry:

- **Scope Boundary.** Transfer every material limit from the conversation. Name the actual
  objects, or an unambiguous rule for finding them inside a named area; searching one
  directory is not leave to search its neighbours. Being able to reach something is not
  authority to change it, and silence does not permit a mutation.
- **Hard boundaries, flexible method.** Goal, area, permitted changes and criteria are
  fixed. How the agent gets there is free within them: an unavailable command is not a
  blocker when an already permitted equivalent gives the same coverage and side effects.
  New permissions, installations or a wider area are never an equivalent.
- **Acceptance Criteria.** They prove this task's result. A shared standard of done, when
  one exists, is passed along as well and neither replaces the other. If none was given,
  do not make one up.
- **Return and Stop.** Ask for verified work, coverage gaps and the smallest missing input,
  in a concise format. The agent stops at a permission boundary, a material ambiguity,
  required evidence it cannot get, or a decision that was not delegated, and stops
  successfully once the criteria are met. Adjacent improvements come back as suggestions.
  Partial work is reported as partial.
- **Epistemic Boundary.** Add it when the answer's reach matters: "all", "related" and
  "none" need an operational meaning; an inference is labelled as one; an area that could
  not be inspected does not prove absence; a local check is not a global claim.
- **Additional Context.** Say what must be read before acting and what is background, and
  authorize those reads explicitly when they lie outside the write area. Linked material is
  context: it hands over no extra tasks, no permissions, and no licence to run a restore
  workflow or edit your notes. An old "verified" is not evidence of the current state.
  Critical limits belong in the brief itself, not only behind a link.

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
