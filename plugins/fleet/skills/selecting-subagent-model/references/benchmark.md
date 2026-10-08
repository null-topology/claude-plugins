# Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-10-08

Historical routing priors, not live measurements. Index is higher-is-better; cost is USD per
benchmark task; est. marks a cost the benchmark did not publish; (provisional) marks a model
whose figures the source marks as preliminary, for example a re-run pending or a cost that does
not yet include a pricing tier; the reason is in the benchmark run's evidence ledger.
Generated from models.json.

| Model | Effort | Index | $ per task | Index per $ | Output tokens/s |
|---|---|---:|---:|---:|---:|
| Claude Fable 5.1 | low | 47 | 2.37 | 19.8 | 53 |
| Claude Fable 5.1 | medium | 49 | 2.98 | 16.4 | 53 |
| Claude Fable 5.1 | high | 51 | 3.91 | 13 | 58 |
| Claude Fable 5.1 | xhigh | 53 | 5.98 | 8.9 | 60 |
| Claude Fable 5.1 | max | 53 | 7.63 | 6.9 | 68 |
| Claude Opus 5.5 | low | 42 | 0.55 | 76.4 | 79 |
| Claude Opus 5.5 | medium | 51 | 1.34 | 38.1 | 76 |
| Claude Opus 5.5 | high | 54 | 1.82 | 29.7 | 76 |
| Claude Opus 5.5 | xhigh | 56 | 3.46 | 16.2 | 80 |
| Claude Opus 5.5 | max | 58 | 5.98 | 9.7 | 96 |
| Claude Sonnet 5.5 (provisional) | low | 36 | 0.35 | 102.9 | 101 |
| Claude Sonnet 5.5 (provisional) | medium | 41 | 0.48 | 85.4 | 102 |
| Claude Sonnet 5.5 (provisional) | high | 47 | 0.88 | 53.4 | 104 |
| Claude Sonnet 5.5 (provisional) | xhigh | 52 | 2.01 | 25.9 | 107 |
| Claude Sonnet 5.5 (provisional) | max | 56 | 5.46 | 10.3 | 136 |
| Claude Haiku 4.5 | n/a | 17 | 0.28 | 60.7 | 90 |
| Claude Haiku 5.5 (provisional) | low | 29 | 0.02 | 1450 | 175.2 |
| Claude Haiku 5.5 (provisional) | medium | 34 | 0.05 | 680 | 151.1 |
| Claude Haiku 5.5 (provisional) | high | 38 | 0.08 | 475 | 156.6 |
| Claude Haiku 5.5 (provisional) | xhigh | 41 | 0.12 | 341.7 | 185.2 |
| Claude Haiku 5.5 (provisional) | max | 43 | 0.21 | 204.8 | 240.4 |
| GPT-6 Astra | low | 46 | 0.82 | 56.1 | 44 |
| GPT-6 Astra | medium | 50 | 1.54 | 32.5 | 43 |
| GPT-6 Astra | high | 51 | 1.73 | 29.5 | 46 |
| GPT-6 Astra | xhigh | 52 | 2.31 | 22.5 | 45 |
| GPT-6 Astra | max | 53 | 3.26 | 16.3 | 46 |
| GPT-6.1 Sol | low | 42 | 0.13 | 323.1 | 49 |
| GPT-6.1 Sol | medium | 48 | 0.21 | 228.6 | 50 |
| GPT-6.1 Sol | high | 50 | 0.32 | 156.3 | 50 |
| GPT-6.1 Sol | xhigh | 51 | 0.39 | 130.8 | 53 |
| GPT-6.1 Sol | max | 52 | 0.72 | 72.2 | 55 |
| GPT-5.6 Terra | low | 27 | 0.14 | 192.9 | 84 |
| GPT-5.6 Terra | medium | 30 | 0.18 | 166.7 | 94 |
| GPT-5.6 Terra | high | 34 | 0.34 | 100 | 85 |
| GPT-5.6 Terra | xhigh | 38 | 0.63 | 60.3 | 99 |
| GPT-5.6 Terra | max | 42 | 1.40 | 30 | 108 |
| GPT-6 Luna | low | 22 | 0.0045 | 4888.9 | 124 |
| GPT-6 Luna | medium | 30 | 0.02 | 1500 | not published |
| GPT-6 Luna | high | 33 | 0.03 | 1100 | 112 |
| GPT-6 Luna | xhigh | 35 | 0.04 | 875 | 115 |
| GPT-6 Luna | max | 38 | 0.07 | 542.9 | 127 |

