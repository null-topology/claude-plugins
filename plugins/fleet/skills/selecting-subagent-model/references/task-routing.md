# Task routing — as of 2026-11-18

Which model family to use for a class of work, by the task's complexity, and which family replaces it
when it is unavailable. Each cell is computed from independent, published measurements: benchmarks run
by their own operators, never a lab's numbers about its own models. Artificial Analysis is the primary
source wherever it measures the class; the other sources are cross-checks there. Cells name a family by
its API id; the effort is chosen per task and is not implied by the table. Security work also depends
on the account; read "Security work and account access" in `../SKILL.md` before using the Security
review row.

## Anthropic + OpenAI

| Class | Hard | Normal | Simple |
|---|---|---|---|
| Implementation | `claude-fable-5-2` → `gpt-6.2-sol` → `gpt-6.1-sol` | `claude-fable-5-2` → `gpt-6.2-sol` → `gpt-6.2-astra` | `gpt-6.2-sol` → `gpt-6.2-astra` → `gpt-6.1-sol` |
| Code review — find | `claude-opus-5-5` → `gpt-6.1-terra` → `gpt-6.1-sol` ¹ | `claude-opus-5-5` → `gpt-6.1-terra` → `gpt-6.1-sol` ¹ | `gpt-6.1-terra` → `gpt-6.1-sol` → `claude-fable-5-2` ¹ |
| Code review — filter | `gpt-6.1-sol` → `gpt-6-astra` → `gpt-6.1-terra` ²,³ | `gpt-6.1-sol` → `gpt-6-astra` → `gpt-6-luna` ²,³ | `gpt-6-luna` → `gpt-6.1-sol` → `gpt-6.1-terra` ² |
| Code review — overall | `gpt-6.1-terra` → `claude-opus-5-5` → `gpt-6.1-sol` ⁴ | `gpt-6.1-terra` → `gpt-6.1-sol` → `claude-fable-5-2` ⁴ | `gpt-6-luna` → `gpt-6.1-sol` → `gpt-6.1-terra` ⁴ |
| Security review | `gpt-6.2-astra` → `gpt-6.2-sol` → `gpt-6.1-sol` | `gpt-6.2-astra` → `gpt-6.2-sol` → `gpt-6.1-sol` | `gpt-6-luna`* → `gpt-6.1-sol` → `gpt-6.2-sol` ⁵ |
| Codebase Q&A | `claude-fable-5-2` → `gpt-6.1-sol` → `gpt-6-astra` ⁶,⁷ | `gpt-6.1-sol` → `claude-fable-5-2` → `gpt-6.2-astra` ⁶ | `gpt-6.2-sol` → `gpt-6.2-astra` → `gpt-6.1-sol` |
| Terminal / infra | `gpt-6.2-astra` → `claude-sonnet-5-5` → `claude-fable-5-2` | `gpt-6.2-sol` → `gpt-6.2-astra` → `gpt-6-astra` | `gpt-6.2-sol` → `gpt-6.1-terra` → `gpt-6.1-sol` |
| Refactoring | `gpt-6-astra` → `claude-sonnet-5-5` → `gpt-6.1-sol` ⁸,⁹ | `gpt-6.1-sol` → `gpt-6-astra` → `claude-sonnet-5-5` ⁸,⁹ | `gpt-6.1-sol` → `gpt-6-astra` → `claude-sonnet-5-5` ⁸,⁹ |
| Tool workflows | `gpt-6.2-astra` → `claude-fable-5-2` → `gpt-6.2-sol` | `gpt-6.2-sol` → `gpt-6.2-astra` → `claude-fable-5-2` | `gpt-6.1-terra` → `gpt-6.2-sol` → `gpt-6.1-sol` |
| Factual | `claude-fable-5-2` → `gpt-6-astra` → `claude-opus-5-5` ¹⁰ | `claude-fable-5-2` → `gpt-6.1-sol` → `gpt-6-astra` ¹⁰,¹¹ | `claude-haiku-5-5` → `gpt-6.1-terra` → `gpt-6.1-sol` ¹¹ |
| Knowledge work | `claude-opus-5-5` → `claude-sonnet-5-5` → `claude-fable-5-2` | `claude-opus-5-5` → `claude-sonnet-5-5` → `claude-fable-5-1` ¹² | `gpt-6-luna` → `claude-haiku-5-5` → `gpt-6.1-sol` ¹³ |
| General | `claude-fable-5-2` → `gpt-6.2-astra` → `gpt-6.2-sol` | `gpt-6.2-astra` → `claude-fable-5-2` → `gpt-6.2-sol` | `gpt-6.2-sol` → `gpt-6.1-terra` → `gpt-6.1-sol` |

