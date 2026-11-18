# Artificial Analysis Intelligence Index v5.0.1, snapshot 2026-11-18

Historical routing priors, not live measurements. Index is higher-is-better; cost is USD per
benchmark task; est. marks a cost the benchmark did not publish; (provisional) marks a model
whose figures the source marks as preliminary, for example a re-run pending or a cost that does
not yet include a pricing tier; the reason is in the benchmark run's evidence ledger.
Agent type is the call's `subagent_type`, one per model; Effort is the named `effort` the call
passes with it (n/a: the model has no effort control, so the call passes none).
Lists the models the shipped rules (fleet.default.json) mention, at the efforts those rules give
them (every named level for a model they give none); the figures come from models.json.

| Model | Agent type | Effort | Index | $ per task | Index per $ | Output tokens/s |
|---|---|---|---:|---:|---:|---:|
| Claude Fable 5.1 | `fleet:claude-fable-5-1` | low | 39 | 4.47 | 8.7 | 83 |
| Claude Fable 5.1 | `fleet:claude-fable-5-1` | medium | 43 | 5.56 | 7.7 | 85 |
| Claude Fable 5.1 | `fleet:claude-fable-5-1` | high | 47 | 7.54 | 6.2 | 84 |
| Claude Fable 5.1 | `fleet:claude-fable-5-1` | xhigh | 50 | 10.85 | 4.6 | 83 |
| Claude Fable 5.1 | `fleet:claude-fable-5-1` | max | 49 | 12.99 | 3.8 | 91 |
| Claude Opus 5.5 | `fleet:claude-opus-5-5` | low | 35 | 0.98 | 35.7 | 105 |
| Claude Opus 5.5 | `fleet:claude-opus-5-5` | medium | 48 | 2.45 | 19.6 | 106 |
| Claude Opus 5.5 | `fleet:claude-opus-5-5` | high | 52 | 3.46 | 15 | 108 |
| Claude Opus 5.5 | `fleet:claude-opus-5-5` | xhigh | 57 | 6.05 | 9.4 | 109 |
| Claude Opus 5.5 | `fleet:claude-opus-5-5` | max | 59 | 10.04 | 5.9 | 117 |
| Claude Sonnet 5.5 (provisional) | `fleet:claude-sonnet-5-5` | low | 26 | 0.51 | 51 | 135 |
| Claude Sonnet 5.5 (provisional) | `fleet:claude-sonnet-5-5` | medium | 31 | 0.78 | 39.7 | 137 |
| Claude Sonnet 5.5 (provisional) | `fleet:claude-sonnet-5-5` | high | 42 | 1.64 | 25.6 | 139 |
| Claude Sonnet 5.5 (provisional) | `fleet:claude-sonnet-5-5` | xhigh | 50 | 4.09 | 12.2 | 144 |
| Claude Sonnet 5.5 (provisional) | `fleet:claude-sonnet-5-5` | max | 55 | 10.02 | 5.5 | 148 |
| Claude Haiku 5.5 (provisional) | `fleet:claude-haiku-5-5` | low | 19 | 0.0438 | 433.8 | 215 |
| Claude Haiku 5.5 (provisional) | `fleet:claude-haiku-5-5` | medium | 25 | 0.0918 | 272.3 | 225 |
| Claude Haiku 5.5 (provisional) | `fleet:claude-haiku-5-5` | high | 30 | 0.16 | 187.5 | 227 |
| Claude Haiku 5.5 (provisional) | `fleet:claude-haiku-5-5` | xhigh | 35 | 0.25 | 140 | 237 |
| Claude Haiku 5.5 (provisional) | `fleet:claude-haiku-5-5` | max | 36 | 0.41 | 87.8 | 255 |
| Claude Fable 5.2 | `fleet:claude-fable-5-2` | low | 54 | 3.10 | 17.4 | 112 |
| Claude Fable 5.2 | `fleet:claude-fable-5-2` | medium | 56 | 3.80 | 14.7 | 113 |
| Claude Fable 5.2 | `fleet:claude-fable-5-2` | high | 62 | 9.08 | 6.8 | 110 |
| Claude Fable 5.2 | `fleet:claude-fable-5-2` | xhigh | 62 | 14.83 | 4.2 | 112 |
| Claude Fable 5.2 | `fleet:claude-fable-5-2` | max | 65 | 26.54 | 2.4 | 111 |
| GPT-6 Astra | `fleet:gpt-6-astra` | low | 43 | 1.42 | 30.3 | 46 |
| GPT-6 Astra | `fleet:gpt-6-astra` | medium | 52 | 2.73 | 19 | 46 |
| GPT-6 Astra | `fleet:gpt-6-astra` | high | 55 | 3.24 | 17 | 44 |
| GPT-6 Astra | `fleet:gpt-6-astra` | xhigh | 55 | 3.66 | 15 | 44 |
| GPT-6 Astra | `fleet:gpt-6-astra` | max | 57 | 6.24 | 9.1 | 43 |
| GPT-6.1 Sol | `fleet:gpt-6.1-sol` | low | 35 | 0.16 | 218.8 | 51 |
| GPT-6.1 Sol | `fleet:gpt-6.1-sol` | medium | 46 | 0.36 | 127.8 | 52 |
| GPT-6.1 Sol | `fleet:gpt-6.1-sol` | high | 50 | 0.59 | 84.7 | 51 |
| GPT-6.1 Sol | `fleet:gpt-6.1-sol` | xhigh | 52 | 0.76 | 68.4 | 54 |
| GPT-6.1 Sol | `fleet:gpt-6.1-sol` | max | 55 | 1.27 | 43.3 | 48 |
| GPT-6 Luna | `fleet:gpt-6-luna` | low | 10 | 0.0051 | 1960.8 | 88 |
| GPT-6 Luna | `fleet:gpt-6-luna` | medium | 18 | 0.0422 | 426.5 | 95 |
| GPT-6 Luna | `fleet:gpt-6-luna` | high | 21 | 0.0729 | 288.1 | 94 |
| GPT-6 Luna | `fleet:gpt-6-luna` | xhigh | 23 | 0.10 | 230 | 100 |
| GPT-6 Luna | `fleet:gpt-6-luna` | max | 28 | 0.15 | 186.7 | 103 |
| GPT-6.1 Terra | `fleet:gpt-6.1-terra` | low | 29 | 0.0713 | 406.7 | 60 |
| GPT-6.1 Terra | `fleet:gpt-6.1-terra` | medium | 38 | 0.17 | 223.5 | 63 |
| GPT-6.1 Terra | `fleet:gpt-6.1-terra` | high | 42 | 0.26 | 161.5 | 65 |
| GPT-6.1 Terra | `fleet:gpt-6.1-terra` | xhigh | 45 | 0.40 | 112.5 | 65 |
| GPT-6.1 Terra | `fleet:gpt-6.1-terra` | max | 51 | 0.96 | 53.1 | 69 |
| GPT-6.2 Astra | `fleet:gpt-6.2-astra` | low | 46 | 0.66 | 69.7 | 53 |
| GPT-6.2 Astra | `fleet:gpt-6.2-astra` | medium | 57 | 1.62 | 35.2 | 53 |
| GPT-6.2 Astra | `fleet:gpt-6.2-astra` | high | 60 | 2.07 | 29 | 56 |
| GPT-6.2 Astra | `fleet:gpt-6.2-astra` | xhigh | 62 | 2.52 | 24.6 | 54 |
| GPT-6.2 Astra | `fleet:gpt-6.2-astra` | max | 62 | 4.00 | 15.5 | 53 |
| GPT-6.2 Sol | `fleet:gpt-6.2-sol` | low | 41 | 0.18 | 227.8 | 70 |
| GPT-6.2 Sol | `fleet:gpt-6.2-sol` | medium | 53 | 0.41 | 129.3 | 73 |
| GPT-6.2 Sol | `fleet:gpt-6.2-sol` | high | 55 | 0.56 | 98.2 | 78 |
| GPT-6.2 Sol | `fleet:gpt-6.2-sol` | xhigh | 56 | 0.65 | 86.2 | 81 |
| GPT-6.2 Sol | `fleet:gpt-6.2-sol` | max | 57 | 1.01 | 56.4 | 85 |

