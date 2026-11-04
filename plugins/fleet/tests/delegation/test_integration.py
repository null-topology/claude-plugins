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
             "effort 'xhigh' is not a level of 'fixture-worker'. The levels available here: low."),
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
             "agent type 'fleet:chief' is not available from a fixture-chief agent at any effort"),
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

        # ---- review reproductions -------------------------------------------------------------
        # Each case is a reproduction from the 0.10.0 review, run on a copy of the plugin's own
        # agents and shipped rules. Every one of them gave another exit code before the fix.
        real = Path(temporary) / "real"
        (real / "scripts").mkdir(parents=True)
        for filename in ("subagent-guard.sh", "fleet-rules.sh"):
            shutil.copyfile(root / "scripts" / filename, real / "scripts" / filename)
        shutil.copytree(root / "agents", real / "agents")
        shutil.copyfile(root / "fleet.default.json", real / "fleet.default.json")
        if (root / ".claude-plugin/plugin.json").is_file():
            (real / ".claude-plugin").mkdir()
            shutil.copyfile(root / ".claude-plugin/plugin.json", real / ".claude-plugin/plugin.json")
        review_rules = Path(temporary) / "review-rules.json"

        def review(raw, rules_text=None, extra_env=None):
            """Runs the guard of the copy on a raw payload, with rules_text as FLEET_RULES (the shipped
            rules when None)."""
            run_env = dict(env, **(extra_env or {}))
            if rules_text is not None:
                review_rules.write_text(rules_text)
                run_env["FLEET_RULES"] = str(review_rules)
            return subprocess.run(shell + [str(real / "scripts/subagent-guard.sh"), str(real), ""], input=raw,
                                  text=True, capture_output=True, timeout=10, env=run_env)

        def agent_call(subagent_type, caller=None, **fields):
            data = {"hook_event_name": "PreToolUse", "tool_name": "Agent",
                    "tool_input": dict({"subagent_type": subagent_type, "prompt": brief()}, **fields)}
            if caller:
                data.update(agent_type=caller, agent_id="a1")
            return json.dumps(data)

        fable_bash = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash", "agent_type": "claude-fable-5-1",
                                 "agent_id": "a1", "tool_input": {"command": "sudo ls"}})
        wrong_rules = json.dumps({"main": {"fleet": {"novel-model": ["high"]}}, "rules": "wrong"})
        newline_rules = json.dumps({"main": {"fleet": {"gpt-6-luna": ["max"], "claude-sonnet-5-5": ["high"]}},
                                    "rules": {"claude-sonnet-5-5": {"gpt-6-luna": ["low\nmax"]}}})
        luna_rules = json.dumps({"main": {"fleet": {"gpt-6-luna": ["low"]}},
                                 "rules": {"gpt-6-luna": {"gpt-6-luna": ["high"]}}})
        # A jq that fails (status 5) on the guard's first payload field: an unexpected failure.
        failing = Path(temporary) / "failing-jq"
        failing.mkdir()
        (failing / "jq").write_text("#!/bin/sh\ncase \"$*\" in *hook_event_name*) exit 5 ;; esac\nexec '%s' \"$@\"\n"
                                    % shutil.which("jq"))
        (failing / "jq").chmod(0o755)
        failing_env = {"PATH": "%s%s%s" % (failing, os.pathsep, env.get("PATH", ""))}
        fable = real / "agents/claude-fable-5-1.md"
        fable_text = fable.read_text()
        fable.unlink()
        review_cases = [
            ("1/caller: empty rules, its definition gone: a bare fleet caller is refused",
             review(fable_bash, ""), 2, "rules file is invalid"),
            ("1/caller: truncated rules, its definition gone: a bare fleet caller is refused",
             review(fable_bash, '{"main": {"fleet": {"claude-fable-5-1": ["high"]'), 2, "rules file is invalid"),
        ]
        fable.write_text(fable_text)
        review_cases += [
            ("1/target: rules with a section of the wrong type: a bare type is refused, not passed as built-in",
             review(agent_call("novel-model", effort="high"), wrong_rules), 2, "could not be read"),
            ("1/target: the prefixed spelling is refused too",
             review(agent_call("fleet:novel-model", effort="high"), wrong_rules), 2, "could not be read"),
            ("1/a built-in caller still passes once the rules were read",
             review(fable_bash.replace('"claude-fable-5-1"', '"Explore"')), 0, ""),
            ("2/a line break inside an effort entry is no pair of levels",
             review(agent_call("fleet:gpt-6-luna", "fleet:claude-sonnet-5-5", effort="max"), newline_rules), 2,
             'the effort entries "low\\nmax", which are not levels'),
            ("3/a payload that is not JSON is refused", review("not json"), 2, "hook payload is not one JSON object"),
            ("3/a tool_input that is not an object is refused", review('{"tool_input":"x"}'), 2,
             "hook payload is not one JSON object"),
            ("3/an Agent call whose tool_input is not an object is refused",
             review('{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":"x"}'), 2,
             "hook payload is not one JSON object"),
            ("3/an unexpected failure exits 2, not its own status",
             review(agent_call("fleet:gpt-6-luna", effort="high"), None, failing_env), 2, "unexpected error (status 5)"),
            ("4/another plugin's type is not a fleet target: a fleet caller cannot reach it",
             review(agent_call("other:gpt-6-luna", "fleet:claude-fable-5-1", effort="high")), 2,
             "'other:gpt-6-luna' is not a fleet agent"),
            ("4/another plugin's type is not checked as a fleet target from the main session",
             review(agent_call("other:gpt-6-luna", effort="high"), luna_rules), 0, ""),
            ("5/a model override is refused while main.fleet is empty",
             review(agent_call("fleet:gpt-6-luna", model="opus", effort="high")), 2, "carry their own model"),
            ("7/an empty agent_id is the main session, whatever agent_type says",
             review(json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Agent",
                                "agent_type": "fleet:claude-fable-5-1",
                                "tool_input": {"subagent_type": "fleet:claude-fable-5-1", "effort": "high",
                                               "prompt": brief()}})), 0, ""),
            ("8/main: a missing effort lists the levels main.fleet allows",
             review(agent_call("fleet:gpt-6-luna"), luna_rules), 2, "pass effort as one of low, the level"),
            ("8/main: a relative effort lists the levels main.fleet allows",
             review(agent_call("fleet:gpt-6-luna", effort="higher"), luna_rules), 2, "of 'gpt-6-luna' (low), the one"),
            ("8/main: an off-level effort lists the levels main.fleet allows",
             review(agent_call("fleet:gpt-6-luna", effort="ultra"), luna_rules), 2, "The levels available here: low."),
            ("8/nested: a missing effort lists the levels the caller's row allows",
             review(agent_call("fleet:gpt-6-luna", "fleet:gpt-6-luna"), luna_rules), 2,
             "pass effort as one of high, the level"),
            ("6/an effort entry 'lower' refuses calls to that model as a configuration error",
             review(agent_call("fleet:gpt-6-luna", effort="low"), json.dumps({"main": {"fleet": {"gpt-6-luna": ["lower"]}}})),
             2, 'the effort entries "lower", which are not levels'),
            ("6/an effort entry 'ultra' refuses calls to that model as a configuration error",
             review(agent_call("fleet:gpt-6-luna", effort="low"),
                    json.dumps({"main": {"fleet": {"gpt-6-luna": ["low", "ultra"]}}})),
             2, 'the effort entries "ultra", which are not levels'),
        ]
        for name, result, code, text in review_cases:
            check("review/" + name, result.returncode == code and not result.stdout
                  and (text in result.stderr if code else not result.stderr),
                  "rc=%r stderr=%r" % (result.returncode, result.stderr))

        # ---- second review round ----------------------------------------------------------------
        # Reproductions from the second 0.10.0 review, numbered by its items, on the same copy.
        # Every case gave another exit code or another message on 5e1656f.
        def luna_call(tool, **tool_input):
            return json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "agent_type": "fleet:gpt-6-luna",
                               "agent_id": "a1", "tool_input": tool_input})

        def main_builtin(model):
            return agent_call("general-purpose", model=model)

        luna_row = {"rules": {"gpt-6-luna": {}}}
        null_effort = json.dumps({"main": {"fleet": {}}, "rules": {"gpt-6-luna": {"gpt-5.6-terra": [None]}}})
        closed_main = json.dumps({"main": {"fleet": {"gpt-6-luna": ["low"], "gpt-5.6-terra": []}},
                                  "rules": {"gpt-5.6-terra": {"gpt-6-luna": ["high"]}}})
        closed_rows = json.dumps({"main": {"fleet": {"gpt-6-luna": ["low"]}},
                                  "rules": {"gpt-6-luna": {"gpt-6-luna": ["low"], "claude-haiku-4-5": []},
                                            "gpt-5.6-terra": {"gpt-6-luna": ["high"], "claude-haiku-4-5": ["default"]}}})
        review2_cases = [
            ("1/a null effort entry is a configuration error, not erased",
             review(agent_call("fleet:gpt-5.6-terra", effort="low"), null_effort), 2,
             "give 'gpt-5.6-terra' the effort entries null, which are not levels"),
            ("1/a skill named \"null\" in disallowed_skills is refused",
             review(luna_call("Skill", skill="null"), json.dumps(dict(luna_row, disallowed_skills=["null"]))), 2,
             "skill 'null' is not available from a fleet agent"),
            ("1/a command named \"null\" in disallowed_commands is refused",
             review(luna_call("Bash", command="null --flag"), json.dumps(dict(luna_row, disallowed_commands=["null"]))),
             2, "'null' is not available from a fleet agent"),
            ("1/a null entry in a denylist denies nothing",
             review(luna_call("Bash", command="ls"), json.dumps(dict(luna_row, disallowed_commands=[None]))), 0, ""),
            ("1/a denylist entry that is neither a string nor null fails closed",
             review(luna_call("Skill", skill="any"), json.dumps(dict(luna_row, disallowed_skills=[5]))), 2,
             "could not be read"),
            ("2/rules changed to {}: a running fleet agent cannot start a built-in agent",
             review(agent_call("general-purpose", "fleet:gpt-6-luna"), "{}"), 2,
             "runs on 'gpt-6-luna', which is no longer in the fleet rules in force"),
            ("2/rules changed to {}: a running fleet agent cannot run Bash",
             review(luna_call("Bash", command="ls"), "{}"), 2,
             "runs on 'gpt-6-luna', which is no longer in the fleet rules in force"),
            ("2/rules that drop the caller's model: its bare type is refused too",
             review(luna_call("Bash", command="ls").replace('"fleet:gpt-6-luna"', '"gpt-6-luna"'),
                    json.dumps({"main": {"fleet": {"gpt-6-astra": ["low"]}}})), 2,
             "which is no longer in the fleet rules in force"),
            ("2/rules whose fleet cannot be read: a caller with a definition is refused",
             review(luna_call("Bash", command="ls"), json.dumps({"rules": {"gpt-6-luna": {}, "gpt-6-astra": "x"}})), 2,
             "could not be read"),
            ("3/an entry that is not a valid regex is matched literally: foo( is refused",
             review(luna_call("Bash", command="foo( bar"), json.dumps(dict(luna_row, disallowed_commands=["foo("]))), 2,
             "'foo(' is not available from a fleet agent"),
            ("3/an entry is not a pattern: a.b does not refuse axb",
             review(luna_call("Bash", command="axb"), json.dumps(dict(luna_row, disallowed_commands=["a.b"]))), 0, ""),
            ("3/an entry is not split into words: 'rm -rf' does not refuse 'rm -r x'",
             review(luna_call("Bash", command="rm -r x"), json.dumps(dict(luna_row, disallowed_commands=["rm -rf"]))),
             0, ""),
            ("3/a phrase entry is refused as a phrase",
             review(luna_call("Bash", command="rm -rf x"), json.dumps(dict(luna_row, disallowed_commands=["rm -rf"]))),
             2, "'rm -rf' is not available from a fleet agent"),
            ("4/an allowlist entry holding a line break allows neither line",
             review(main_builtin("opus"), json.dumps({"main": {"builtin_agent_models": ["sonnet\nopus"]}})), 2,
             "model 'opus' is not enabled for built-in agents"),
            ("4/a non-string allowlist entry is a configuration error",
             review(main_builtin("opus"), json.dumps({"main": {"builtin_agent_models": ["opus", 5]}})), 2,
             "could not be read"),
            ("4/a listed model still passes", review(main_builtin("opus"),
                                                     json.dumps({"main": {"builtin_agent_models": ["opus"]}})), 0, ""),
            ("5/'Fleet:' is this plugin's prefix: a relative effort is refused",
             review(agent_call("Fleet:gpt-6-luna", effort="lower")), 2, "effort 'lower' is relative"),
            ("5/'FLEET:' is this plugin's prefix: a relative effort is refused",
             review(agent_call("FLEET:gpt-6-luna", effort="lower")), 2, "effort 'lower' is relative"),
            ("5/' fleet:' is this plugin's prefix: a relative effort is refused",
             review(agent_call(" fleet:gpt-6-luna", effort="lower")), 2, "effort 'lower' is relative"),
            ("5/'Fleet:' with a name that resolves to nothing is refused, not passed",
             review(agent_call("Fleet:no-such-model", effort="low")), 2, "is not defined in this fleet"),
            ("6/main: a model main.fleet lists with [] gets the final refusal, no levels offered",
             review(agent_call("fleet:gpt-5.6-terra"), closed_main), 2,
             "'fleet:gpt-5.6-terra' is not enabled for the main session at any effort"),
            ("6/main: a model main.fleet does not list gets the final refusal, no levels offered",
             review(agent_call("fleet:gpt-6-luna", effort="higher"),
                    json.dumps({"main": {"fleet": {"gpt-5.6-terra": ["low"]}},
                                "rules": {"gpt-5.6-terra": {"gpt-6-luna": ["high"]}}})), 2,
             "'fleet:gpt-6-luna' is not enabled for the main session at any effort"),
            ("6/nested: a model the caller's row lists with [] gets the final refusal",
             review(agent_call("fleet:claude-haiku-4-5", "fleet:gpt-6-luna", effort="low"), closed_rows), 2,
             "'fleet:claude-haiku-4-5' is not available from a gpt-6-luna agent at any effort"),
            ("6/nested: a model the caller's row does not list gets the final refusal",
             review(agent_call("fleet:gpt-5.6-terra", "fleet:gpt-6-luna"), closed_rows), 2,
             "'fleet:gpt-5.6-terra' is not available from a gpt-6-luna agent at any effort"),
            ("6/nested: a caller without a row gets the final refusal",
             review(agent_call("fleet:gpt-6-luna", "fleet:gpt-6-astra"),
                    json.dumps({"main": {"fleet": {"gpt-6-astra": ["low"]}},
                                "rules": {"gpt-6-luna": {"gpt-6-luna": ["high"]}}})), 2,
             "no spawn rules exist for a gpt-6-astra agent"),
            ("6/a section that lists the model still offers its levels",
             review(agent_call("fleet:gpt-6-luna", "fleet:gpt-5.6-terra"), closed_rows), 2,
             "pass effort as one of high, the level"),
        ]
        for name, result, code, text in review2_cases:
            check("review2/" + name, result.returncode == code and not result.stdout
                  and (text in result.stderr if code else not result.stderr),
                  "rc=%r stderr=%r" % (result.returncode, result.stderr))
        # The correctable refusals must not be given where the section allows no level.
        result = review(agent_call("fleet:gpt-5.6-terra"), closed_main)
        check("review2/6/main: the final refusal names no effort to pass",
              result.returncode == 2 and "pass effort" not in result.stderr and "Its levels" not in result.stderr,
              result.stderr)
        # SubagentStart hands the agent the denylists as written: an entry "null" is listed.
        result = review(json.dumps(start("fleet:gpt-6-luna")),
                        json.dumps(dict(luna_row, disallowed_skills=["null"], disallowed_commands=["null", None])))
        try:
            context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        except (ValueError, KeyError, TypeError):
            context = ""
        check("review2/1/start: entries named \"null\" are listed, a null entry is not",
              result.returncode == 0 and "Skills you cannot load: null." in context
              and "Commands you cannot run: null." in context, repr((result.returncode, result.stdout, result.stderr)))

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
            # Effort entries outside the six words, and ids that differ only in case, are configuration
            # errors: exit 3, agents/ unchanged, the message names the model and the word or the ids.
            for label, doc, text in [
                    ("an effort entry 'lower'", {"main": {"fleet": {"fixture-model": ["lower"]}}},
                     'gives the model "fixture-model" the effort "lower", which is not a level'),
                    ("an effort entry 'ultra'", {"main": {"fleet": {"fixture-model": ["low", "ultra"]}}},
                     'gives the model "fixture-model" the effort "ultra", which is not a level'),
                    ("ids that differ only in case", {"main": {"fleet": {"Fixture-Model": ["low"], "fixture-model": ["low"]}}},
                     'mentions the models "Fixture-Model" and "fixture-model", whose ids differ only in case')]:
                bad_rules = Path(temporary) / "bad-generation.json"
                bad_rules.write_text(json.dumps(doc))
                for mode, arguments in (("--rules", ["--rules", str(bad_rules)]), ("full run", [])):
                    if not arguments:
                        shutil.copyfile(bad_rules, generation / "fleet.default.json")
                    before = {p.name: p.read_text() for p in (generation / "agents").glob("*.md")}
                    result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh")] + arguments,
                                            text=True, capture_output=True, timeout=10, env=env)
                    check("generator/%s, %s: exit 3, agents/ unchanged, says why" % (label, mode),
                          result.returncode == 3 and text in result.stderr
                          and {p.name: p.read_text() for p in (generation / "agents").glob("*.md")} == before,
                          repr((result.returncode, result.stderr)))
            (generation / "fleet.default.json").write_text(json.dumps({
                "main": {"fleet": {"fixture-model": ["low", "high"], "fixture-plain": ["default"]}},
                "rules": {"fixture-model": {"fixture-bare": ["medium", "low"]}}}))
            # models.json is data only: a default rung beside named ones there is not an error.
            models["models"][0]["efforts"]["default"] = {"index": 1, "usd": 1, "tps": 1}
            (generation / "models.json").write_text(json.dumps(models))
            result = subprocess.run(shell + [str(generation / "scripts/generate-agents.sh")],
                                    text=True, capture_output=True, timeout=10, env=env)
            check("generator/models.json: a default rung beside named ones is accepted", result.returncode == 0,
                  result.stderr)
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
