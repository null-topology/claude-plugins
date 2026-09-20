---
name: selecting-subagent-model
description: Use when choosing or revising a sub-agent model and reasoning effort for an assigned task. Covers task suitability, uncertainty, verification, latency, and benchmark comparisons under subscription-based execution.
---

# Selecting a sub-agent model and reasoning effort

Choose a suitable model and reasoning effort for the assigned task. First satisfy its capability requirements; then compare appropriate alternatives using evidence about quality, latency, and avoidable rework. This skill guides selection without prescribing a new agent lifecycle, task taxonomy, or decision format.

The fleet this skill selects from: GPT-6 Astra, Claude Fable 5.1 (top tier); Claude Opus 5, GPT-5.6 Sol (middle); GPT-5.6 Luna (bottom). Use the model and effort options exposed by the actual invocation tool; the agent descriptions there state each rung's role and are kept in agreement with this document.

## Selection policy

- **Max is allowed only for GPT-5.6 Luna.** For every other model, consider an appropriate lower effort or another eligible model. Luna max is an option when the task needs it, not a default.
- **Low is allowed only for GPT-6 Astra, Claude Opus 5, and Claude Fable 5.1.** Sol is explicitly excluded. Permission to use low does not override a stricter requirement attached to the assigned work.
- **Luna medium requires caution.** Prefer high unless the work is simple, fully specified, reversible, and independently checkable for correctness and completeness. Explain why medium is sufficient in the existing declaration. Format validation alone is not enough. Unclear requirements or weak verification are reasons to avoid medium.
- Keep the existing task constraints: complex development requires at least Opus high; architecture requires Astra/Fable medium or above. These are capability requirements for the assigned work, not a taxonomy of agent roles. Do not infer cross-model developer equivalence from equal AA scores alone.
- Use the model and effort options exposed by the actual invocation tool. This document supplies selection judgment rather than duplicating parameter validation.
- If no available pair satisfies the assigned constraints, report the mismatch through the existing workflow. Do not silently lower the required capability.

## Fleet constraints

These come from observed experience with this fleet. No benchmark exposes them, and they apply before any benchmark comparison.

- **GPT-5.6 Sol is not for complex development.** It does not reliably anticipate the bottlenecks such work has to be designed around. Use Sol for review, research, and test work. A review curated by Sol at high or above, fanning findings out to micro-agents on Luna at xhigh or max, is a proven pattern; Sol at medium does not hold the curator role.
- **Claude Fable 5.1 draws on a separate capacity pool.** Prefer GPT-6 Astra when it is available, then Claude Opus 5 at high when that is enough, and take Fable when the work needs the top tier on an Anthropic model. This is a capacity constraint, not a price argument.
- **On the top tier (Astra, Fable), effort tracks complexity, not size.** Both hold volume at every effort, so a large but straightforward task is a legitimate low. Raise effort for interacting parts, real decision points, and easy-to-miss details, not for file count or prompt length.
- **Either vendor may be unavailable, and each ladder is complete on its own.** When one side is down, route within the other side without lowering the task's floors; a cross-vendor substitution below is a routing candidate for a live task, never a reason to treat a rung as redundant.
- **Code review runs below the implementation rung.** Review of code written by a subagent goes to Claude Opus 5 one effort rung below the effort the code was written at (floor: low), or to GPT-5.6 Sol at that Opus review rung plus one (floor: medium, since Sol low is prohibited). The rule keys on the implementation effort alone, whichever model wrote the code (Opus, Astra, or Fable). Never review at the implementation rung or above, and never on Astra or Fable.

  | Code written at (any model) | Review on Opus | Review on Sol |
  |---|---|---|
  | xhigh | high | xhigh |
  | high | medium | high |
  | medium | low | medium |
  | low | low (floor) | medium (floor) |

- **Sol runs one effort rung above the equivalent Opus rung** for the work Sol is allowed to do (review, research, tests): Sol high stands in for Opus medium, Sol xhigh for Opus high. This is an observed equivalence for this fleet, not a benchmark reading.

## Subscription boundary

Execution uses a subscription. The subscription plan and its effective economics are not visible from inside the session. Do not infer the plan, remaining allowance, marginal call price, quota consumption, or monetary savings from model names, tokens, or AA API prices.

AA cost/task is a historical comparative benchmark signal only. It is not the cost of a sub-agent invocation, a subscription budget, or a conversion into subscription usage. Do not calculate dollar objectives, failure probabilities, cache-write charges, or monetary error costs for routing. Do not claim a cheaper AA point saves subscription money or allowance.

Prefer sufficient capability, dependable completion, useful response time, and less avoidable rework. Respect limits actually supplied by the surrounding workflow without inventing hidden financial constraints.

## Decision process