## Escalation ladder

Every measured point, cheapest first; a point is a step when its Index beats every cheaper point.
A point off the ladder is dominated on this benchmark: some step reaches at least its Index for no
more cost per task. The general Index is not task competence; the per-class table decides first.

| Step | Model and effort | Index | $ per task |
|---:|---|---:|---:|
| 1 | GPT-6 Luna low | 10 | 0.0051 |
| 2 | GPT-6 Luna medium | 18 | 0.0422 |
| 3 | Claude Haiku 5.5 low | 19 | 0.0438 |
| 4 | GPT-6.1 Terra low | 29 | 0.0713 |
| 5 | GPT-6.1 Sol low | 35 | 0.16 |
| 6 | GPT-6.1 Terra medium | 38 | 0.17 |
| 7 | GPT-6.2 Sol low | 41 | 0.18 |
| 8 | GPT-6.1 Terra high | 42 | 0.26 |
| 9 | GPT-6.1 Sol medium | 46 | 0.36 |
| 10 | GPT-6.2 Sol medium | 53 | 0.41 |
| 11 | GPT-6.2 Sol high | 55 | 0.56 |
| 12 | GPT-6.2 Sol xhigh | 56 | 0.65 |
| 13 | GPT-6.2 Sol max | 57 | 1.01 |
| 14 | GPT-6.2 Astra high | 60 | 2.07 |
| 15 | GPT-6.2 Astra xhigh | 62 | 2.52 |
| 16 | Claude Fable 5.2 max | 65 | 26.54 |

