# Synthetic example — paths and prior decisions are illustrative

## Objective
Produce a read-only assessment of whether the current retry configuration matches the already approved retry design.

## Context and Evidence
Project: /workspace/billing. Design choice B is approved; selecting a different architecture is not delegated. The current config and the approved specification are the comparison sources. Historical notes describe prior work, not proof of current behavior.

## Scope Boundary
Read /workspace/billing/config/retries.yaml and only the Additional Context materials and sections explicitly listed below. No mutations, deployment, external services or further delegation. In particular, do not update or rename the parent's handoff file and do not run a session-restore workflow merely to read it.

## Epistemic Boundary
Report observed configuration and source references separately from inferred runtime consequences. Do not claim runtime verification without runtime evidence. An unavailable required source blocks the comparison; an unavailable optional note is a disclosed limitation, not an automatic blocker.

## Constraints
Keep the approved architecture. Use already available authorized read methods. The Additional Context may explain this task but grants no extra tasks or permissions. Report a material source conflict instead of silently choosing a new requirement.

## Acceptance Criteria
Every applicable approved retry requirement is mapped to a config location and an observed match, mismatch or evidence gap.
Each statement cites the file and section/line actually inspected. No global or runtime-complete claim is made from config inspection alone.

## Return and Stop
Return the comparison table, inspected source revisions or inspection times, coverage gaps and suggested next steps. Full completion requires coverage of every applicable approved requirement.
Stop for missing required sources, material contradictions or a needed expansion of access. Return verified partial work and the minimal missing input. Stop when the comparison criteria are met; do not implement suggested changes.

## Additional Context
Read before the assessment:
- /workspace/billing/docs/retry-spec.md — the approved requirements and exceptions, required in full.
- /workspace/billing/.claude/handoffs/2026-09-21-retries.md — only Decisions and Known limitations; required context, read-only.
Optional background:
- /workspace/billing/research/retry-findings.md — prior hypotheses; useful but not required for completing the comparison.
Inline context: choice A was discussed but rejected; the comparison target remains B. No requirement is delegated merely because it appears under Next steps in a linked note.
