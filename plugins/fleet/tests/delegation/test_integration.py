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
              and handlers[0].get("command") == 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/delegation-contract.sh" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"'
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
        for filename in ("subagent-guard.sh", "fleet-rules.sh", "delegation-contract.sh"):
            shutil.copyfile(root / "scripts" / filename, fixture / "scripts" / filename)
        # One agent per model, named by its id. The fleet and each model's levels come from the
        # rules: fixture-forbidden has a definition and benchmark data but the rules do not mention
        # it, so it is not a fleet model. models.json is benchmark data only; the guard never reads
        # it, so its efforts here deliberately differ from the levels the rules give.
        for name in ("chief", "worker", "forbidden", "plain"):
            (fixture / "agents" / (name + ".md")).write_text(
                "---\nname: %s\nmodel: fixture-%s\n---\nFixture.\n" % (name, name))
        figures = {"index": 1, "usd": 1, "tps": 1}
        (fixture / "models.json").write_text(json.dumps({
            "snapshot": {"benchmark": "synthetic-fixture", "date": "2026-09-21"},
            "models": [{"id": "fixture-chief", "name": "Chief", "efforts": {"low": figures}},
                       {"id": "fixture-worker", "name": "Worker", "efforts": {"xhigh": figures, "max": figures}},
                       {"id": "fixture-forbidden", "name": "Forbidden", "efforts": {"high": figures}},
                       {"id": "fixture-plain", "name": "Plain", "efforts": {"low": figures}}]}))
        # fixture-worker's levels are low (main, chief's row) and high (plain's row): high is one of
        # its levels that neither the main session nor a chief agent may pass.
        rules = {
            "main": {"fleet": {"fixture-chief": ["high"], "fixture-worker": ["low"], "fixture-plain": ["default"]},
                     "builtin_agent_models": ["allowed-alias"]},
            "rules": {"fixture-chief": {"fixture-worker": ["low"], "fixture-plain": ["default"]},
                      "fixture-worker": {},
                      "fixture-plain": {"fixture-worker": ["high"]}},
            "disallowed_skills": ["forbidden-skill"],
            "disallowed_commands": ["sudo", "doas", "claude"],
        }
        (fixture / "fleet.default.json").write_text(json.dumps(rules))

        def invocation(tool="Agent", caller="", **fields):
            """An Agent call to fleet:worker at low effort unless fields say otherwise; a field
            given as None is left out of the call."""
            data = {"hook_event_name": "PreToolUse", "tool_name": tool,
                    "tool_input": {"subagent_type": "fleet:worker", "effort": "low", "prompt": brief()}}
            if caller:
                data.update(agent_type="fleet:" + caller, agent_id="fixture-child")
            data["tool_input"].update(fields)
            data["tool_input"] = {k: v for k, v in data["tool_input"].items() if v is not None}
            return data

        cases = [
            ("main/allowed dispatch", invocation(), (0, 0)),
            ("main/incomplete brief", invocation(prompt="bare task"), (0, 2)),
            ("main/forbidden fleet target", invocation(subagent_type="fleet:forbidden", effort="high"), (2, 0)),
            ("main/model override still refused", invocation(model="other"), (2, 0)),
            ("main/builtin model refused", invocation(subagent_type="Explore", model="blocked-alias"), (2, 0)),
            ("main/builtin model allowed", invocation(subagent_type="Explore", model="allowed-alias"), (0, 0)),
            ("main/builtin with a plain prompt not inspected", invocation(subagent_type="Explore", prompt="bare task"), (0, 0)),
            ("main/fork with a plain prompt not inspected", invocation(subagent_type="fork", prompt="bare task"), (0, 0)),
            ("main/bare fleet name still inspected", invocation(subagent_type="worker", prompt="bare task"), (0, 2)),
            ("nested/incomplete brief", invocation(caller="chief", prompt="bare task"), (0, 2)),
            ("nested/allowed dispatch", invocation(caller="chief"), (0, 0)),
            ("nested/upward dispatch refused", invocation(caller="worker", subagent_type="fleet:chief", effort="high"), (2, 0)),
            ("nested/builtin refused", invocation(caller="chief", subagent_type="Explore", effort=None), (2, 0)),
            ("nested/model override refused", invocation(caller="chief", model="other"), (2, 0)),
            ("nested/missing target refused", invocation(caller="chief", subagent_type="", effort=None), (2, 0)),
            ("nested/delegation skill allowed", invocation(tool="Skill", caller="chief", skill="fleet:delegating-task"), (0, 0)),
            ("nested/disallowed skill unchanged", invocation(tool="Skill", caller="chief", skill="forbidden-skill"), (2, 0)),
            ("nested/workflow refusal unchanged", invocation(tool="Workflow", caller="chief"), (2, 0)),
            ("nested/sudo refusal unchanged", invocation(tool="Bash", caller="chief", command="sudo true"), (2, 0)),
            ("main/non-Agent behavior unchanged", invocation(tool="Bash", command="printf example"), (0, 0)),
            ("combined/format repair does not waive policy refusal", invocation(subagent_type="fleet:forbidden", effort="high", prompt="bare task"), (2, 2)),
            ("combined/an effort refusal and a brief refusal are separate", invocation(effort=None, prompt="bare task"), (2, 2)),
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

        # The call's effort: a model with named levels in the rules needs one of them, a model the
        # rules give only "default" takes none, a model they give no levels takes any named level;
        # the (model, effort) pair is then authorized against the rules, from the main session
        # (main.fleet) and from a fleet agent (its model's row). An open section (empty main.fleet,
        # empty rules) still has the effort checked.
        # main_open: main.fleet is empty, so the main session may start every fleet model; chief is
        # named only as a caller, so the rules give it no levels and it takes any named level.
        open_rules = Path(temporary) / "open.json"
        open_rules.write_text(json.dumps({"main": {"fleet": {}}, "rules": {
            "fixture-chief": {"fixture-worker": ["low", "high"]}, "fixture-worker": {}}}))
        # spawn_open: rules is empty, so every fleet agent may start every fleet model.
        spawn_open = Path(temporary) / "spawn-open.json"
        spawn_open.write_text(json.dumps({"main": {"fleet": {"fixture-chief": ["high"], "fixture-worker": ["low"]}},
                                          "rules": {}}))
        # default beside named levels for one model: a configuration error.
        mixed_rules = Path(temporary) / "mixed.json"
        mixed_rules.write_text(json.dumps({"main": {"fleet": {"fixture-plain": ["default"], "fixture-worker": ["low"]}},
                                           "rules": {"fixture-chief": {"fixture-plain": ["low"]}}}))
        effort_cases = [
            ("main/missing effort refused", invocation(effort=None), None, 2, "needs a named effort"),
            ("main/empty effort refused", invocation(effort=""), None, 2, "is not a level of 'fixture-worker'"),
            ("main/relative effort higher refused", invocation(effort="higher"), None, 2, "effort 'higher' is relative"),
            ("main/relative effort lower refused", invocation(effort="lower"), None, 2, "effort 'lower' is relative"),
            ("main/off-ladder effort refused", invocation(effort="xhigh"), None, 2,
             "effort 'xhigh' is not a level of 'fixture-worker'. Its levels: low, high."),
            ("main/default is not a level of a laddered model", invocation(effort="default"), None, 2,
             "is not a level of 'fixture-worker'"),
            ("main/ladder-less model with an effort refused", invocation(subagent_type="fleet:plain"), None, 2,
             "'fixture-plain' has no adjustable reasoning effort"),
            ("main/ladder-less model without an effort passes", invocation(subagent_type="fleet:plain", effort=None),
             None, 0, ""),
            ("main/allowed pair passes", invocation(), None, 0, ""),
            ("main/disallowed pair refused", invocation(effort="high"), None, 2,
             "agent type 'fleet:worker' at effort 'high' is not enabled for the main session"),
            ("main/open main.fleet: missing effort still refused", invocation(effort=None), open_rules, 2,
             "needs a named effort"),
            ("main/open main.fleet: a level the rules give passes", invocation(effort="high"), open_rules, 0, ""),
            ("main/open main.fleet: a level the rules do not give is refused", invocation(effort="max"), open_rules,
             2, "effort 'max' is not a level of 'fixture-worker'. Its levels: low, high."),
            ("main/caller-only model, empty matrix: any named level passes",
             invocation(subagent_type="fleet:chief", effort="xhigh"), open_rules, 0, ""),
            ("main/caller-only model, empty matrix: a missing effort is refused",
             invocation(subagent_type="fleet:chief", effort=None), open_rules, 2, "needs a named effort"),
            ("main/caller-only model, empty matrix: a relative effort is refused",
             invocation(subagent_type="fleet:chief", effort="higher"), open_rules, 2, "effort 'higher' is relative"),
            ("main/caller-only model, empty matrix: a word that is not a named level is refused",
             invocation(subagent_type="fleet:chief", effort="ultra"), open_rules, 2,
             "effort 'ultra' is not a level of 'fixture-chief'. Its levels: low, medium, high, xhigh, max."),
            ("nested/caller-only model: a row that does not list it refuses it",
             invocation(caller="chief", subagent_type="fleet:chief", effort="high"), open_rules, 2,
             "agent type 'fleet:chief' at effort 'high' is not available from a fixture-chief agent"),
            ("main/default beside named levels is a configuration error",
             invocation(subagent_type="fleet:plain", effort=None), mixed_rules, 2,
             "give 'fixture-plain' both 'default' and named levels (low, default)"),
            ("nested/default beside named levels is a configuration error",
             invocation(caller="chief", subagent_type="fleet:plain", effort="low"), mixed_rules, 2,
             "both 'default' and named levels"),
            ("main/a model the rules do not mention is refused, though models.json describes it",
             invocation(subagent_type="fleet:forbidden", effort="high"), open_rules, 2,
             "'fixture-forbidden', which the fleet rules in force"),
            ("nested/missing effort refused", invocation(caller="chief", effort=None), None, 2, "needs a named effort"),
            ("nested/relative effort refused", invocation(caller="chief", effort="higher"), None, 2,
             "effort 'higher' is relative"),
            ("nested/off-ladder effort refused", invocation(caller="chief", effort="max"), None, 2,
             "effort 'max' is not a level of 'fixture-worker'"),
            ("nested/ladder-less model with an effort refused",
             invocation(caller="chief", subagent_type="fleet:plain", effort="low"), None, 2,
             "has no adjustable reasoning effort"),
            ("nested/ladder-less model without an effort passes",
             invocation(caller="chief", subagent_type="fleet:plain", effort=None), None, 0, ""),
            ("nested/allowed pair passes", invocation(caller="chief"), None, 0, ""),
            ("nested/disallowed pair refused", invocation(caller="chief", effort="high"), None, 2,
             "agent type 'fleet:worker' at effort 'high' is not available from a fixture-chief agent"),
            ("nested/open rules: relative effort still refused", invocation(caller="worker", effort="lower"),
             spawn_open, 2, "effort 'lower' is relative"),
            ("nested/open rules: a level the rules give passes", invocation(caller="worker", subagent_type="fleet:chief",
                                                                            effort="high"), spawn_open, 0, ""),
            ("nested/open rules: a level the rules do not give is refused",
             invocation(caller="worker", subagent_type="fleet:chief", effort="low"), spawn_open, 2,
             "effort 'low' is not a level of 'fixture-chief'. Its levels: high."),
            ("nested/a model param is refused before the effort is read",
             invocation(caller="chief", model="other", effort=None), None, 2, "model parameter is not available"),
        ]
        for name, data, rules_file, code, text in effort_cases:
            result = run_guard(data, rules_file)
            check("effort/" + name, result.returncode == code and not result.stdout
                  and (text in result.stderr if code else not result.stderr),
                  "rc=%r stderr=%r" % (result.returncode, result.stderr))
        # A definition whose model the rules do not mention is not a fleet agent the guard lets
        # anyone start, even where main.fleet allows every fleet model.
        (fixture / "agents" / "unlisted.md").write_text("---\nname: unlisted\nmodel: fixture-unlisted\n---\nFixture.\n")
        result = run_guard(invocation(subagent_type="fleet:unlisted", effort="low"), open_rules)
        check("effort/main/a model the rules do not mention is refused",
              result.returncode == 2 and "do not mention, so it is not a fleet model" in result.stderr, result.stderr)
        (fixture / "agents" / "unlisted.md").unlink()

        result = run_guard(start("fleet:worker"))
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
        result = run_guard(invocation(tool="Skill", caller="chief", skill="forbidden-skill"))
        check("nested/skill refusal says to carry on",
              result.returncode == 2 and "not a reason to stop" in result.stderr, result.stderr)

        broken = Path(temporary) / "broken.json"
        broken.write_text('{"disallowed_skills": ["forbidden-skill"] "disallowed_commands": []}')
        for name, data, code in [
                ("broken/start reports to the user", start("fleet:worker"), 2),
                ("broken/nested skill refused", invocation(tool="Skill", caller="chief", skill="any-skill"), 2),
                ("broken/nested command refused", invocation(tool="Bash", caller="chief", command="printf ok"), 2),
                ("broken/main dispatch refused", invocation(), 2),
                ("broken/main non-Agent call passes", invocation(tool="Bash", command="printf ok"), 0)]:
            result = run_guard(data, broken)
            check(name, result.returncode == code and not result.stdout
                  and (code == 0 or "rules file is invalid" in result.stderr), result.stderr)

        generation = Path(temporary) / "generation"
        (generation / "scripts").mkdir(parents=True)
        (generation / "templates").mkdir()
        for filename in ("generate-agents.sh", "fleet-rules.sh"):
            shutil.copyfile(root / "scripts" / filename, generation / "scripts" / filename)
        shutil.copyfile(root / "templates/agent.md", generation / "templates/agent.md")
        # The fleet is what the shipped rules mention: fixture-model and fixture-plain, which
        # models.json describes, and fixture-bare, which it does not. fixture-unused is described
        # but not mentioned, so it gets no agent and no reference row.
        models = {"snapshot": {"benchmark": "synthetic-fixture", "date": "2026-09-21"},
                  "models": [{"id": "fixture-model", "name": "Fixture Model", "efforts": {
                                 "low": {"index": 1, "usd": 1, "tps": 1},
                                 "high": {"index": 2, "usd": 2, "tps": 1}}},
                             {"id": "fixture-plain", "name": "Fixture Plain", "efforts": {
                                 "default": {"index": 1, "usd": 1, "tps": 1}}},
                             {"id": "fixture-unused", "name": "Fixture Unused", "efforts": {
                                 "low": {"index": 3, "usd": 1, "tps": 1}}}]}
        (generation / "models.json").write_text(json.dumps(models))
        (generation / "fleet.default.json").write_text(json.dumps({
            "main": {"fleet": {"fixture-model": ["low", "high"], "fixture-plain": ["default"]}},
            "rules": {"fixture-model": {"fixture-bare": ["medium", "low"]}}}))
        result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh")],
                                text=True, capture_output=True, timeout=10, env=env)
        check("generator/existing generator works with patched template", result.returncode == 0, result.stderr)
        if result.returncode == 0:
            check("generator/one agent per model the rules mention, named by its id; none for a model only "
                  "models.json describes",
                  sorted(p.name for p in (generation / "agents").glob("*.md"))
                  == ["fixture-bare.md", "fixture-model.md", "fixture-plain.md"],
                  sorted(p.name for p in (generation / "agents").iterdir()))
            bare_header = (generation / "agents/fixture-bare.md").read_text().split("\n---\n", 1)[0]
            check("generator/a model models.json does not describe gets the plain description, its levels "
                  "from the rules",
                  'description: "Executor subagent on fixture-bare. The caller passes a named effort on every '
                  'Agent call: low or medium, chosen with fleet:selecting-subagent-model; never lower or higher. '
                  'Follows the prompt literally; does not invent scope."' in bare_header
                  and "Benchmark" not in bare_header and "\nmodel: fixture-bare" in bare_header, bare_header)
            reference = (generation / "skills/selecting-subagent-model/references/benchmark.md").read_text()
            check("generator/the reference lists only fleet models",
                  "`fleet:fixture-model`" in reference and "`fleet:fixture-plain`" in reference
                  and "fixture-unused" not in reference and "Fixture Unused" not in reference, reference)
            narrowed = Path(temporary) / "narrowed.json"
            narrowed.write_text(json.dumps({"main": {"fleet": {"fixture-unknown": ["high"]}}}))
            result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh"), "--rules", str(narrowed)],
                                    text=True, capture_output=True, timeout=10, env=env)
            unknown = generation / "agents/fixture-unknown.md"
            check("generator/--rules: the agents are the models that file mentions, with its levels",
                  result.returncode == 0 and sorted(p.name for p in (generation / "agents").glob("*.md"))
                  == ["fixture-unknown.md"] and unknown.is_file()
                  and "named effort on every Agent call: high, chosen" in unknown.read_text(),
                  (result.returncode, result.stdout, result.stderr))
            mixed = Path(temporary) / "mixed-generation.json"
            mixed.write_text(json.dumps({"main": {"fleet": {"fixture-model": ["default", "low"]}}}))
            before = sorted(p.name for p in (generation / "agents").glob("*.md"))
            result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh"), "--rules", str(mixed)],
                                    text=True, capture_output=True, timeout=10, env=env)
            check("generator/default beside named levels is a configuration error: exit 3, agents/ unchanged",
                  result.returncode == 3 and "gives 'fixture-model' both default and named levels" in result.stderr
                  and sorted(p.name for p in (generation / "agents").glob("*.md")) == before,
                  (result.returncode, result.stderr))
            result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh")],
                                    text=True, capture_output=True, timeout=10, env=env)
            for filename, model, levels in [("fixture-model.md", "fixture-model", "low or high"),
                                            ("fixture-plain.md", "fixture-plain", None)]:
                text = (generation / "agents" / filename).read_text()
                header = text.split("\n---\n", 1)[0]
                check("generator/" + filename + "/new directives",
                      "fleet:delegating-task" in text and "FLEET_DELEGATION_INVALID" in text
                      and "already permitted equivalent" in text and "FLEET_DELEGATION_ERROR" in text
                      and "closes that skill, not the task" in text
                      and "Always pass the named `effort` chosen with `fleet:selecting-subagent-model`" in text
                      and "{{" not in text)
                check("generator/" + filename + "/model kept, no effort in the frontmatter, the description says "
                      "what effort the caller passes",
                      ("\nmodel: %s" % model) in header and "\neffort:" not in header
                      and (("named effort on every Agent call: %s," % levels) in header if levels
                           else "the caller passes no effort" in header), header)
    for error in errors:
        print("FAIL " + error, file=sys.stderr)
    print("\nIntegration checks: %d; failures: %d" % (count, len(errors)))
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
