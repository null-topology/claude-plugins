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


class Whole(str):
    """A diagnostic that is the whole of stderr, not a part of it."""


def invalid_text(detail):
    """The whole refusal of an invalid brief: the invalid() frame around one detail line."""
    return Whole("FLEET_DELEGATION_INVALID: delegation brief is incomplete or malformed.\n" + detail + "\n"
                 "Apply fleet:delegating-task in the parent session and correct the brief from known context.\n"
                 "Do not invent scope or permissions. Clarify a known blocker before dispatch.\n"
                 "Retry the intended call only after correction; any policy-guard refusal still applies.\n")


def error_text(detail):
    """The whole refusal of a hook or configuration error."""
    return Whole("FLEET_DELEGATION_ERROR: " + detail + "\n"
                 "Report the hook/configuration problem; do not route around it.\n")


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
    # The hook inspects only calls whose target the guard treats as a fleet agent: a definition
    # under <root>/agents, a model the rules in force mention whose file the sync removed (here the
    # shipped default, as no data directory is given), or the prefix. models.json is benchmark data
    # and names no fleet agent: fixture-described is described there and not mentioned in the rules.
    fixture_root = Path(tempfile.mkdtemp(prefix="fleet-contract-root-"))
    atexit.register(shutil.rmtree, fixture_root, True)
    (fixture_root / "agents").mkdir()
    (fixture_root / "agents/fixture-worker.md").write_text("---\nname: fixture-worker\n---\nFixture.\n")
    (fixture_root / "fleet.default.json").write_text(
        '{"main": {"fleet": {"fixture-worker": ["low"]}}, "rules": {"fixture-worker": {"fixture-pruned": ["high"]}}}\n')
    (fixture_root / "models.json").write_text(
        '{"models": [{"id": "fixture-described", "efforts": {"high": {}}}]}\n')
    other_rules = fixture_root / "other-rules.json"
    other_rules.write_text('{"rules": {"fixture-other": {}}}\n')
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
        Case("target/another plugin's type named like a fleet agent not inspected",
             typed("bare text", "other:fixture-worker")),
        Case("target/path-like type not inspected", typed("bare text", "../agents/fixture-worker")),
        Case("target/non-string type not inspected", typed("bare text", 7)),
        Case("target/bare fleet name inspected", typed("bare text", "fixture-worker"), 2, "Missing: Objective."),
        Case("target/prefixed fleet name inspected", typed("bare text", FLEET_TYPE), 2, "Missing: Objective."),
        Case("target/pruned but permitted fleet agent still inspected",
             typed("do it", "fleet:fixture-pruned"), 2, "Missing: Objective."),
        Case("target/pruned fleet agent by bare name still inspected",
             typed("do it", "fixture-pruned"), 2, "Missing: Objective."),
        Case("target/a per-effort name of a listed model is not a fleet agent", typed("bare text", "fixture-pruned-high")),
        Case("target/a model only models.json describes is not a fleet agent",
             typed("bare text", "fixture-described")),
        Case("target/the rules file in force decides: FLEET_RULES naming the model",
             typed("bare text", "fixture-other"), 2, "Missing: Objective.", {"FLEET_RULES": str(other_rules)}),
        Case("target/the rules file in force decides: the shipped default does not name it",
             typed("bare text", "fixture-other")),
        Case("target/unknown fleet-prefixed type inspected", typed("do it", "fleet:no-such-agent"), 2,
             "Missing: Objective."),
        Case("target/fleet-prefixed path not inspected", typed("bare text", "fleet:../agents/fixture-worker")),
        # The prefix is compared trimmed and case-insensitively (review round 2, item 5).
        Case("target/'Fleet:' prefix inspected", typed("bare text", "Fleet:fixture-worker"), 2, "Missing: Objective."),
        Case("target/'FLEET:' prefix inspected", typed("bare text", "FLEET:fixture-worker"), 2, "Missing: Objective."),
        Case("target/' fleet:' prefix inspected", typed("bare text", " fleet:fixture-worker"), 2, "Missing: Objective."),
        Case("target/'Fleet:' prefix of an unknown name inspected", typed("bare text", "Fleet:no-such-agent"), 2,
             "Missing: Objective."),
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

    # ---- the per-spawn MCP block (design section 7) ------------------------------------------
    def items(key, rules):
        return key + ":\n" + "".join("  - %s\n" % json.dumps(r) for r in rules)

    def line_error(number, reason):
        # The whole invalid() frame around the one detail line.
        return invalid_text("MCP policy: line %d: %s." % (number, reason))

    bounds = invalid_text("MCP policy: more than 256 rules, or a rule longer than 256 bytes.")
    fleet_only = invalid_text("MCP policy: per-spawn rules work only for fleet agents.")
    block = "---\n" + items("allow", ["mcp__mail__read"]) + items("deny", ["*__search"]) + "---\n"
    long_rules = ["mcp__r%03d" % i + "x" * 247 for i in range(256)]
    cases += [
        Case("mcp/a valid block passes silently", payload(block + brief())),
        Case("mcp/deny before allow", payload("---\n" + items("deny", ["*"]) + items("allow", ["mcp__a"]) + "---\n"
                                              + brief())),
        Case("mcp/allow alone", payload("---\n" + items("allow", ["mcp__a", "mcp__b*"]) + "---\n" + brief())),
        Case("mcp/deny alone", payload("---\n" + items("deny", ["mcp__gateway__vault__search"]) + "---\n" + brief())),
        Case("mcp/CRLF endings", payload((block + brief()).replace("\n", "\r\n"))),
        Case("mcp/mixed endings", payload("---\r\nallow:\n  - \"mcp__a\"\r\ndeny:\r\n  - \"mcp__b\"\n---\r\n" + brief())),
        Case("mcp/256 rules of 256 bytes in each list",
             payload("---\n" + items("allow", long_rules) + items("deny", long_rules) + "---\n" + brief())),
        Case("mcp/a grant a deny cancels is not judged at the spawn",
             payload("---\n" + items("allow", ["mcp__mail__send"]) + items("deny", ["mcp__mail__*"]) + "---\n"
                     + brief())),
        Case("mcp/block-like lines after the first heading are not a block",
             payload(brief() + "\n---\n" + items("allow", ["mcp__a"]) + "---\n")),
        Case("mcp/257 rules", payload("---\n" + items("deny", ["mcp__r%d" % i for i in range(257)]) + "---\n"
                                      + brief()), 2, bounds),
        Case("mcp/a rule of 257 bytes", payload("---\n" + items("allow", ["mcp__" + "a" * 252]) + "---\n" + brief()),
             2, bounds),
        Case("mcp/a leading blank line", payload("\n" + block + brief()), 2,
             line_error(2, "the policy block must start at line 1")),
        Case("mcp/--- with a trailing blank", payload("--- \n" + block[4:] + brief()), 2,
             line_error(1, "the policy block must start at line 1")),
        Case("mcp/a byte-order mark", payload("﻿" + block + brief()), 2,
             line_error(1, "the policy block must start at line 1")),
        Case("mcp/a block after other text", payload("Intro\n" + block + brief()), 2,
             line_error(2, "the policy block must start at line 1")),
        Case("mcp/--- opening other front matter", payload("---\ntitle: x\n---\n" + brief()), 2,
             line_error(2, "expected allow or deny")),
        Case("mcp/a thematic break at line 1", payload("---\n" + brief()), 2, line_error(2, "expected allow or deny")),
        Case("mcp/an inline list", payload('---\nallow: ["mcp__a"]\n---\n' + brief()), 2,
             line_error(2, "expected allow or deny")),
        Case("mcp/a comment in the block", payload("---\n" + items("allow", ["mcp__a"]) + "# note\n---\n" + brief()),
             2, line_error(4, "expected allow or deny")),
        Case("mcp/a blank line in the block", payload("---\n" + items("allow", ["mcp__a"]) + "\n---\n" + brief()), 2,
             line_error(4, "expected allow or deny")),
        Case("mcp/a duplicate key", payload("---\n" + items("deny", ["mcp__a"]) + items("deny", ["mcp__b"]) + "---\n"
                                            + brief()), 2, line_error(4, "duplicate key")),
        Case("mcp/a key with no rule", payload("---\nallow:\n" + items("deny", ["mcp__a"]) + "---\n" + brief()), 2,
             line_error(2, "a key needs at least one rule")),
        Case("mcp/a key with no rule before the closing line", payload("---\ndeny:\n---\n" + brief()), 2,
             line_error(2, "a key needs at least one rule")),
        Case("mcp/an unquoted rule", payload("---\nallow:\n  - mcp__a\n---\n" + brief()), 2,
             line_error(3, "expected a double-quoted rule")),
        Case("mcp/a single-quoted rule", payload("---\nallow:\n  - 'mcp__a'\n---\n" + brief()), 2,
             line_error(3, "expected a double-quoted rule")),
        Case("mcp/text after the rule", payload("---\nallow:\n  - \"mcp__a\" # note\n---\n" + brief()), 2,
             line_error(3, "expected a double-quoted rule")),
        Case("mcp/an invalid rule", payload("---\n" + items("deny", ["gateway__*"]) + "---\n" + brief()), 2,
             line_error(3, 'invalid rule "gateway__*"')),
        Case("mcp/an empty rule", payload("---\n" + items("deny", [""]) + "---\n" + brief()), 2,
             line_error(3, 'invalid rule ""')),
        Case("mcp/no closing line", payload("---\n" + items("allow", ["mcp__a"]) + brief()), 2,
             line_error(4, "expected allow or deny")),
        Case("mcp/a block and nothing else", payload("---\n" + items("allow", ["mcp__a"])), 2,
             line_error(4, "missing closing ---")),
        Case("mcp/the block is checked before the sections", payload("---\ndeny:\n---\nbare text"), 2,
             line_error(2, "a key needs at least one rule")),
        Case("mcp/a fleet target by bare name is checked", typed("---\ndeny:\n---\n" + brief(), "fixture-worker"), 2,
             line_error(2, "a key needs at least one rule")),
        # Another target: only line 1 reading --- and line 2 starting with allow: or deny: is looked
        # at, valid or not, before the target filter.
        Case("mcp/a block for a built-in agent", typed(block + "bare text", "Explore"), 2, fleet_only),
        Case("mcp/a block without subagent_type", typed(block + "bare text", None), 2, fleet_only),
        Case("mcp/a block for another plugin's agent", typed(block + "bare text", "other:fixture-worker"), 2,
             fleet_only),
        Case("mcp/a block for a path-like type", typed(block + "bare text", "../agents/fixture-worker"), 2,
             fleet_only),
        Case("mcp/a block for a non-string type", typed(block + "bare text", 7), 2, fleet_only),
        Case("mcp/an invalid block for a built-in agent", typed("---\ndeny:\n---\nbare text", "Explore"), 2, fleet_only),
        Case("mcp/a padded block for a built-in agent", typed("﻿ --- \r\n\tallow: x\nbare text", "Explore"), 2,
             fleet_only),
        Case("mcp/--- and other text for a built-in agent", typed("---\ntitle: x\n---\nbare text", "Explore")),
        Case("mcp/a block after other text for a built-in agent", typed("Intro\n" + block + "bare text", "Explore")),
        Case("mcp/a non-string prompt for a built-in agent", payload(7, tool_input={"prompt": 7,
                                                                                   "subagent_type": "Explore"})),
        Case("mcp/a block in another tool's input", payload(block + "bare text", tool_name="Bash")),
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
        # A block reader that fails refuses the spawn, for any target: whether the brief opens a
        # block is then unknown.
        failing = temp / "failing-block-reader"
        failing.mkdir()
        (failing / "jq").write_text("#!/bin/sh\ncase \"$*\" in *'one brief was expected'*) exit 5 ;; esac\n"
                                    "exec '%s' \"$@\"\n" % shutil.which("jq"))
        (failing / "jq").chmod(0o755)
        reader_path = {"PATH": str(failing) + os.pathsep + os.environ.get("PATH", "")}
        unreadable = error_text("The MCP policy block of the brief could not be read.")
        cases.append(Case("mcp/a block reader that fails, for a built-in agent", typed("bare text", "Explore"), 2,
                          unreadable, reader_path))
        cases.append(Case("mcp/a block reader that fails, for a fleet agent", payload(brief()), 2, unreadable,
                          reader_path))
        for index, case in enumerate(cases, 1):
            try:
                env = {k: v for k, v in os.environ.items() if k != "FLEET_RULES"}
                env.update(case.env or {})
                result = subprocess.run(command, input=case.raw, text=True, capture_output=True,
                                        timeout=10, env=env)
                errors = []
                if result.returncode != case.code:
                    errors.append("exit %s, expected %s" % (result.returncode, case.code))
                if result.stdout:
                    errors.append("stdout must stay empty")
                if case.code == 0 and result.stderr:
                    errors.append("success must be silent")
                if isinstance(case.diagnostic, Whole):
                    if result.stderr != case.diagnostic:
                        errors.append("stderr differs from: " + json.dumps(case.diagnostic))
                elif case.diagnostic and case.diagnostic not in result.stderr:
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

    # Without the shared library the hook cannot tell a fleet agent, so it reports a fault.
    with tempfile.TemporaryDirectory() as temporary:
        lone = Path(temporary) / "delegation-contract.sh"
        shutil.copy(hook, lone)
        result = subprocess.run([shell] + args.shell[1:] + [str(lone), str(fixture_root)],
                                input=payload(brief()), text=True, capture_output=True, timeout=10)
        if result.returncode != 2 or "FLEET_DELEGATION_ERROR:" not in result.stderr:
            failures.append(("configuration/missing rule library", "expected a configuration error",
                             result.stderr))

    # Without the MCP policy library no brief can be read, so the hook reports a fault for every
    # Agent call, the calls to other agent types included (their block check needs it too).
    with tempfile.TemporaryDirectory() as temporary:
        lone = Path(temporary) / "delegation-contract.sh"
        shutil.copy(hook, lone)
        shutil.copy(fleet / "scripts/fleet-rules.sh", Path(temporary) / "fleet-rules.sh")
        for label, raw in (("a fleet target", payload(brief())), ("a built-in target", typed("bare text", "Explore"))):
            result = subprocess.run([shell] + args.shell[1:] + [str(lone), str(fixture_root)],
                                    input=raw, text=True, capture_output=True, timeout=10)
            if result.returncode != 2 or "FLEET_DELEGATION_ERROR:" not in result.stderr \
                    or "mcp-policy.sh" not in result.stderr:
                failures.append(("configuration/missing MCP policy library, " + label,
                                 "expected a configuration error naming mcp-policy.sh", result.stderr))

    text = skill.read_text()
    try:
        template = text.split("```markdown\n", 1)[1].split("```", 1)[0]
        headings = [line[3:] for line in template.splitlines() if line.startswith("## ")]
        assert sorted(headings) == sorted(HEADINGS + OPTIONALS), "Skill and validator schema disagree"
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