## Escalation ladder

Every measured point, cheapest first; a point is a step when its Index beats every cheaper point.
A point off the ladder is dominated on this benchmark: some step reaches at least its Index for no
more cost per task. The general Index is not task competence; the per-class table decides first.

| Step | Model and effort | Index | $ per task |
|---:|---|---:|---:|
| 1 | GPT-6 Luna low | 22 | 0.0045 |
| 2 | GPT-6 Luna medium | 30 | 0.02 |
| 3 | GPT-6 Luna high | 33 | 0.03 |
| 4 | GPT-6 Luna xhigh | 35 | 0.04 |
| 5 | GPT-6 Luna max | 38 | 0.07 |
| 6 | Claude Haiku 5.5 xhigh | 41 | 0.12 |
| 7 | GPT-6.1 Sol low | 42 | 0.13 |
| 8 | GPT-6.1 Sol medium | 48 | 0.21 |
| 9 | GPT-6.1 Sol high | 50 | 0.32 |
| 10 | GPT-6.1 Sol xhigh | 51 | 0.39 |
| 11 | GPT-6.1 Sol max | 52 | 0.72 |
| 12 | Claude Opus 5.5 high | 54 | 1.82 |
| 13 | Claude Opus 5.5 xhigh | 56 | 3.46 |
| 14 | Claude Opus 5.5 max | 58 | 5.98 |

## Substitutions

Each point off the ladder, with the cheapest step whose Index is at least as high.

| Point | Index / $ per task | Substitute on this benchmark | Index / $ per task |
|---|---|---|---|
| Claude Haiku 5.5 low | 29 / 0.02 | GPT-6 Luna medium | 30 / 0.02 |
| Claude Haiku 5.5 medium | 34 / 0.05 | GPT-6 Luna xhigh | 35 / 0.04 |
| Claude Haiku 5.5 high | 38 / 0.08 | GPT-6 Luna max | 38 / 0.07 |
| GPT-5.6 Terra low | 27 / 0.14 | GPT-6 Luna medium | 30 / 0.02 |
| GPT-5.6 Terra medium | 30 / 0.18 | GPT-6 Luna medium | 30 / 0.02 |
| Claude Haiku 5.5 max | 43 / 0.21 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Haiku 4.5 | 17 / 0.28 | GPT-6 Luna low | 22 / 0.0045 |
| GPT-5.6 Terra high | 34 / 0.34 | GPT-6 Luna xhigh | 35 / 0.04 |
| Claude Sonnet 5.5 low | 36 / 0.35 | GPT-6 Luna max | 38 / 0.07 |
| Claude Sonnet 5.5 medium | 41 / 0.48 | Claude Haiku 5.5 xhigh | 41 / 0.12 |
| Claude Opus 5.5 low | 42 / 0.55 | GPT-6.1 Sol low | 42 / 0.13 |
| GPT-5.6 Terra xhigh | 38 / 0.63 | GPT-6 Luna max | 38 / 0.07 |
| GPT-6 Astra low | 46 / 0.82 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Sonnet 5.5 high | 47 / 0.88 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Opus 5.5 medium | 51 / 1.34 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| GPT-5.6 Terra max | 42 / 1.40 | GPT-6.1 Sol low | 42 / 0.13 |
| GPT-6 Astra medium | 50 / 1.54 | GPT-6.1 Sol high | 50 / 0.32 |
| GPT-6 Astra high | 51 / 1.73 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| Claude Sonnet 5.5 xhigh | 52 / 2.01 | GPT-6.1 Sol max | 52 / 0.72 |
| GPT-6 Astra xhigh | 52 / 2.31 | GPT-6.1 Sol max | 52 / 0.72 |
| Claude Fable 5.1 low | 47 / 2.37 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Fable 5.1 medium | 49 / 2.98 | GPT-6.1 Sol high | 50 / 0.32 |
| GPT-6 Astra max | 53 / 3.26 | Claude Opus 5.5 high | 54 / 1.82 |
| Claude Fable 5.1 high | 51 / 3.91 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| Claude Sonnet 5.5 max | 56 / 5.46 | Claude Opus 5.5 xhigh | 56 / 3.46 |
| Claude Fable 5.1 xhigh | 53 / 5.98 | Claude Opus 5.5 high | 54 / 1.82 |
| Claude Fable 5.1 max | 53 / 7.63 | Claude Opus 5.5 high | 54 / 1.82 |