1. Read the assigned task and expected result. Identify the reasoning it requires and what can be independently verified. Judge the actual work, not an agent label, prompt length, or file count.
2. Apply explicit task requirements, the fleet constraints, and the effort policy first. Benchmark advantages cannot override them.
3. Assess complexity and uncertainty qualitatively: mechanical work versus nontrivial reasoning; complete inputs versus missing or contradictory evidence; local context versus interacting dependencies. Do not turn these observations into an invented weighted score or AA cutoff.
4. Consider the consequences of an incorrect result and how likely the verification method is to expose it. Weak verification or costly mistakes favor a more capable eligible pair and stronger checking, not merely more retries.
5. Prefer relevant observed performance on comparable work. Use the dated benchmark as a secondary comparison when local evidence is absent. A general intelligence score is neither task competence nor success probability.
6. Compare a higher effort on the current model with a stronger model at lower permitted effort. Prefer the pair supported by task evidence; use benchmark substitutions below as candidates, not automatic replacements.
7. Consider observed time to a usable, checked result. Output tokens/s alone omits reasoning latency, tools, and rework. When end-to-end timing is unknown, say so instead of manufacturing an estimate.
8. State the chosen model and effort with a concise reason in the existing orchestration format. Explain material uncertainty or a non-obvious trade-off; do not create a separate decision contract or repeat information already recorded.

## Benchmark reference and limitations

Benchmark: **Artificial Analysis Intelligence Index v4.3**, reference date **2026-09-12**. Treat the values below as historical routing priors, not live measurements or availability guarantees. Independent verification of every entry is not established; retain the uncertainty and conflicts documented below. Only models present in the fleet are listed.

Each cell: **Index / USD per AA task / output tokens per second**. All values belong to v4.3 only. `‡` marks provisional promotional economics. Prohibited low/max entries and caution-only medium entries are retained as historical evidence, not routing permissions.

| Model | low | medium | high | xhigh | max — only Luna eligible |
|---|---|---|---|---|---|
| GPT-5.6 Luna | 22 / .01 / 105 | 25 / .02 / 104 | 32 / .04 / 102 | 35 / .09 / 116 | 38 / .18 / 116 |
| GPT-5.6 Sol‡ | 34 / .26 / 55 | 39 / .50 / 57.5 | 42 / .81 / 60 | 44 / 1.18 / 61 | 47 / 1.99 / 59.6 |
| GPT-6 Astra | 46 / .82 / 51.2 | 50 / 1.54 / 49.9 | 51 / 1.72 / 48.5 | 53 / 2.31 / 53.4 | 53 / 3.26 / 53.9 |
| Claude Opus 5 | 40 / 1.10 / 48 | 45 / 2.19 / 49 | 48 / 3.61 / 50 | 50 / 4.88 / 52 | 51 / 5.86 / 50 |
| Claude Fable 5.1 | 47 / 2.37 / 46.6 | 49 / 2.98 / 56.2 | 51 / 3.91 / 49 | 53 / 5.98 / 60 | 53 / 7.63 / 65.4 |

Preserve these caveats when using the data:

- **Fable safety fallback:** Evaluation includes Anthropic's default fallback; approximately 4% of output tokens across the index came from Opus 4.8/Opus 5. The per-effort share is unknown. This measures a fallback-enabled configuration, not pure Fable; do not disable safeguards for comparison. If runtime fallback differs or is unknown, reduce comparability.
- **Cache pricing is excluded from the benchmark cost comparison.** Historical cache-read rates are .25 USD/M for Fable and 1.00 USD/M for Astra. These historical rates may narrow the gap at high cache hit rates, but cannot establish a Fable win without full input/output/cache-write/cache-read accounting.
- **Promotion provisional:** Sol 4/20 USD/M is stated to run through at least 2026-11-21, but the repricing step embedded in AA cost is ambiguous. Treat this price as provisional benchmark context, not a subscription charge; do not assume the promotion automatically ends on that exact date.
- Speed and TTFT are rolling metrics, with reported snapshot variation of 10–15%. Complete per-variant TTFT is unavailable. Fable max has approximately 295 s and Astra max approximately 340 s to first token; neither adds Index over xhigh. Higher tokens/s does not guarantee a faster verified answer.
- Non-reasoning cost is unpublished; quality scores are preliminary. Astra non-reasoning has a 45/48 conflict. Never replace missing values with zero.
- When AA version, model, price, fallback, or harness changes, refresh the comparable dataset as a whole. Until refreshed, retain old values with their date and reduced confidence; do not call them current.

## Benchmark substitutions

For comparable AA measurements, B dominates A on the benchmark's cost/Index axes when its Index is no lower and its API cost/task is no higher, with at least one strict improvement. That establishes neither subscription savings nor task-specific dominance. Apply the selection policy, the fleet constraints, and assigned constraints before considering any replacement.

