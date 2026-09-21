# Synthetic example — paths are illustrative

## Objective
Change parse_timeout so the supplied repository returns a clear validation error for negative timeout values; preserve behavior for nonnegative values.

## Context and Evidence
The parent has already chosen validation at the parser, not at service startup. Authorized repository: /workspace/billing. Relevant implementation: src/config/timeout.py. Existing tests: tests/config/test_timeout.py. Inspect those files before editing.

## Scope Boundary
Read /workspace/billing/src/config, /workspace/billing/tests/config, pyproject.toml and pytest.ini. Mutations are limited to src/config/timeout.py and tests/config/test_timeout.py via existing permitted edit tools. Use only an existing policy-authorized test runner for these tests; its disposable artifacts are allowed only in its already-authorized sandbox. This task does not override the executor policy on shell writes. No dependency changes, commits, network, infrastructure changes or edits to adjacent modules.

## Epistemic Boundary
Use the checked-out files and actual test output as evidence. Report the repository revision and any pre-existing relevant modifications. Do not claim the entire application or full test suite is verified by a focused test run.

## Constraints
Preserve the parser public signature and existing nonnegative behavior. Do not overwrite another worker's changes. The method is flexible inside the existing permissions; unavailable rg may be replaced by another authorized read method, not by an unapproved installation.

## Acceptance Criteria
Add a test for a negative value that fails on the prior implementation and passes on the changed one; provide both results or explicitly state why the baseline could not be run.
Existing nonnegative parser tests pass; provide the exact permitted test invocation and result.
The final diff is limited to the two authorized files and retains unrelated edits.

## Return and Stop
Return changed path:line references, focused test evidence, diff-scope verification and remaining limitations. Unrun required checks mean the task is not fully complete.
Stop before changing another file, adding a dependency, resolving a new architectural choice or overwriting concurrent work. Return a precise blocker when the permitted checks cannot establish acceptance. Stop when acceptance is satisfied.
