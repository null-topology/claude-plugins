# Vendor tendencies: choosing between Anthropic and OpenAI, and briefing each

Reference date **2026-09-29**. Neither vendor is better overall. Each has tendencies that help
on some tasks and hurt on others, and each ladder is complete on its own. This guide says which
tendency a task can afford and how to brief each vendor so its tendency does not decide the
result. It does not override the selection policy, the fleet constraints or a task's floors in
`../SKILL.md`.

Read the **Evidence** column before leaning on a row: *measured* rows rest on published
benchmark figures, *observed* rows on practice with no independent measurement for this
generation. Review and security figures were measured on GPT-6 Sol; GPT-6.1 Sol has not been
measured by those sources yet.

## 1. Tendencies

| Trait | Anthropic (Opus, Sonnet, Fable) | OpenAI (Astra, Sol, Luna) | Evidence |
|---|---|---|---|
| Work volume | Many turns and output tokens per task. Helps: long tasks carried to a working end state. Costs: time and allowance. | Few turns, the minimum the task needs. Helps: fast, cheap, parallel. Costs: may omit a required item. | Measured, high. AA Coding Agent Index v1.5: Sonnet 5.5 max 265.9 turns per task, Astra max 39.4. AA Intelligence Index v4.3.2 output tokens per task at max: Opus 5.5 119k, Sol 31k, Astra 27k. AA attributes GPT-6 regressions on GDPval-AA to deliverables that omit rubric elements. |
| When the brief is silent | Fills the gap and may widen the scope. Follows explicit instructions literally. | More often returns an incomplete result. Whether it stops to ask is not established. | Observed, low. No independent instruction-following measurement for this generation. |
| General code review | Finds more, with more noise: suits the find stage. | Less noise, slightly fewer findings: suits the filter stage. | Measured, medium: one operator (a review-product vendor), two generations. MacroscopeBench recall / precision: Opus 5.5 max 80.6 / 84.0, Sol max 73.8 / 88.0, Astra max 67.8 / 91.7. |
| Security review | Finds less, less precisely; part of the work is refused or re-run on an older model. | Finds more, more precisely. | Measured, medium: one operator. DeepSecBench precision: Sol xhigh 96.0, Opus 5.5 max 81.0; recall derived from the published F2 and precision: about 35.8 and 22.8. |
| Refusals | Flagged requests are re-run on an older model. The answer text does not show it; the `model` field of the subagent transcript does. | Flagged requests are blocked explicitly. | Vendor documentation; Vals Terminal-Bench 4.0: 30 of 198 Opus 5.5 attempts were served by older models. |
| Direction of error (comparable effort, outside security) | Does more than asked: an extra change, an extra finding. | Does less than asked: a missed item, an early finish. | Generalization of the rows above, medium. |

## 2. Effort before vendor

Within one vendor, effort moves the result more than the choice of vendor does at the same
effort. MacroscopeBench score, current generation:

| Effort | Opus 5.5 | GPT-6 Sol |
|---|---|---|
| low | 61.4 | 61.8 |
| medium | 70.1 | 69.2 |
| high | 73.1 | 74.3 |
| max | 82.3 | 80.3 |

Low to max moves each vendor by about 20 points; at the same effort the vendors differ by 1–2.
Set the effort from the task's complexity first, then choose the vendor.

## 3. Choosing a vendor

1. **Security review goes to OpenAI**, for both finding and filtering. When it has to run on
   Anthropic, check the served model in the transcript afterwards.
2. **Set the effort** by complexity, under the selection policy.
3. **Ask which costs more for this task: an extra change or a missing one.**
   - An extra change costs more (tight scope, production configuration, minimal diff, final
     filter, a precise specification with tests): OpenAI.
   - A missing piece costs more (an ambiguous task, exploration, the find stage, long work
     that has to reach a working end state): Anthropic.
4. The fleet constraints and task floors still apply. When the preferred vendor is
   unavailable, route to the other and compensate in the brief (section 4).

## 4. Briefing each vendor

The brief keeps the headings of `fleet:delegating-task` for both vendors; only the emphasis
differs. For Anthropic, close the **boundaries**; for OpenAI, close the **gaps**. These are
cheap hedges that hold whether or not the observed row in section 1 does.

| Brief element | Anthropic: close the boundaries | OpenAI: close the gaps |
|---|---|---|
| Scope Boundary | Name what must not change; anything else comes back as a suggestion in the report. | Enumerate every object in scope; do not rely on it inferring the rest. |
| Acceptance Criteria | Keep them to what the task needs. | Number them. Done means all N are met; ask for a check of the result against the list before returning. |
| Return and Stop | Stop once the criteria are met; no polishing beyond them. | Do not return before every criterion is met or a stop condition applies. |
| Ambiguity | Record the assumption in the report instead of widening the task. | Give the rule to decide by, record the assumption and continue, unless the ambiguity is a stop condition. |
| Verification | Limit what to verify. | Ask for verification explicitly. |
| Review | On the filter stage set a severity threshold and a finding limit. On the find stage do not ask for "confident findings only": it is read literally and lowers recall. | On the find stage ask to keep uncertain findings, marked, rather than drop them. |
| Files to write | Name them as deliverables. | Name them as required deliverables, not reports: an agent may decline to write what reads as an optional report. |

For every vendor: Claude Code's Write tool refuses a subagent's write to a `.md` file whose
name starts with REPORT, SUMMARY, FINDINGS or ANALYSIS (any case), so name required files
otherwise.

## Limits

- Tendencies are vendor-level and hold across the models named above only where the evidence
  says so; one model can deviate.
- Review and security rows rest on one operator each. The observed row has no measurement.
- Refresh this guide with the benchmark; until then treat its figures as dated.