## Substitutions

Each point off the ladder, with the cheapest step whose Index is at least as high.

| Point | Index / $ per task | Substitute on this benchmark | Index / $ per task |
|---|---|---|---|
| GPT-6 Luna high | 21 / 0.0729 | GPT-6.1 Terra low | 29 / 0.0713 |
| Claude Haiku 5.5 medium | 25 / 0.0918 | GPT-6.1 Terra low | 29 / 0.0713 |
| GPT-6 Luna xhigh | 23 / 0.10 | GPT-6.1 Terra low | 29 / 0.0713 |
| GPT-6 Luna max | 28 / 0.15 | GPT-6.1 Terra low | 29 / 0.0713 |
| Claude Haiku 5.5 high | 30 / 0.16 | GPT-6.1 Sol low | 35 / 0.16 |
| Claude Haiku 5.5 xhigh | 35 / 0.25 | GPT-6.1 Sol low | 35 / 0.16 |
| GPT-6.1 Terra xhigh | 45 / 0.40 | GPT-6.1 Sol medium | 46 / 0.36 |
| Claude Haiku 5.5 max | 36 / 0.41 | GPT-6.1 Terra medium | 38 / 0.17 |
| Claude Sonnet 5.5 low | 26 / 0.51 | GPT-6.1 Terra low | 29 / 0.0713 |
| GPT-6.1 Sol high | 50 / 0.59 | GPT-6.2 Sol medium | 53 / 0.41 |
| GPT-6.2 Astra low | 46 / 0.66 | GPT-6.1 Sol medium | 46 / 0.36 |
| GPT-6.1 Sol xhigh | 52 / 0.76 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Sonnet 5.5 medium | 31 / 0.78 | GPT-6.1 Sol low | 35 / 0.16 |
| GPT-6.1 Terra max | 51 / 0.96 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Opus 5.5 low | 35 / 0.98 | GPT-6.1 Sol low | 35 / 0.16 |
| GPT-6.1 Sol max | 55 / 1.27 | GPT-6.2 Sol high | 55 / 0.56 |
| GPT-6 Astra low | 43 / 1.42 | GPT-6.1 Sol medium | 46 / 0.36 |
| GPT-6.2 Astra medium | 57 / 1.62 | GPT-6.2 Sol max | 57 / 1.01 |
| Claude Sonnet 5.5 high | 42 / 1.64 | GPT-6.1 Terra high | 42 / 0.26 |
| Claude Opus 5.5 medium | 48 / 2.45 | GPT-6.2 Sol medium | 53 / 0.41 |
| GPT-6 Astra medium | 52 / 2.73 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Fable 5.2 low | 54 / 3.10 | GPT-6.2 Sol high | 55 / 0.56 |
| GPT-6 Astra high | 55 / 3.24 | GPT-6.2 Sol high | 55 / 0.56 |
| Claude Opus 5.5 high | 52 / 3.46 | GPT-6.2 Sol medium | 53 / 0.41 |
| GPT-6 Astra xhigh | 55 / 3.66 | GPT-6.2 Sol high | 55 / 0.56 |
| Claude Fable 5.2 medium | 56 / 3.80 | GPT-6.2 Sol xhigh | 56 / 0.65 |
| GPT-6.2 Astra max | 62 / 4.00 | GPT-6.2 Astra xhigh | 62 / 2.52 |
| Claude Sonnet 5.5 xhigh | 50 / 4.09 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Fable 5.1 low | 39 / 4.47 | GPT-6.2 Sol low | 41 / 0.18 |
| Claude Fable 5.1 medium | 43 / 5.56 | GPT-6.1 Sol medium | 46 / 0.36 |
| Claude Opus 5.5 xhigh | 57 / 6.05 | GPT-6.2 Sol max | 57 / 1.01 |
| GPT-6 Astra max | 57 / 6.24 | GPT-6.2 Sol max | 57 / 1.01 |
| Claude Fable 5.1 high | 47 / 7.54 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Fable 5.2 high | 62 / 9.08 | GPT-6.2 Astra xhigh | 62 / 2.52 |
| Claude Sonnet 5.5 max | 55 / 10.02 | GPT-6.2 Sol high | 55 / 0.56 |
| Claude Opus 5.5 max | 59 / 10.04 | GPT-6.2 Astra high | 60 / 2.07 |
| Claude Fable 5.1 xhigh | 50 / 10.85 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Fable 5.1 max | 49 / 12.99 | GPT-6.2 Sol medium | 53 / 0.41 |
| Claude Fable 5.2 xhigh | 62 / 14.83 | GPT-6.2 Astra xhigh | 62 / 2.52 |
