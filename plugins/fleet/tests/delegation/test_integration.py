#!/usr/bin/env python3
"""Test the new hook with an existing Fleet guard and generator in temporary fixtures."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from test_contract import brief


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--shell", nargs="+", default=["/bin/sh"])
    args = parser.parse_args()
    root = args.fleet_root.resolve()
    required = ["scripts/subagent-guard.sh", "scripts/delegation-contract.sh",
                "scripts/generate-agents.sh", "templates/agent.md", "hooks/hooks.json"]
    for path in required:
        if not (root / path).is_file():
            parser.error("Run against a patched Fleet checkout; missing " + str(root / path))
    interpreter = shutil.which(args.shell[0])
    if not interpreter:
        parser.error("Requested shell is unavailable")
    shell = [interpreter] + args.shell[1:]
    env = os.environ.copy()
    env.pop("FLEET_RULES", None)
    errors = []
    count = 0

    def check(name, condition, detail=""):
        nonlocal count
        count += 1
        print("%s %d - %s" % ("ok" if condition else "not ok", count, name))
        if not condition:
            errors.append(name + ": " + detail)

    hooks = json.loads((root / "hooks/hooks.json").read_text())["hooks"]
    groups = hooks.get("PreToolUse", [])
    contract_groups = [g for g in groups if any("delegation-contract.sh" in h.get("command", "") for h in g.get("hooks", []))]
    check("configuration/one exact Agent-only group", len(contract_groups) == 1 and contract_groups[0].get("matcher") == "^Agent$")
    if contract_groups:
        handlers = contract_groups[0]["hooks"]
        check("configuration/sh without async or explicit permission allow",
              len(handlers) == 1 and handlers[0].get("type") == "command"
              and handlers[0].get("command") == 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/delegation-contract.sh" "${CLAUDE_PLUGIN_ROOT}"'
              and not handlers[0].get("async", False))
    check("configuration/existing guard retained", any(g.get("matcher") == "Agent|Bash|Skill|Workflow"
          and any("subagent-guard.sh" in h.get("command", "") for h in g.get("hooks", [])) for g in groups))
    start_groups = hooks.get("SubagentStart", [])
    check("configuration/SubagentStart runs the guard for every agent type",
          len(start_groups) == 1 and "matcher" not in start_groups[0]
          and [h.get("command") for h in start_groups[0].get("hooks", [])] ==
          ['sh "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-guard.sh" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"'])

    with tempfile.TemporaryDirectory(prefix="fleet-integration-test-") as temporary:
        fixture = Path(temporary) / "fleet"
        (fixture / "agents").mkdir(parents=True)
        (fixture / "scripts").mkdir()
        for filename in ("subagent-guard.sh", "delegation-contract.sh"):
            shutil.copyfile(root / "scripts" / filename, fixture / "scripts" / filename)
        for name, model, effort in [("chief-high", "fixture-chief", "high"),
                                    ("worker-low", "fixture-worker", "low"),
                                    ("forbidden-high", "fixture-forbidden", "high")]:
            (fixture / "agents" / (name + ".md")).write_text(
                "---\nname: %s\nmodel: %s\neffort: %s\n---\nFixture.\n" % (name, model, effort))
        rules = {
            "main": {"fleet": {"fixture-chief": ["high"], "fixture-worker": ["low"]},
                     "builtin_agent_models": ["allowed-alias"]},
            "rules": {"fixture-chief": {"fixture-worker": ["low"]}, "fixture-worker": {}},
            "disallowed_skills": ["forbidden-skill"],
            "disallowed_commands": ["sudo", "doas", "claude"],
        }
        (fixture / "fleet.default.json").write_text(json.dumps(rules))

        def invocation(tool="Agent", caller="", **fields):
            data = {"hook_event_name": "PreToolUse", "tool_name": tool,
                    "tool_input": {"subagent_type": "fleet:worker-low", "prompt": brief()}}
            if caller:
                data.update(agent_type="fleet:" + caller, agent_id="fixture-child")
            data["tool_input"].update(fields)
            return data

        cases = [
            ("main/allowed dispatch", invocation(), (0, 0)),
            ("main/incomplete brief", invocation(prompt="bare task"), (0, 2)),
            ("main/forbidden fleet target", invocation(subagent_type="fleet:forbidden-high"), (2, 0)),
            ("main/model override still refused", invocation(model="other"), (2, 0)),
            ("main/builtin model refused", invocation(subagent_type="Explore", model="blocked-alias"), (2, 0)),
            ("main/builtin model allowed", invocation(subagent_type="Explore", model="allowed-alias"), (0, 0)),
            ("main/builtin with a plain prompt not inspected", invocation(subagent_type="Explore", prompt="bare task"), (0, 0)),
            ("main/fork with a plain prompt not inspected", invocation(subagent_type="fork", prompt="bare task"), (0, 0)),
            ("main/bare fleet name still inspected", invocation(subagent_type="worker-low", prompt="bare task"), (0, 2)),
            ("nested/incomplete brief", invocation(caller="chief-high", prompt="bare task"), (0, 2)),
            ("nested/allowed dispatch", invocation(caller="chief-high"), (0, 0)),
            ("nested/upward dispatch refused", invocation(caller="worker-low", subagent_type="fleet:chief-high"), (2, 0)),
            ("nested/builtin refused", invocation(caller="chief-high", subagent_type="Explore"), (2, 0)),
            ("nested/model override refused", invocation(caller="chief-high", model="other"), (2, 0)),
            ("nested/missing target refused", invocation(caller="chief-high", subagent_type=""), (2, 0)),
            ("nested/delegation skill allowed", invocation(tool="Skill", caller="chief-high", skill="fleet:delegating-task"), (0, 0)),
            ("nested/disallowed skill unchanged", invocation(tool="Skill", caller="chief-high", skill="forbidden-skill"), (2, 0)),
            ("nested/workflow refusal unchanged", invocation(tool="Workflow", caller="chief-high"), (2, 0)),
            ("nested/sudo refusal unchanged", invocation(tool="Bash", caller="chief-high", command="sudo true"), (2, 0)),
            ("main/non-Agent behavior unchanged", invocation(tool="Bash", command="printf example"), (0, 0)),
            ("combined/format repair does not waive policy refusal", invocation(subagent_type="fleet:forbidden-high", prompt="bare task"), (2, 2)),
            ("context/missing referenced file not opened by guard", invocation(prompt=brief() + "\n## Additional Context\n/read-only/nonexistent/source.md\n"), (0, 0)),
        ]
        commands = [shell + [str(fixture / "scripts/subagent-guard.sh"), str(fixture), str(fixture / "data")],
                    shell + [str(fixture / "scripts/delegation-contract.sh"), str(fixture)]]
        for name, data, expected in cases:
            raw = json.dumps(data)

            def run(command):
                return subprocess.run(command, input=raw, text=True, capture_output=True, timeout=10, env=env)

            # Exercise independent guards concurrently; this is not a Claude runtime test.
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(run, commands))
            actual = tuple(result.returncode for result in results)
            check(name, actual == expected and not any(r.stdout for r in results),
                  "expected %r, got %r; stderr=%r" % (expected, actual, [r.stderr for r in results]))

        def run_guard(data, rules_file=None):
            guard_env = dict(env, FLEET_RULES=str(rules_file)) if rules_file else env
            return subprocess.run(commands[0], input=json.dumps(data), text=True,
                                  capture_output=True, timeout=10, env=guard_env)

        def start(agent_type):
            return {"hook_event_name": "SubagentStart", "agent_id": "fixture-child", "agent_type": agent_type}

        result = run_guard(start("fleet:worker-low"))
        try:
            output = json.loads(result.stdout)["hookSpecificOutput"]
        except (ValueError, KeyError, TypeError):
            output = {}
        context = output.get("additionalContext", "") if output.get("hookEventName") == "SubagentStart" else ""
        check("start/fleet agent gets its limits",
              result.returncode == 0 and "Skills you cannot load: forbidden-skill." in context
              and "not a reason to stop" in context and "Commands you cannot run: sudo, doas, claude." in context,
              "rc=%r stdout=%r stderr=%r" % (result.returncode, result.stdout, result.stderr))
        result = run_guard(start("Explore"))
        check("start/built-in agent gets nothing", result.returncode == 0 and not result.stdout, result.stderr)
        result = run_guard(invocation(tool="Skill", caller="chief-high", skill="forbidden-skill"))
        check("nested/skill refusal says to carry on",
              result.returncode == 2 and "not a reason to stop" in result.stderr, result.stderr)

        broken = Path(temporary) / "broken.json"
        broken.write_text('{"disallowed_skills": ["forbidden-skill"] "disallowed_commands": []}')
        for name, data, code in [
                ("broken/start reports to the user", start("fleet:worker-low"), 2),
                ("broken/nested skill refused", invocation(tool="Skill", caller="chief-high", skill="any-skill"), 2),
                ("broken/nested command refused", invocation(tool="Bash", caller="chief-high", command="printf ok"), 2),
                ("broken/main dispatch refused", invocation(), 2),
                ("broken/main non-Agent call passes", invocation(tool="Bash", command="printf ok"), 0)]:
            result = run_guard(data, broken)
            check(name, result.returncode == code and not result.stdout
                  and (code == 0 or "not valid JSON" in result.stderr), result.stderr)

        generation = Path(temporary) / "generation"
        (generation / "scripts").mkdir(parents=True)
        (generation / "templates").mkdir()
        shutil.copyfile(root / "scripts/generate-agents.sh", generation / "scripts/generate-agents.sh")
        shutil.copyfile(root / "templates/agent.md", generation / "templates/agent.md")
        models = {"snapshot": {"benchmark": "synthetic-fixture", "date": "2026-09-21"},
                  "models": [{"id": "fixture-model", "name": "Fixture Model", "efforts": {
                      "low": {"index": 1, "usd": 1, "tps": 1},
                      "default": {"index": 1, "usd": 1, "tps": 1}}}]}
        (generation / "models.json").write_text(json.dumps(models))
        result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh")],
                                text=True, capture_output=True, timeout=10, env=env)
        check("generator/existing generator works with patched template", result.returncode == 0, result.stderr)
        if result.returncode == 0:
            for filename, effort in [("fixture-model-low.md", "low"), ("fixture-model.md", None)]:
                text = (generation / "agents" / filename).read_text()
                check("generator/" + filename + "/new directives",
                      "fleet:delegating-task" in text and "FLEET_DELEGATION_INVALID" in text
                      and "already permitted equivalent" in text and "FLEET_DELEGATION_ERROR" in text
                      and "closes that skill, not the task" in text
                      and "{{" not in text)
                check("generator/" + filename + "/model and effort preserved",
                      "model: fixture-model\n" in text and
                      (("effort: " + effort + "\n") in text if effort else "effort:" not in text))
    for error in errors:
        print("FAIL " + error, file=sys.stderr)
    print("\nIntegration checks: %d; failures: %d" % (count, len(errors)))
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
