# Vendor tendencies: choosing between Anthropic and OpenAI, and briefing each

Reference date **2026-09-30**. Neither vendor is better overall. Which family suits a class of
work is in `task-routing.md`; this guide covers what is left once the class is known: the
tendencies that differ by vendor, how to choose when either would do, and how to brief each so
its tendency does not decide the result.

Read the **Evidence** column before leaning on a row: *measured* rows rest on published figures,
*observed* rows on practice with no independent measurement for this generation.

## 1. Tendencies

| Trait | Anthropic (Fable, Opus, Sonnet, Haiku) | OpenAI (Astra, Sol, Terra, Luna) | Evidence |
|---|---|---|---|
| Turns and output | Many turns and output tokens per task. Helps: long tasks carried to a working end state. Costs: allowance. | Few turns, close to the minimum the task needs. Helps: parallel fan-out. Costs: may omit a required item. | Measured, high. AA Coding Agent Index v1.5 turns per task: Sonnet 5.5 max 265.9, Astra max 39.4. AA attributes GPT-6 regressions on GDPval-AA to deliverables that omit rubric elements. |
| Time per task | Longer at max on the Coding Agent Index. | Shorter at max on the same index. | Measured, medium, one harness per vendor. AA Coding Agent Index v1.5, max effort, minutes per task: Sonnet 5.5 90, Opus 5.5 66, Fable 5.1 34.8, Astra 29.4, GPT-6.1 Sol 24.4, Luna 21.4. Fewer turns or tokens do not imply less wall-clock time in another harness; turns, tokens and time are separate measurements, and only time measured in your own harness predicts your wait. |
| When the brief is silent | Fills the gap and may widen the scope. Follows explicit instructions literally. | More often returns an incomplete result, or stops to ask. Reads a general rule literally and may let it win over an exception the brief states less prominently. | Observed, low. No independent instruction-following measurement for this generation. |
| Refusals and fallback | A request its classifiers flag is refused, or re-run on an older model when fallback is on. | A flagged request is refused explicitly and fails. | Vendor documentation; Vals Terminal-Bench 4.0 (mini-swe-agent): 22 of 198 Opus 5.5 and Fable 5.1 attempts and 4 of 198 Sonnet 5.5 attempts were served by older models. See below. |
| Direction of error (comparable effort, outside security) | Does more than asked: an extra change, an extra finding. | Does less than asked: a missed item, an early finish. | Generalization of the rows above, low. |

**Anthropic fallback in practice.** On the API, a classifier refusal returns
`stop_reason: "refusal"` with a `stop_details.category`; with server-side fallback enabled
(`fallbacks: "default"`), the request is re-run on an older model and `usage.iterations[]` carries
an entry of type `fallback_message`
([docs](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)). Claude Code
falls back automatically by default: it re-runs on the fallback model, shows a notice in the
transcript and continues the session on that model; `switchModelsOnFlag: false` turns this off
([docs](https://code.claude.com/docs/en/model-config)). A result that must come from the named
model is checked for that notice or entry.

## 2. Choose the pair, not the vendor first

Effort moves a model's result as much as the choice of vendor does. MacroscopeBench score, Opus 5.5
against GPT-6 Sol (GPT-6.1 Sol not yet measured there):

| Effort | Opus 5.5 | GPT-6 Sol |
|---|---|---|
| low | 61.4 | 61.8 |
| medium | 70.1 | 69.2 |
| high | 73.1 | 74.3 |
| max | 82.3 | 80.3 |

Low to max moves each model by about 20 points; at the same effort the two differ by 1–2. Compare
model-and-effort pairs, not a vendor and then an effort.

## 3. Choosing a vendor when either would do

1. **Security work depends on the account** (`../SKILL.md`, "Security work and account access").
2. **Ask which costs more for this task: an extra change or a missing one.**
   - An extra change costs more (tight scope, production configuration, minimal diff, final
     filter, a precise specification with tests): OpenAI.
   - A missing piece costs more (an ambiguous task, exploration, the find stage, long work that
     has to reach a working end state): Anthropic.
3. **For a review that matters, run independent first passes on models of both vendors and merge
   the findings.** In practice each vendor's models have found classes of issue the other missed
   (observed, not measured); a merged pass covers at least what either finds alone.
4. When the preferred vendor is unavailable, route to the other and compensate in the brief
   (section 4).

## 4. Briefing each vendor

The brief keeps the headings of `fleet:delegating-task` for both vendors; only the emphasis
differs. For Anthropic, close the **boundaries**; for OpenAI, close the **gaps**. These are cheap
hedges that hold whether or not the observed row in section 1 does.

| Brief element | Anthropic: close the boundaries | OpenAI: close the gaps |
|---|---|---|
| Scope Boundary | Name what must not change; anything else comes back as a suggestion in the report. | Enumerate every object in scope; do not rely on it inferring the rest. |
| Acceptance Criteria | Keep them to what the task needs. | Number them. Done means all N are met; ask for a check of the result against the list before returning. |
| Return and Stop | Stop once the criteria are met; no polishing beyond them. | Do not return before every criterion is met or a stop condition applies. |
| Ambiguity | Record the assumption in the report instead of widening the task. | Give the rule to decide by, record the assumption and continue, unless the ambiguity is a stop condition. |
| Verification | Limit polishing, not verification: every criterion still gets its check. | Ask for verification explicitly, criterion by criterion. |
| Exceptions to a general rule | State the exception where the rule would apply. | State the exception next to the task it applies to and say that it outranks the general rule; a general rule read literally otherwise wins. |
| Review | On the filter stage set a severity threshold and a finding limit. On the find stage do not ask for "confident findings only": it is read literally and lowers recall. | On the find stage ask to keep uncertain findings, marked, rather than drop them. |
| Files to write | Name them as deliverables. | Name them as required deliverables the task explicitly requests, not reports: an agent may decline to write what reads as an optional document. |

For every vendor:

- Claude Code's Write tool refuses a subagent's write to a `.md` file whose name starts with
  REPORT, SUMMARY, FINDINGS or ANALYSIS (any case), so name required files otherwise.
- A named deliverable is still no guarantee that the write succeeds. Sanction the fallback in the
  brief: if a required file cannot be written, the agent returns its full content in the reply and
  the orchestrator saves it.

## Limits

- Tendencies are vendor-level and hold across the models named above only where the evidence says
  so; one model can deviate.
- The Macroscope figures in section 2 are GPT-6 Sol's; GPT-6.1 Sol has not been measured by that
  source. The observed rows have no measurement.
- Refresh this guide with the benchmark; until then treat its figures as dated.
