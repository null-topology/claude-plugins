# Synthetic example — not an instruction to access a real account

## Objective
List Route 53 record sets whose owner name equals billing.example.com. or ends in .billing.example.com., only in the two named zones.

## Context and Evidence
Example project: Billing. Authorized account ID: 111122223333.
Zone IDs: ZEXAMPLEPUBLIC and ZEXAMPLEPRIVATE. Source: the Route 53 API replies collected during this inspection. The scope covers owner names, not unrelated records that mention the domain in their values.

## Scope Boundary
Verify the active account identity, then read only those two zones and process the returned data locally. No other accounts, zones or DNS providers. No mutations, tool installation, credential changes or further delegation.

## Epistemic Boundary
Claims describe only the inspected zones over the reported collection interval. Record actual coverage and unresolved errors. Incomplete retrieval or access denial does not prove absence. Do not claim a globally complete DNS inventory or an atomic snapshot.

## Constraints
Do not expose credentials. Use only currently authorized read methods. Equivalent permitted methods are acceptable if they preserve complete retrieval, matching semantics and side-effect limits.

## Acceptance Criteria
For each zone, complete retrieval including all pages, or identify the exact coverage gap.
Every reported record matches the owner-name rule. Give the count for each fully inspected zone, including zero, and evidence that traversal reached its end.
Unresolved gaps fail the complete-inventory criterion; partial evidence must be returned as incomplete.

## Return and Stop
Return a table of zone, owner name, type and values, followed by the collection interval, coverage evidence and limitations. Full completion requires every acceptance criterion; otherwise return verified partial results without claiming completion.
Stop on account mismatch, material ambiguity, inaccessible required evidence after permitted recovery, or a required out-of-scope action. Report the smallest needed input or permission. Stop after all acceptance criteria are satisfied; adjacent findings are suggestions only.
