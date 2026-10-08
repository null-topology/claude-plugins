# Task routing — as of 2026-10-08

Which model family to use for a class of work, by the task's complexity. Each cell is computed
from independent, published measurements: benchmarks run by their own operators, never a lab's
numbers about its own models. Cells name a family by its API id; the effort is chosen per task
and is not implied by the table.

| Class | Hard | Normal | Simple | Fallback (other vendor) |
|---|---|---|---|---|
| Implementation | `gpt-6.1-sol` | `gpt-6.1-sol` | `gpt-6-luna` | `claude-sonnet-5-5` |
| Code review — find | `claude-opus-5-5` | `claude-opus-5-5` | `gpt-6.1-sol` | `gpt-6.1-sol` |
| Code review — filter | `gpt-6.1-sol` | `gpt-6.1-sol` | `gpt-6-luna` | `claude-opus-5-5` ¹ |
| Code review — overall | `claude-opus-5-5` | `claude-opus-5-5` | `gpt-6-luna` | `gpt-6.1-sol` |
| Security review | `gpt-6-astra` | `gpt-6-astra` | `gpt-6-luna`* | `claude-opus-5-5` ² |
| Codebase Q&A | `claude-fable-5-1` | `claude-fable-5-1` | `gpt-6-luna` | `gpt-6.1-sol` |
| Terminal / infra | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `gpt-6.1-sol` ³ | `gpt-6-astra` |
| Refactoring | `gpt-6.1-sol` | `gpt-6.1-sol` | `gpt-6-luna` | `claude-sonnet-5-5` |
| Tool workflows | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `gpt-6.1-sol` | `gpt-6.1-sol` |
| Factual | `gpt-6-astra` | `gpt-6-astra` | `claude-haiku-5-5` | `claude-sonnet-5-5` |
| Knowledge work | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` | `gpt-6.1-sol` |
| General | `claude-opus-5-5` | `claude-opus-5-5` | `claude-haiku-5-5` | `gpt-6.1-sol` |

- **Hard**: long, ambiguous or high-stakes work; the family of the best-scoring model.
- **Normal**: the default; the cheapest family within reach of the best score.
- **Simple**: well-scoped, easily verified subtasks and high-volume fan-out; the cheapest family
  that passes the class gate.
- **Fallback**: the strongest family of the other vendor, for when the Hard cell's vendor is
  unavailable.
- The effort level comes from the task, not from the effort at which a model was measured.
- Hard, Normal and Fallback consider only models that pass the class gate and were measured by
  at least two independent sources, unless no model in the class does.
- A numbered note marks a cell whose model fails the class gate or rests on a narrow part of the
  evidence. A **\*** marks a judgment; see Anomalies.
- Not in the table, no measured data: Tests. Use the General row.
- Security work also depends on the account; read "Security work and account access" in
  `../SKILL.md` before using the Security review row.

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

| Class | Independent sources | Signals |
|---|---:|---:|
| Implementation | 5 | 6 |
| Code review — find, filter, overall | 1 | 1–2 |
| Security review | 1 | 1 |
| Codebase Q&A | 1 | 1 |
| Terminal / infra | 2 | 3 |
| Refactoring | 1 | 1 |
| Tool workflows | 2 | 2 |
| Factual | 1 | 2 |
| Knowledge work | 1 | 2 |
| General | 1 | 1 |

A row on one source is one operator's view of the class. Treat its cells as a starting point and
compare pairs in `benchmark.md` when the choice matters. Knowledge work is graded by LLM judges
only, and both of its signals also feed the general Index.

## Notes

¹ Code review — filter · Fallback (other vendor): `claude-opus-5-5@xhigh` does not meet the class gate (precision ≥ 85%: 83.2).
² Security review · Fallback (other vendor): `claude-opus-5-5@max` does not meet the class gate (DeepSecBench precision ≥ 85%: 81).
³ Terminal / infra · Simple: `gpt-6.1-sol@low` rests on 1 of 3 signals.

## Anomalies

A starred recommendation is a judgment, not a measurement, and it rests on a fixed rule: the independent sources that measure the same variants vote, the majority wins, arithmetic (list price × tokens, time × speed) identifies the wrong value, and quality evidence outweighs cost roughly 70/30. The vote for each entry is kept in the anomaly register.

\* Security review · `gpt-6-luna` (A1, open since 2026-09-30): DeepSecBench's price makes Luna medium look like an option for security review, but every source measures xhigh as better and the price inversion does not survive the cross-check. Judgment, not a measurement: for security review use Luna at xhigh or above, not at medium or low.

## Sources

Artificial Analysis ([Intelligence Index](https://artificialanalysis.ai/methodology),
[Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex),
AA-Omniscience, AutomationBench-AA, [AA-Briefcase](https://artificialanalysis.ai/evaluations/aa-briefcase),
[GDPval-AA](https://artificialanalysis.ai/evaluations/gdpval-aa)), Vals AI ([Terminal-Bench 4.0](https://www.vals.ai/benchmarks/terminal-bench-4),
Vibe Code Bench, Code Migration, CyberBench), [MacroscopeBench](https://www.macroscope.com/benchmark),
[Vercel DeepSecBench](https://vercel.com/ai-gateway/leaderboards/deepsecbench), and, through
[Epoch AI's benchmark data](https://epoch.ai/data/benchmark_data.zip), FrontierCode, FrontierSWE,
MirrorCode and APEX-Agents. Figures belong to their operators; follow the links for the numbers.
