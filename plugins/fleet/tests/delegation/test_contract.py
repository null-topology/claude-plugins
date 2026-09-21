#!/usr/bin/env python3
"""Standard-library tests; Python is never called by the runtime hook."""
from __future__ import annotations
import argparse
import atexit
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

HEADINGS = ["Objective", "Context and Evidence", "Scope Boundary", "Acceptance Criteria",
            "Return and Stop"]
OPTIONALS = ["Epistemic Boundary", "Constraints", "Additional Context"]
FLEET_TYPE = "fleet:fixture-worker"


def brief(bodies=None, order=None):
    bodies = bodies or {}
    return "\n\n".join("## " + h + "\n" + bodies.get(h, "Synthetic test content.")
                       for h in (HEADINGS if order is None else order)) + "\n"


def payload(prompt, **extra):
    data = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
            "tool_input": {"prompt": prompt, "subagent_type": FLEET_TYPE}}
    data.update(extra)
    return json.dumps(data, ensure_ascii=False)


@dataclass
class Case:
    name: str
    raw: str
    code: int = 0
    diagnostic: Optional[str] = None
    env: Optional[dict] = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shell", nargs="+", default=["/bin/sh"])
    args = parser.parse_args()
    fleet = Path(__file__).resolve().parents[2]
    hook = fleet / "scripts/delegation-contract.sh"
    skill = fleet / "skills/delegating-task/SKILL.md"
    shell = shutil.which(args.shell[0])
    if not shell:
        parser.error("Requested shell is unavailable")
    for tool in ("jq", "awk", "cat"):
        if not shutil.which(tool):
            parser.error("Missing test dependency: " + tool)
    # The hook inspects only calls whose target has a definition under <root>/agents.
    fixture_root = Path(tempfile.mkdtemp(prefix="fleet-contract-root-"))
    atexit.register(shutil.rmtree, fixture_root, True)
    (fixture_root / "agents").mkdir()
    (fixture_root / "agents/fixture-worker.md").write_text("---\nname: fixture-worker\n---\nFixture.\n")
    bare_command = [shell] + args.shell[1:] + [str(hook)]
    command = bare_command + [str(fixture_root)]

    def typed(prompt, subagent_type):
        tool_input = {"prompt": prompt}
        if subagent_type is not None:
            tool_input["subagent_type"] = subagent_type
        return payload(prompt, tool_input=tool_input)

    cases = [Case("valid/minimal structure", payload(brief()))]
    for path in sorted((skill.parent / "examples").glob("*.md")):
        cases.append(Case("example/" + path.name, payload(path.read_text())))
    for h in HEADINGS:
        cases.extend([
            Case("missing/" + h, payload(brief(order=[x for x in HEADINGS if x != h])), 2, "Missing: " + h + "."),
            Case("empty/" + h, payload(brief({h: " \t\r\n"})), 2, "Empty: " + h + "."),
            Case("duplicate/" + h, payload(brief() + "\n## " + h + "\nMore.\n"), 2, "Duplicate: " + h + "."),
        ])
    for h in OPTIONALS:
        cases.extend([
            Case("optional/present/" + h, payload(brief() + "\n## " + h + "\nInline notes.\n")),
            Case("optional/empty/" + h, payload(brief() + "\n## " + h + "\n"), 2, "Empty: " + h + "."),
            Case("optional/duplicate/" + h, payload(brief() + "\n## " + h + "\nA\n## " + h + "\nB"), 2, "Duplicate: " + h + "."),
        ])
    cases += [
        Case("optional/all present", payload(brief(order=HEADINGS + OPTIONALS))),
        Case("target/built-in type not inspected", typed("bare text", "Explore")),
        Case("target/fork not inspected", typed("bare text", "fork")),
        Case("target/missing type not inspected", typed("bare text", None)),
        Case("target/unknown plugin type not inspected", typed("bare text", "other:worker")),
        Case("target/path-like type not inspected", typed("bare text", "../agents/fixture-worker")),
        Case("target/non-string type not inspected", typed("bare text", 7)),
        Case("target/bare fleet name inspected", typed("bare text", "fixture-worker"), 2, "Missing: Objective."),
        Case("target/prefixed fleet name inspected", typed("bare text", FLEET_TYPE), 2, "Missing: Objective."),
        Case("format/reordered", payload(brief(order=list(reversed(HEADINGS))))),
        Case("format/CRLF", payload(brief().replace("\n", "\r\n"))),
        Case("format/BOM", payload("\ufeff" + brief())),
        Case("format/Unicode", payload(brief({"Objective": "Український текст: ї є ґ і — ✅."}))),
        Case("format/closing hashes", payload(brief().replace("## Objective\n", "## Objective ###  \n"))),
        Case("format/3-space indentation", payload(brief().replace("## ", "   ## "))),
        Case("format/4-space code indentation", payload(brief().replace("## ", "    ## ")), 2, "Missing: Objective."),
        Case("format/title", payload("# Task\n\n" + brief())),
        Case("format/extra H2", payload(brief() + "\n## Notes\nOther information.")),
        Case("format/exact case", payload(brief().replace("## Scope Boundary", "## Scope boundary")), 2, "Missing: Scope Boundary."),
        Case("format/prose is not heading", payload(brief(order=HEADINGS[1:]) + "\nThe ## Objective is here."), 2, "Missing: Objective."),
        Case("format/H3 is not H2", payload(brief().replace("## Objective", "### Objective")), 2, "Missing: Objective."),
        Case("format/quoted heading", payload(brief().replace("## Objective", "> ## Objective")), 2, "Missing: Objective."),
        Case("format/subheading alone is empty", payload(brief({"Objective": "### Description"})), 2, "Empty: Objective."),
        Case("format/unknown H2 ends section", payload(brief({"Objective": "## Other\nNot the objective."})), 2, "Empty: Objective."),
        Case("format/H1 ends section", payload(brief({"Objective": "# Other\nNot the objective."})), 2, "Empty: Objective."),
        Case("format/rule alone is empty", payload(brief({"Objective": "---"})), 2, "Empty: Objective."),
        Case("fence/wrapped brief", payload("```markdown\n" + brief() + "```"), 2, "Missing: Objective."),
        Case("fence/tilde wrapped brief", payload("~~~md\n" + brief() + "~~~"), 2, "Missing: Objective."),
        Case("fence/duplicate inside code ignored", payload(brief({"Context and Evidence": "```md\n## Objective\nExample.\n```"}))),
        Case("fence/body allowed", payload(brief({"Objective": "```text\nResult.\n```"}))),
        Case("fence/empty backticks", payload(brief({"Objective": "```text\n\n```"})), 2, "Empty: Objective."),
        Case("fence/empty tildes", payload(brief({"Objective": "~~~~text\n~~~~"})), 2, "Empty: Objective."),
        Case("fence/longer closer", payload(brief({"Objective": "```text\nResult.\n````"}))),
        Case("fence/short closer not closing", payload(brief({"Objective": "````text\n```\n## Scope Boundary\n````"}))),
        Case("fence/wrong closer not closing", payload(brief({"Objective": "```text\n~~~\n## Scope Boundary\n```"}))),
        Case("fence/unclosed", payload(brief() + "\n```\nunfinished"), 2, "Unclosed Markdown code fence."),
        Case("comment/duplicate ignored", payload("<!--\n## Objective\nexample\n-->\n" + brief())),
        Case("comment/not a real heading", payload("<!--\n## Objective\nexample\n-->\n" + brief(order=HEADINGS[1:])), 2, "Missing: Objective."),
        Case("comment/comment-only section", payload(brief({"Objective": "<!-- TODO -->"})), 2, "Empty: Objective."),
        Case("comment/multiline only", payload(brief({"Objective": "<!--\nnotes\n-->"})), 2, "Empty: Objective."),
        Case("comment/visible content", payload(brief({"Objective": "<!-- note -->Result.<!-- note -->"}))),
        Case("comment/unclosed", payload(brief() + "\n<!-- comment"), 2, "Unclosed HTML comment."),
        Case("comment/literal inside code", payload(brief({"Objective": "```text\n<!-- literal\n```"}))),
    ]
    for name, raw in [("malformed", '{"tool_name":'), ("empty", ""), ("array", "[]"),
                      ("null", "null"), ("multiple objects", payload(brief()) + "\n{}")]:
        cases.append(Case("json/" + name, raw, 2, "FLEET_DELEGATION_ERROR:"))
    cases += [
        Case("event/wrong event", payload(brief(), hook_event_name="SubagentStart"), 2, "FLEET_DELEGATION_ERROR:"),
        Case("event/missing event", json.dumps({"tool_name": "Agent"}), 2, "FLEET_DELEGATION_ERROR:"),
        Case("event/missing tool", json.dumps({"hook_event_name": "PreToolUse"}), 2, "FLEET_DELEGATION_ERROR:"),
        Case("event/tool wrong type", payload(brief(), tool_name=42), 2, "FLEET_DELEGATION_ERROR:"),
        Case("routing/non-Agent ignored", payload("bare text", tool_name="Bash")),
        Case("routing/SendMessage not covered", payload("bare text", tool_name="SendMessage")),
        Case("routing/exact Agent only", payload("bare text", tool_name="AgentRead")),
        Case("prompt/missing", payload(brief(), tool_input={"subagent_type": FLEET_TYPE}), 2, "FLEET_DELEGATION_INVALID:"),
        Case("prompt/whitespace", payload(" \t\n"), 2, "Missing: Objective."),
        Case("prompt/NUL rejected", payload(brief({"Objective": "before\x00after"})), 2, "FLEET_DELEGATION_INVALID:"),
        Case("prompt/control rejected", payload(brief({"Objective": "before\x01after"})), 2, "FLEET_DELEGATION_INVALID:"),
        Case("prompt/large content", payload(brief({"Context and Evidence": "evidence " * 20000}))),
        Case("prompt/backslashes preserved", payload(brief({"Objective": r"Literal \\n and C:\\work\\project."}))),
        Case("semantic/placeholder not judged", payload(brief({h: "TODO" for h in HEADINGS}))),
        Case("semantic/wrong target not detected", payload(brief({"Scope Boundary": "An unsupported target invented by the parent."}))),
    ]
    for name, value in [("null", None), ("array", ["text"]), ("number", 1), ("empty", "")]:
        cases.append(Case("prompt/" + name, payload(value), 2, "FLEET_DELEGATION_INVALID:"))

    failures = []
    with tempfile.TemporaryDirectory(prefix="fleet-contract-test-") as temporary:
        temp = Path(temporary)
        sentinel = temp / "must-not-exist"
        malicious = "$(touch '" + str(sentinel) + "') `touch '" + str(sentinel) + "'`"
        cases.append(Case("safety/prompt not executed", payload(brief({"Objective": malicious}))))
        for missing in ("jq", "awk", "cat"):
            directory = temp / ("missing-" + missing)
            directory.mkdir()
            for dep in ("jq", "awk", "cat"):
                if dep != missing:
                    (directory / dep).symlink_to(shutil.which(dep))
            cases.append(Case("dependency/missing " + missing, payload(brief()), 2,
                              "FLEET_DELEGATION_ERROR:", {"PATH": str(directory)}))
        broken = temp / "broken-awk"
        broken.mkdir()
        for dep in ("jq", "cat"):
            (broken / dep).symlink_to(shutil.which(dep))
        (broken / "awk").write_text("#!/bin/sh\nexit 7\n")
        (broken / "awk").chmod(0o755)
        cases.append(Case("dependency/awk error", payload(brief()), 2,
                          "FLEET_DELEGATION_ERROR:", {"PATH": str(broken)}))
        for index, case in enumerate(cases, 1):
            try:
                env = dict(os.environ, **(case.env or {}))
                result = subprocess.run(command, input=case.raw, text=True, capture_output=True,
                                        timeout=10, env=env)
                errors = []
                if result.returncode != case.code:
                    errors.append("exit %s, expected %s" % (result.returncode, case.code))
                if result.stdout:
                    errors.append("stdout must stay empty")
                if case.code == 0 and result.stderr:
                    errors.append("success must be silent")
                if case.diagnostic and case.diagnostic not in result.stderr:
                    errors.append("missing diagnostic: " + case.diagnostic)
                if "Synthetic test content." in result.stderr:
                    errors.append("prompt content leaked")
                if errors:
                    failures.append((case.name, "; ".join(errors), result.stderr))
                print("%s %d - %s" % ("not ok" if errors else "ok", index, case.name))
            except (OSError, subprocess.TimeoutExpired) as exc:
                failures.append((case.name, str(exc), ""))
                print("not ok %d - %s" % (index, case.name))
        if sentinel.exists():
            failures.append(("safety", "prompt was executed", ""))

    for label, extra in [("missing", []), ("without agents directory", [tempfile.gettempdir() + "/fleet-no-such-root"])]:
        result = subprocess.run(bare_command + extra, input=payload(brief()), text=True,
                                capture_output=True, timeout=10)
        if result.returncode != 2 or "FLEET_DELEGATION_ERROR:" not in result.stderr:
            failures.append(("configuration/plugin root " + label, "expected a configuration error", result.stderr))

    text = skill.read_text()
    try:
        template = text.split("```markdown\n", 1)[1].split("```", 1)[0]
        headings = [line[3:] for line in template.splitlines() if line.startswith("## ")]
        assert headings == HEADINGS + OPTIONALS, "Skill and validator schema disagree"
        result = subprocess.run(command, input=payload(template), text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, "Skill template shape rejected: " + result.stderr
        assert "context: fork" not in text, "Skill must not fork"
        assert "allowed-tools:" not in text, "Skill must not preapprove tools"
    except (IndexError, AssertionError) as exc:
        failures.append(("skill/template", str(exc), ""))
    for name, why, detail in failures:
        print("FAIL %s: %s\n%s" % (name, why, detail), file=sys.stderr)
    print("\nContract cases: %d; failures: %d; skill schema/authority checks: %s" %
          (len(cases), len(failures), "PASS" if not failures else "SEE FAILURES"))
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
