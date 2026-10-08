---
name: selecting-subagent-model
description: Use when choosing or revising a sub-agent model and reasoning effort for an assigned task, and when the user states which models to use or avoid for some work. Covers the user's standing overrides, the per-class routing table, security work and account access, vendor tendencies, and benchmark comparisons under subscription-based execution.
---

# Selecting a sub-agent model and reasoning effort

Pick a model family for the kind of work from measured evidence, set the effort from the task,
and apply what the user has said about their own fleet. This skill carries data and the rules for
reading it. The only judgment in it is marked as such: a starred cell in the routing table. How a
user wants their fleet used differs between users and is kept as their overrides, not here.

The fleet: Anthropic — Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5,
Claude Haiku 4.5 (retirement not before 2026-10-15); OpenAI — GPT-6 Astra, GPT-6.1 Sol, GPT-5.6 Terra, GPT-6 Luna. Use the model and effort options the
invocation tool actually exposes; the guard's rules decide which pairs a caller may spawn.

## Order of selection

1. **User overrides.** Apply every stored override that names the model, the effort or the kind of
   work (next section). They come before everything below.
2. **The task's own requirements.** A model, an effort or a minimum the task states explicitly.
3. **The routing table.** Map the work to a class and a column in `references/task-routing.md`;
   the cell names a family. For security work, read the account rule below first.
4. **The effort.** Set it from the task: interacting parts, real decision points, easy-to-miss
   details and the cost of a mistake raise it. The table names families only; the effort at which a
   model was measured does not carry over.
5. **Compare pairs when the cell is thin or the class is General.** `references/benchmark.md` has
   the general Index, cost and speed per model and effort, the escalation ladder and the
   substitutions. Compare a higher effort on one model with another model at a lower effort; the
   choice is the pair.
6. **The vendor and the brief.** When the cell's vendor is unavailable, take the Fallback column.
   `references/vendor-guide.md` covers what each vendor's tendencies cost a task and how to brief
   each.
7. **State the choice**: model, effort and a one-line reason, in the orchestration's existing
   format. Name material uncertainty: a thin or starred cell, a conflict with an override.

## User overrides

The user decides how their fleet is used: a model not to use for some work, one to prefer, effort
levels to avoid, what their subscription can sustain. Such a preference outranks the table.

- When the user states one ("do not use X for Y", "use X for Z", "never above high on X"), persist
  it at once, in their words and with the date, wherever later runs in this environment will read
  it: a memory store, the user's or the project's standing instructions, a rules file they keep. If
  nothing in the environment survives the session, tell the user the override lasts for this run
  only.
- Before selecting, read the overrides already stored. Apply them literally, to what they name,
  without widening them.
- When an override conflicts with the table, the override wins; mention the conflict once in the
  stated choice so the user can revisit it.
- An override narrows the choice; it cannot widen what the guard allows. A refused spawn stays
  refused.

## Security work and account access

Anthropic models screen cyber-security requests. Unless the account has Anthropic's access for
security work, a flagged request is refused or served by an older model, depending on the surface
and its fallback setting (`references/vendor-guide.md`, section 1). For security review,
vulnerability research and exploit-related work:

- **The account has that access:** route by the table.
- **It does not, or it is unknown:** prefer the OpenAI family in the row (the cell itself or the
  Fallback column). Ask the user once whether the account has the access and persist the answer as
  an override.
- OpenAI models refuse security work too. Vals CyberBench counts GPT-6.1 Sol's provider refusals,
  60 of 116 tasks, as failures ([Vals](https://www.vals.ai/models/openai_gpt-6.1-sol)). Check a
  security result for refusals before reading a gap in it as an absence of findings.

## Subscription boundary

Execution uses a subscription whose plan and effective economics are not visible from inside the
session. Do not infer the plan, the remaining allowance, the marginal price of a call or monetary
savings from model names, tokens or API prices.

The benchmark's cost per task is a comparative signal from API prices. It is not the cost of a
sub-agent invocation, a budget, or a conversion into subscription usage. Do not compute dollar
objectives or claim that a cheaper point saves allowance. What the user's subscription sustains is
theirs to say, as an override.

## Reading the figures

- Artificial Analysis cost per task includes cache pricing at each model's measured typical cache
  hit rate ([methodology](https://artificialanalysis.ai/methodology)). It remains an API-price
  comparison.
- Anthropic models are measured with Anthropic's default fallback, so their figures include answers
  served by older models. For Fable 5.1 about 4% of output tokens across the v4.3 index came from
  older models; no share is published per effort or for Opus 5.5. Do not disable safeguards to
  compare.
- Speed and time to first token are rolling measurements that vary 10–15% between snapshots.
  Output tokens per second leaves out reasoning time, tool calls and rework; Fable max takes about
  295 s and Astra max about 340 s to the first token (v4.3 figures). When end-to-end time for a task
  is unknown, say so instead of estimating it.
- `null` in `models.json` means not published, never zero. A model marked `provisional` has figures
  the benchmark announced it will re-run.
- The general Index is not task competence. The per-class table decides first; the Index compares
  pairs within what the table leaves open.
- When the benchmark version, a model, a price, the fallback or the harness changes, refresh the
  whole snapshot; until then keep old values with their date and call them dated.

## Revising a selection

- Diagnose an unsatisfactory result before changing the pair. Missing evidence or unavailable tools
  need better inputs or access, not more reasoning effort.
- When the reasoning itself fell short, compare a higher effort on the same model with a more
  capable model. Do not walk every effort level or repeat an unchanged request expecting a better
  answer.
- Keep the surrounding workflow's retry and stop rules; this skill adds no attempt counts, budgets
  or approval flows.
- A cheaper benchmark point is not a reason to downgrade on its own; lower the pair only when the
  work and its verification support it.
- When the user reacts to a result with a standing preference ("not this model for that again"),
  it is an override: persist it.

## Examples

| Situation | Selection |
|---|---|
| Summarise how a module handles retries | Codebase Q&A, Normal: `claude-fable-5-1`; Simple for a narrow lookup: `gpt-6-luna` |
| A security review of a diff on an account without Anthropic's security access | The OpenAI family in the Security row: Astra; for a narrow, easily checked pass, Luna at xhigh or above (starred cell) |
| The Hard cell's vendor is down | The Fallback column of the same row, at an effort set by the task |
| The table says Astra; the user said earlier "no Astra for reviews" | The override wins: take the next family by the table's evidence and mention the conflict |
| Writing tests | Not in the table: the General row, compared by pair in `benchmark.md` |
| A cell rests on one source (see the evidence table) | Take it as a starting point, compare pairs in `benchmark.md`, say the evidence is thin |
| A result failed because an input file was absent | Obtain the input; do not raise the effort to guess its contents |
| A cache-heavy invocation | Do not compute subscription charges from API cache prices |
| Faster token output but no end-to-end timing | Treat the completion-time advantage as unknown |

## Compact selection instructions

Read the stored user overrides and apply them first. Apply the task's explicit requirements. Map
the work to a class and a column in `references/task-routing.md`; for security work, check the
account's access first. Set the effort from the task. When the cell is thin or the class is
General, compare pairs in `references/benchmark.md`. Use the Fallback column when a vendor is
unavailable and brief each vendor per `references/vendor-guide.md`. Persist every new preference
the user states. State the choice in the existing orchestration format.
