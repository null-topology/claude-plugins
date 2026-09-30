# Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-30

Historical routing priors, not live measurements. Index is higher-is-better; cost is USD per
benchmark task; est. marks a cost the benchmark did not publish; (provisional) marks a model
whose figures the benchmark has announced it will re-run. Generated from models.json.

| Model | Effort | Index | $ per task | Index per $ | Output tokens/s |
|---|---|---:|---:|---:|---:|
| Claude Fable 5.1 | low | 47 | 2.37 | 19.8 | 48 |
| Claude Fable 5.1 | medium | 49 | 2.98 | 16.4 | 50 |
| Claude Fable 5.1 | high | 51 | 3.91 | 13 | 51 |
| Claude Fable 5.1 | xhigh | 53 | 5.98 | 8.9 | 61 |
| Claude Fable 5.1 | max | 53 | 7.63 | 6.9 | 70 |
| Claude Opus 5.5 | low | 42 | 0.55 | 76.4 | 72 |
| Claude Opus 5.5 | medium | 51 | 1.34 | 38.1 | 73 |
| Claude Opus 5.5 | high | 54 | 1.82 | 29.7 | 74 |
| Claude Opus 5.5 | xhigh | 56 | 3.46 | 16.2 | 80 |
| Claude Opus 5.5 | max | 58 | 5.98 | 9.7 | 92 |
| Claude Sonnet 5.5 (provisional) | low | not published | not published | n/a | 87 |
| Claude Sonnet 5.5 (provisional) | medium | 41 | 0.59 | 69.5 | 91 |
| Claude Sonnet 5.5 (provisional) | high | 47 | 1.08 | 43.5 | 93 |
| Claude Sonnet 5.5 (provisional) | xhigh | 52 | 2.74 | 19 | 105 |
| Claude Sonnet 5.5 (provisional) | max | 56 | 7.60 | 7.4 | 139 |
| Claude Haiku 4.5 | n/a | 17 | 0.21 | 81 | 91 |
| GPT-6 Astra | low | 46 | 0.82 | 56.1 | 46 |
| GPT-6 Astra | medium | 50 | 1.54 | 32.5 | 45 |
| GPT-6 Astra | high | 51 | 1.73 | 29.5 | 47 |
| GPT-6 Astra | xhigh | 52 | 2.31 | 22.5 | 48 |
| GPT-6 Astra | max | 53 | 3.26 | 16.3 | 51 |
| GPT-6.1 Sol | low | 42 | 0.13 | 323.1 | 67 |
| GPT-6.1 Sol | medium | 48 | 0.21 | 228.6 | 61 |
| GPT-6.1 Sol | high | 50 | 0.32 | 156.3 | 65 |
| GPT-6.1 Sol | xhigh | 51 | 0.39 | 130.8 | 64 |
| GPT-6.1 Sol | max | 52 | 0.72 | 72.2 | 68 |
| GPT-5.6 Terra | low | 27 | 0.14 | 192.9 | 77 |
| GPT-5.6 Terra | medium | 30 | 0.18 | 166.7 | 77 |
| GPT-5.6 Terra | high | 34 | 0.34 | 100 | 79 |
| GPT-5.6 Terra | xhigh | 38 | 0.63 | 60.3 | 84 |
| GPT-5.6 Terra | max | 42 | 1.40 | 30 | 93 |
| GPT-6 Luna | low | 21 | 0.0045 | 4666.7 | 124 |
| GPT-6 Luna | medium | 29 | 0.02 | 1450 | not published |
| GPT-6 Luna | high | 32 | 0.03 | 1066.7 | 124 |
| GPT-6 Luna | xhigh | 34 | 0.04 | 850 | 131 |
| GPT-6 Luna | max | 37 | 0.07 | 528.6 | 142 |

## Escalation ladder

Every measured point, cheapest first; a point is a step when its Index beats every cheaper point.
A point off the ladder is dominated on this benchmark: some step reaches at least its Index for no
more cost per task. The general Index is not task competence; the per-class table decides first.

| Step | Model and effort | Index | $ per task |
|---:|---|---:|---:|
| 1 | GPT-6 Luna low | 21 | 0.0045 |
| 2 | GPT-6 Luna medium | 29 | 0.02 |
| 3 | GPT-6 Luna high | 32 | 0.03 |
| 4 | GPT-6 Luna xhigh | 34 | 0.04 |
| 5 | GPT-6 Luna max | 37 | 0.07 |
| 6 | GPT-6.1 Sol low | 42 | 0.13 |
| 7 | GPT-6.1 Sol medium | 48 | 0.21 |
| 8 | GPT-6.1 Sol high | 50 | 0.32 |
| 9 | GPT-6.1 Sol xhigh | 51 | 0.39 |
| 10 | GPT-6.1 Sol max | 52 | 0.72 |
| 11 | Claude Opus 5.5 high | 54 | 1.82 |
| 12 | Claude Opus 5.5 xhigh | 56 | 3.46 |
| 13 | Claude Opus 5.5 max | 58 | 5.98 |

## Substitutions

Each point off the ladder, with the cheapest step whose Index is at least as high.

| Point | Index / $ per task | Substitute on this benchmark | Index / $ per task |
|---|---|---|---|
| GPT-5.6 Terra low | 27 / 0.14 | GPT-6 Luna medium | 29 / 0.02 |
| GPT-5.6 Terra medium | 30 / 0.18 | GPT-6 Luna high | 32 / 0.03 |
| Claude Haiku 4.5 | 17 / 0.21 | GPT-6 Luna low | 21 / 0.0045 |
| GPT-5.6 Terra high | 34 / 0.34 | GPT-6 Luna xhigh | 34 / 0.04 |
| Claude Opus 5.5 low | 42 / 0.55 | GPT-6.1 Sol low | 42 / 0.13 |
| Claude Sonnet 5.5 medium | 41 / 0.59 | GPT-6.1 Sol low | 42 / 0.13 |
| GPT-5.6 Terra xhigh | 38 / 0.63 | GPT-6.1 Sol low | 42 / 0.13 |
| GPT-6 Astra low | 46 / 0.82 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Sonnet 5.5 high | 47 / 1.08 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Opus 5.5 medium | 51 / 1.34 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| GPT-5.6 Terra max | 42 / 1.40 | GPT-6.1 Sol low | 42 / 0.13 |
| GPT-6 Astra medium | 50 / 1.54 | GPT-6.1 Sol high | 50 / 0.32 |
| GPT-6 Astra high | 51 / 1.73 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| GPT-6 Astra xhigh | 52 / 2.31 | GPT-6.1 Sol max | 52 / 0.72 |
| Claude Fable 5.1 low | 47 / 2.37 | GPT-6.1 Sol medium | 48 / 0.21 |
| Claude Sonnet 5.5 xhigh | 52 / 2.74 | GPT-6.1 Sol max | 52 / 0.72 |
| Claude Fable 5.1 medium | 49 / 2.98 | GPT-6.1 Sol high | 50 / 0.32 |
| GPT-6 Astra max | 53 / 3.26 | Claude Opus 5.5 high | 54 / 1.82 |
| Claude Fable 5.1 high | 51 / 3.91 | GPT-6.1 Sol xhigh | 51 / 0.39 |
| Claude Fable 5.1 xhigh | 53 / 5.98 | Claude Opus 5.5 high | 54 / 1.82 |
| Claude Sonnet 5.5 max | 56 / 7.60 | Claude Opus 5.5 xhigh | 56 / 3.46 |
| Claude Fable 5.1 max | 53 / 7.63 | Claude Opus 5.5 high | 54 / 1.82 |