## Anthropic only

| Class | Hard | Normal | Simple |
|---|---|---|---|
| Implementation | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-fable-5-2` → `claude-sonnet-5-5` → `claude-opus-5-5` |
| Code review — find | `claude-opus-5-5` → `claude-fable-5-2` | `claude-opus-5-5` → `claude-fable-5-2` | `claude-fable-5-2` → `claude-opus-5-5` |
| Code review — filter | `claude-fable-5-2` → `claude-opus-5-5` ¹⁴ | `claude-fable-5-2` → `claude-opus-5-5` ¹⁴ | `claude-fable-5-2` |
| Code review — overall | `claude-opus-5-5` → `claude-fable-5-2` | `claude-fable-5-2` → `claude-opus-5-5` | `claude-fable-5-2` → `claude-opus-5-5` |
| Security review | `claude-sonnet-5-5` → `claude-opus-5-5` ¹⁵ | `claude-sonnet-5-5` → `claude-opus-5-5` ¹⁶ | `claude-sonnet-5-5` → `claude-opus-5-5` ¹⁷ |
| Codebase Q&A | `claude-fable-5-2` → `claude-haiku-5-5` ¹⁸ | `claude-fable-5-2` → `claude-haiku-5-5` ¹⁸ | `claude-fable-5-2` |
| Terminal / infra | `claude-sonnet-5-5` → `claude-fable-5-2` → `claude-opus-5-5` | `claude-opus-5-5` → `claude-fable-5-2` → `claude-sonnet-5-5` | `claude-sonnet-5-5` → `claude-opus-5-5` → `claude-fable-5-2` |
| Refactoring | `claude-sonnet-5-5` → `claude-haiku-5-5` ¹⁹ | `claude-sonnet-5-5` → `claude-haiku-5-5` ¹⁹ | `claude-sonnet-5-5` |
| Tool workflows | `claude-fable-5-2` → `claude-sonnet-5-5` → `claude-opus-5-5` | `claude-fable-5-2` → `claude-sonnet-5-5` → `claude-opus-5-5` | `claude-sonnet-5-5` → `claude-opus-5-5` → `claude-fable-5-2` |
| Factual | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-haiku-5-5` → `claude-sonnet-5-5` → `claude-opus-5-5` |
| Knowledge work | `claude-opus-5-5` → `claude-sonnet-5-5` → `claude-fable-5-2` | `claude-opus-5-5` → `claude-sonnet-5-5` → `claude-fable-5-1` ¹² | `claude-haiku-5-5` → `claude-sonnet-5-5` → `claude-opus-5-5` |
| General | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-fable-5-2` → `claude-opus-5-5` → `claude-sonnet-5-5` | `claude-sonnet-5-5` → `claude-opus-5-5` → `claude-fable-5-2` |

## How to read

- Use the table that matches the vendors you can call: Anthropic + OpenAI when both are available, Anthropic only when OpenAI is not.
- **Hard** — long, ambiguous or high-stakes work.
- **Normal** — the default.
- **Simple** — well-scoped, easily verified subtasks and high-volume fan-out.
- **→** — the replacement order. Take the first family your rules allow and that is available now (quota, outage); when one is not, take the next. When the whole chain is unavailable, use the column to its left, then the General row.
- **—** — no model is recommended for this cell.
- The effort level comes from the task, not from the effort at which a model was measured.
- Hard and Normal consider only models that pass the class gate and were measured by at least two independent sources; when none was, the models that pass the gate; when none passes, all.
- Normal is the cheapest model that is at most 10% behind the Hard pick on every signal both were measured on (Elo: 0.10 of rank percentile); Simple is the cheapest model that passes the class gate. Later entries of a chain apply the same rule to the families left.
- A class with a primary source is ranked on that source alone; the other sources are listed under Cross-checks and do not vote.
- **\*** — a source shows an anomaly for this model in this class; see Anomalies.
- Not in the table, no measured data: Tests. Use the General row.

## Mapping a task to a class

| If the subagent will… | Class |
|---|---|
| implement a feature, fix a bug, write non-trivial code in a repo | Implementation |
| review a diff or PR for bugs | Code review: find (surface candidates), filter (confirm and drop noise), or overall (both) |
| review code for vulnerabilities | Security review |
| write or extend tests | Tests (General row) |
| read many files, grep, find usages, answer "where/how is X done", summarise a module | Codebase Q&A |
| run shell work: builds, migrations, Terraform, Kubernetes, CI debugging | Terminal / infra |
| refactor or migrate code between APIs, versions or languages | Refactoring |
| drive multi-step tool or API workflows | Tool workflows |
| answer factual questions where a wrong confident answer is costly | Factual |
| produce office deliverables for a reader: briefs, memos, reports, spreadsheets, slide content, analysis | Knowledge work |
| anything else | General |

## How much evidence each row rests on

| Class | Scored source | Signals | Cross-check sources |
|---|---|---:|---:|
| Implementation | Artificial Analysis | 1 | 4 |
| Code review — find, filter, overall | MacroscopeBench | 1–2 | 0 |
| Security review | Vercel DeepSecBench | 1 | 0 |
| Codebase Q&A | Artificial Analysis | 1 | 0 |
| Terminal / infra | Artificial Analysis | 2 | 1 |
| Refactoring | Vals AI | 1 | 0 |
| Tool workflows | Artificial Analysis | 1 | 1 |
| Factual | Artificial Analysis | 2 | 0 |
| Knowledge work | Artificial Analysis | 2 | 0 |
| General | Artificial Analysis | 1 | 0 |

Every row is ranked on one source: one operator's view of the class. Treat its cells as a starting
point and compare pairs in `benchmark.md` when the choice matters. Knowledge work is graded by LLM
judges only, and both of its signals also feed the general Index.

## Notes

¹ Code review — find: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which is not measured by this class's sources.
² Code review — filter: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which is not measured by this class's sources.
³ Code review — filter: `gpt-6-astra` stands in for its successor `gpt-6.2-astra`, which is not measured by this class's sources.
⁴ Code review — overall: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which is not measured by this class's sources.
⁵ Security review: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which ranks lower under this column's rule.
⁶ Codebase Q&A: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which ranks lower under this column's rule.
⁷ Codebase Q&A: `gpt-6-astra` stands in for its successor `gpt-6.2-astra`, which ranks lower under this column's rule.
⁸ Refactoring: `gpt-6-astra` stands in for its successor `gpt-6.2-astra`, which is not measured by this class's sources.
⁹ Refactoring: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which is not measured by this class's sources.
¹⁰ Factual: `gpt-6-astra` stands in for its successor `gpt-6.2-astra`, which ranks lower under this column's rule.
¹¹ Factual: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which ranks lower under this column's rule.
¹² Knowledge work: `claude-fable-5-1` stands in for its successor `claude-fable-5-2`, which ranks lower under this column's rule.
¹³ Knowledge work: `gpt-6.1-sol` stands in for its successor `gpt-6.2-sol`, which ranks lower under this column's rule.
¹⁴ Code review — filter: `claude-opus-5-5@xhigh` does not meet the class gate (precision ≥ 85%: 83.2).
¹⁵ Security review: `claude-opus-5-5@max` does not meet the class gate (DeepSecBench precision ≥ 85%: 81).
¹⁶ Security review: no Normal pick in the Anthropic only scenario; the chain of the column to its left applies.
¹⁷ Security review: no Simple pick in the Anthropic only scenario; the chain of the column to its left applies.
¹⁸ Codebase Q&A: `claude-haiku-5-5@max` does not meet the class gate (SWE-Atlas-QnA ≥ 40%: 34).
¹⁹ Refactoring: `claude-haiku-5-5@max` does not meet the class gate (score < 0.30).

## Cross-checks

Signals from sources other than the class's primary source, ranked the same way and not scored. A cross-check that disagrees with a pick is a reason to read the class's evidence, not to change the pick.

- Implementation (primary: aa): cognition · frontiercode · main score (7 variants) ranks first `claude-opus-5-5@medium`, `gpt-6-astra@max`, `claude-sonnet-5-5@xhigh`, `claude-fable-5-1@medium`, `gpt-6.1-sol@medium`, `claude-haiku-5-5@max`; epoch · mirrorcode · best score (12 variants) ranks first `claude-sonnet-5-5@max`, `claude-opus-5-5@max`, `claude-fable-5-1@max`, `claude-haiku-5-5@max`, `claude-opus-5-5@high`, `gpt-6.1-terra@max`, `claude-fable-5-1@high`; frontierswe · frontierswe · score (6 variants) ranks first `claude-fable-5-2@max`, `gpt-6-astra@max`, `claude-opus-5-5@max`, `claude-sonnet-5-5@max`; vals · programbench · fully resolved (5 variants) ranks first `claude-sonnet-5-5@max`, `gpt-6-astra@max`; vals · vcb 1-100 v1.1 · accuracy (3 variants) ranks first `gpt-6.2-astra@max`; vals · vibe code bench v1.1 · accuracy (11 variants) ranks first `claude-fable-5-2@high`, `claude-sonnet-5-5@max`, `claude-haiku-5-5@max`, `claude-opus-5-5@max`, `claude-fable-5-1@max`, `gpt-6.2-astra@max`, `gpt-6-astra@max`, `gpt-6.1-sol@max`.
- Terminal / infra (primary: aa): vals · terminal-bench 4.0 · accuracy (9 variants) ranks first `claude-fable-5-2@high`, `claude-sonnet-5-5@max`, `gpt-6.2-astra@max`, `gpt-6.2-sol@max`.
- Tool workflows (primary: aa): mercor · apex-agents · pass@1 (9 variants) ranks first `claude-sonnet-5-5@max`, `claude-opus-5-5@max`, `gpt-6.1-terra@max`, `gpt-6.1-sol@max`.

## Anomalies

A starred recommendation is a judgment, not a measurement, and it rests on a fixed rule: the independent sources that measure the same variants vote, the majority wins, arithmetic (list price × tokens, time × speed) identifies the wrong value, and quality evidence outweighs cost roughly 70/30. The vote for each entry is kept in the anomaly register.

\* Security review · `gpt-6-luna` (A1, open since 2026-09-30): DeepSecBench's price makes Luna medium look like an option for security review, but every source measures xhigh as better and the price inversion does not survive the cross-check. Judgment, not a measurement: for security review use Luna at xhigh or above, not at medium or low.

## Sources

Artificial Analysis ([Intelligence Index](https://artificialanalysis.ai/methodology),
[Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex),
AA-Omniscience, AutomationBench-AA, [AA-Briefcase](https://artificialanalysis.ai/evaluations/aa-briefcase),
[GDPval-AA](https://artificialanalysis.ai/evaluations/gdpval-aa)), Vals AI ([Terminal-Bench 4.0](https://www.vals.ai/benchmarks/terminal-bench-4),
Vibe Code Bench, [Code Migration v1.1](https://www.vals.ai/benchmarks/code-migration-v1-1),
[VCB 1-100 v1.1](https://www.vals.ai/benchmarks/vcb-1-100-v1-1), ProgramBench), [MacroscopeBench](https://www.macroscope.com/benchmark),
[Vercel DeepSecBench](https://vercel.com/ai-gateway/leaderboards/deepsecbench), and, through
[Epoch AI's benchmark data](https://epoch.ai/data/benchmark_data.zip), FrontierCode, FrontierSWE,
MirrorCode and APEX-Agents. Figures belong to their operators; follow the links for the numbers.