The historical measured frontier includes Luna low through max, Sol medium/high, and Astra low through xhigh. The eligible set differs: Luna low is prohibited, Luna medium is caution-only, and task constraints may remove other points. Unknown latency or conflicting evidence cannot establish dominance on those dimensions.

| Pair to replace | Preferred substitute to evaluate | Snapshot basis |
|---|---|---|
| Sol low | Luna xhigh | 35/.09 instead of 34/.26; Sol low is prohibited anyway |
| Sol xhigh | Astra low | 46/.82 instead of 44/1.18 |
| Sol max | Astra medium | Strict AA substitution: 50/1.54 instead of 47/1.99; Sol max is prohibited anyway |
| Sol max | Astra low **or** Fable low | Astra 46/.82 loses 1 Index; allowed only if the floor still holds. Fable 47/2.37 preserves Index but costs more and sits behind Astra on capacity priority |
| Opus low / medium / high / xhigh | Astra low / low / medium / medium | Respectively ≥Index and cheaper; check Claude-specific requirements |
| Opus max | Astra high or Fable high | Same 51; 1.72 or 3.91 instead of 5.86; Opus max is prohibited anyway |
| Fable low / medium / high / xhigh | Astra medium / medium / high / xhigh | ≥Index at lower cost and consistent with the Fable capacity priority; reassess cache, fallback, and specialization |
| Fable max / Astra max | Its own xhigh | Same 53 at lower cost; max prohibited by policy |

Do not choose a model merely from tokens/s or reject a suitable model merely because its benchmark API cost is higher. Prefer relevant evidence about quality, completion time, and rework. General benchmark dominance does not establish task-specific suitability or subscription savings.

## Revising a selection

- Diagnose an unsatisfactory result before changing the pair. Missing evidence or unavailable tools require better inputs or access, not extra reasoning effort.
- When the reasoning itself is inadequate, compare a higher permitted effort with a more capable eligible model. Do not automatically walk every effort level or repeat an unchanged request expecting competence to improve.
- Preserve the surrounding workflow's retry and stop rules. This skill does not create independent attempt counts, budgets, status enums, or approval flows.
- A cheaper benchmark point is not sufficient reason to downgrade. Lower effort only when the assigned work and verification support it, preserving all task constraints. Luna medium still requires caution after successful higher-effort runs.
- Use comparable observed outcomes to improve future choices. Do not invent numerical confidence or subscription savings from a small number of successes.

## Examples

| Assigned situation | Selection judgment |
|---|---|
| Simple extraction with a complete independent content check | Luna medium may be justified; otherwise prefer Luna high. Schema validity alone is insufficient |
| Sol low proposed for an easy task | Exclude low; Sol is outside the low allowlist |
| Sol proposed for a feature that has to be designed around a bottleneck | Exclude Sol regardless of its Index; route to Astra or Fable, or Opus at high or above |
| A review of a large change | Sol at high or above curating, findings fanned out to Luna xhigh/max micro-agents; not a single large reviewer |
| Review of code a subagent wrote at Opus high (or Astra/Fable high) | Opus medium or Sol high; not Opus high, not the model that wrote it at the same effort, never Fable |
| Sol max proposed | Evaluate Astra medium to preserve or improve benchmark Index; Astra low loses an Index point, and Fable low costs more on the benchmark. Apply task requirements first |
| Fable proposed while Astra is available | Prefer Astra, then Opus high if that is enough; Fable when the work needs the top tier on an Anthropic model |
| Large but straightforward top-tier task (many files, clear steps, no decision points) | Astra or Fable at low; size alone does not raise effort |
| Complex development | Preserve the Opus high minimum; do not substitute Astra medium solely because of AA scores |
| Architectural work | Preserve Astra/Fable medium minimum regardless of prompt length |
| Only unsupported or below-floor pairs are available | Report the constraint through the existing orchestration workflow |
| A result failed because an input file was absent | Obtain the missing input rather than increase effort to guess its contents |
| A cache-heavy invocation | Do not compute subscription charges from API cache prices; use observed suitability and completion time |
| Faster token output but no end-to-end timing | Treat completion-time advantage as unknown |

## Compact selection instructions

Read the assigned task and acceptance criteria. Apply task constraints, the fleet constraints, the low allowlist, the Luna-only max rule, and caution for Luna medium. Judge complexity, uncertainty, verification, and consequences qualitatively; on the top tier let complexity, not size, set the effort. Prefer comparable task evidence; use AA figures only as dated secondary evidence. Compare model changes with effort changes. Do not infer subscription economics. Express the choice in the existing orchestration format. Leave parameter validation and execution control to the invocation tools.
