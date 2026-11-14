#!/usr/bin/env python3
"""Test the guard's supervisor and worker, MCP mode, the payload field types, the agent-type
queries and the global MCP lists at a fleet subagent's call, on a copy of the plugin."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

GUARD_COMMAND = 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/subagent-guard.sh" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"'
FLEET_CALLER = "fleet:claude-opus-5-5"
FINAL = "do not retry"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--shell", nargs="+", default=["/bin/sh"])
    args = parser.parse_args()
    root = args.fleet_root.resolve()
    interpreter = shutil.which(args.shell[0])
    if not interpreter:
        parser.error("Requested shell is unavailable")
    shell = [interpreter] + args.shell[1:]
    env = os.environ.copy()
    env.pop("FLEET_RULES", None)
    real_jq = shutil.which("jq")
    errors = []
    count = 0

    def check(name, condition, detail=""):
        nonlocal count
        count += 1
        print("%s %d - %s" % ("ok" if condition else "not ok", count, name))
        if not condition:
            errors.append(name + ": " + str(detail))

    # ---- the hook wiring ---------------------------------------------------------------------
    config = json.loads((root / "hooks/hooks.json").read_text())
    groups = config["hooks"].get("PreToolUse", [])
    mcp_groups = [g for g in groups if g.get("matcher") == "^mcp__.*$"]
    check("wiring/one ^mcp__.*$ group runs the guard in MCP mode with a 5 second timeout",
          len(mcp_groups) == 1 and mcp_groups[0].get("hooks") == [
              {"type": "command", "command": GUARD_COMMAND + " mcp", "timeout": 5}], mcp_groups)
    check("wiring/the Agent, Bash, Skill and Workflow group is unchanged",
          [g for g in groups if g.get("matcher") == "Agent|Bash|Skill|Workflow"] == [
              {"matcher": "Agent|Bash|Skill|Workflow",
               "hooks": [{"type": "command", "command": GUARD_COMMAND, "timeout": 5}]}])
    check("wiring/every hook entry has a timeout",
          all("timeout" in h for event in config["hooks"].values() for g in event for h in g.get("hooks", [])))
    check("wiring/the description no longer says the guard sees only Agent, Skill, Workflow and Bash calls",
          "Before every Agent, Skill, Workflow and Bash call" not in config.get("description", "")
          and "MCP" in config.get("description", ""))

    with tempfile.TemporaryDirectory(prefix="fleet-mcp-guard-test-") as temporary:
        base = Path(temporary)

        def make_plugin(name, scripts=("subagent-guard.sh", "fleet-rules.sh", "mcp-policy.sh")):
            plugin = base / name
            (plugin / "scripts").mkdir(parents=True)
            for filename in scripts:
                if (root / "scripts" / filename).is_file():
                    shutil.copyfile(root / "scripts" / filename, plugin / "scripts" / filename)
            shutil.copytree(root / "agents", plugin / "agents")
            shutil.copyfile(root / "fleet.default.json", plugin / "fleet.default.json")
            (plugin / ".claude-plugin").mkdir()
            shutil.copyfile(root / ".claude-plugin/plugin.json", plugin / ".claude-plugin/plugin.json")
            return plugin

        plugin = make_plugin("fleet")
        guard_path = plugin / "scripts/subagent-guard.sh"
        shipped = json.loads((root / "fleet.default.json").read_text())
        rules_file = base / "rules.json"

        def stub(name, body):
            """A directory holding a jq that runs body first, put before the real one on PATH."""
            directory = base / name
            directory.mkdir()
            (directory / "jq").write_text("#!/bin/sh\n%s\nexec '%s' \"$@\"\n" % (body, real_jq))
            (directory / "jq").chmod(0o755)
            return {"PATH": "%s%s%s" % (directory, os.pathsep, env.get("PATH", ""))}

        # A PATH with the base utilities and no jq.
        nojq = base / "nojq-bin"
        nojq.mkdir()
        for tool in ("cat", "grep", "awk", "sed", "mkdir", "rm", "mv", "cp", "dirname", "basename", "tail", "head",
                     "sort", "tr", "wc", "ls", "cmp", "mktemp", "sleep", "touch", "cut", "env", "date", "kill"):
            found = shutil.which(tool)
            if found:
                (nojq / tool).symlink_to(found)
        nojq_env = {"PATH": str(nojq)}
        check("fixture/the PATH without jq holds no jq", shutil.which("jq", path=str(nojq)) is None)

        def call(tool="mcp__gateway__vault__search", caller=None, agent_id="a1", **extra):
            """A PreToolUse payload of the measured shape; caller None is the main session, whose
            payload has neither agent_id nor agent_type."""
            data = {"session_id": "s1", "transcript_path": "/home/u/.claude/projects/p/s1.jsonl", "cwd": "/",
                    "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": tool,
                    "tool_input": {"query": "SECRET-ARGUMENT"}, "tool_use_id": "t1", "prompt_id": "p1"}
            if caller is not None:
                data.update(agent_id=agent_id, agent_type=caller)
            data.update(extra)
            return data

        def guard(payload, rules=None, extra_env=None, script=None, arguments=None, mode="mcp"):
            run_env = dict(env, **(extra_env or {}))
            if rules is not None:
                rules_file.write_text(rules if isinstance(rules, str) else json.dumps(rules))
                run_env["FLEET_RULES"] = str(rules_file)
            if arguments is None:
                arguments = [str(plugin), ""] + ([mode] if mode else [])
            started = time.monotonic()
            try:
                result = subprocess.run(shell + [str(script or guard_path)] + arguments,
                                        input=payload if isinstance(payload, str) else json.dumps(payload),
                                        capture_output=True, text=True, timeout=20, env=run_env)
            except subprocess.TimeoutExpired:
                return None, "", "timed out", time.monotonic() - started
            return result.returncode, result.stdout, result.stderr, time.monotonic() - started

        def expect(name, outcome, code, text="", absent=None):
            rc, out, err, elapsed = outcome
            check(name, rc == code and not out and (text in err if code else not err)
                  and (absent is None or absent not in err), (rc, out, err, round(elapsed, 2)))

        # ---- the deadline and the pipes ------------------------------------------------------
        stall_env = stub("stall-jq", "sleep 10")
        for label, payload, mode in (("a fleet agent's MCP call", call(caller=FLEET_CALLER), "mcp"),
                                     ("a subagent's Bash call", call(tool="Bash", caller="Explore"), None)):
            rc, out, err, elapsed = guard(payload, extra_env=stall_env, mode=mode)
            check("deadline/%s with a stalled jq: refused, both pipes closed within 4 seconds" % label,
                  rc == 2 and elapsed < 4 and "did not finish within 3 seconds" in err, (rc, err, round(elapsed, 2)))
        rc, out, err, elapsed = guard(call(tool="Bash"), mode=None)
        check("deadline/a passing run closes both pipes at once: no process it started holds them",
              rc == 0 and not out and not err and elapsed < 2.5, (rc, err, round(elapsed, 2)))
        rc, out, err, elapsed = guard({"hook_event_name": "SubagentStart", "agent_id": "a1",
                                       "agent_type": FLEET_CALLER}, mode=None)
        try:
            context = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        except (ValueError, KeyError, TypeError):
            context = ""
        check("deadline/the worker's stdout reaches the hook's stdout",
              rc == 0 and "Skills you cannot load" in context and elapsed < 2.5, (rc, out, err, round(elapsed, 2)))

        # ---- an end the script did not decide ------------------------------------------------
        expect("worker/the guard without arguments is refused", guard(call(tool="Bash"), arguments=[]), 2)
        source = guard_path.read_text()
        anchor = "\ntrap 'exit 2' HUP INT TERM\n"
        for label, line in (("an unset variable", ': "$fleet_test_never_set"'),
                            ("a failed ${x:?}", ': "${fleet_test_never_set:?}"'),
                            ("an exit 0 without the pass marker", "exit 0")):
            patched = plugin / "scripts" / ("patched-%d.sh" % count)
            patched.write_text(source.replace(anchor, anchor + line + "\n", 1))
            check("worker/fixture: %s is placed in the worker" % label, source.count(anchor) == 1)
            rc, out, err, elapsed = guard(call(tool="Bash"), script=patched, mode=None)
            check("worker/%s in the worker refuses a call that would pass" % label, rc == 2 and not out,
                  (rc, out, err))

        # ---- signals to the supervisor -------------------------------------------------------
        ready_env = stub("ready-jq", ': > "$FLEET_TEST_READY"\nsleep 10')
        for signum in (signal.SIGTERM, signal.SIGUSR1):
            ready = base / ("ready-%d" % signum)
            run_env = dict(env, **ready_env)
            run_env["FLEET_TEST_READY"] = str(ready)
            process = subprocess.Popen(shell + [str(guard_path), str(plugin), "", "mcp"], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=run_env)
            process.stdin.write(json.dumps(call(caller=FLEET_CALLER)))
            process.stdin.close()
            limit = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < limit:
                time.sleep(0.02)
            was_ready = ready.exists()
            sent = time.monotonic()
            process.send_signal(signum)
            try:
                out, err = process.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                out, err = process.communicate()
            elapsed = time.monotonic() - sent
            check("signal/%s to the supervisor while the worker is stalled: refused at once" % signum.name,
                  was_ready and process.returncode == 2 and "Refused" in err and elapsed < 2,
                  (was_ready, process.returncode, err, round(elapsed, 2)))

        # ---- a directory the supervisor cannot make ------------------------------------------
        expect("tempdir/no temporary directory: even the main session's call is refused",
               guard(call(tool="Bash"), extra_env={"TMPDIR": str(base / "missing" / "tmp")}, mode=None), 2,
               "temporary directory")

        # ---- who is governed -----------------------------------------------------------------
        expect("main/an MCP call passes with the default rules", guard(call()), 0)
        expect("main/an MCP call passes without jq", guard(call(), extra_env=nojq_env), 0)
        expect("main/an MCP call passes with the rules file missing",
               guard(call(), extra_env={"FLEET_RULES": str(base / "missing.json")}), 0)
        expect("main/an MCP call passes with an invalid rules file", guard(call(), rules="{not json"), 0)
        expect("main/an MCP call passes while the MCP lists are invalid",
               guard(call(), rules=dict(shipped, allowed_mcp_tools="mcp__x")), 0)
        # The text test only lets the main session through: a payload holding "agent_id" anywhere
        # goes on to the checks.
        holding = call()
        holding["tool_input"] = {"agent_id": "x"}
        expect("main/a payload holding the text \"agent_id\" goes on to the checks: passes with jq",
               guard(holding), 0)
        expect("main/a payload holding the text \"agent_id\" goes on to the checks: refused without jq",
               guard(holding, extra_env=nojq_env), 2, "needs jq")
        expect("main/an agent_id of null is the main session", guard(call(caller=FLEET_CALLER, agent_id=None)), 0)
        expect("builtin/an MCP call passes with the default rules", guard(call(caller="Explore")), 0)
        expect("builtin/an MCP call is refused without jq", guard(call(caller="Explore"), extra_env=nojq_env), 2,
               "needs jq")
        expect("builtin/an MCP call passes while the MCP lists are invalid",
               guard(call(caller="Explore"), rules=dict(shipped, disallowed_mcp_tools=["bad"])), 0)
        expect("fleet/an MCP call is refused with the rules file missing",
               guard(call(caller=FLEET_CALLER), extra_env={"FLEET_RULES": str(base / "missing.json")}), 2,
               "rules file not found")
        expect("fleet/an MCP call is refused with an invalid rules file",
               guard(call(caller=FLEET_CALLER), rules="{not json"), 2, "rules file is invalid")

        # A jq that fails only the agent-type query: a fleet caller is refused, not passed as built-in.
        prefix_env = stub("prefix-jq", 'case "$*" in *ascii_downcase*) exit 5 ;; esac')
        expect("resolve/a failed agent-type query refuses a fleet caller's MCP call",
               guard(call(caller=FLEET_CALLER), extra_env=prefix_env), 2, "could not be resolved")
        expect("resolve/a failed agent-type query refuses a fleet caller's Bash call",
               guard(call(tool="Bash", caller=FLEET_CALLER), extra_env=prefix_env, mode=None), 2,
               "could not be resolved")
        expect("resolve/a failed agent-type query refuses another plugin's agent",
               guard(call(caller="other:agent"), extra_env=prefix_env), 2, "could not be resolved")
        expect("resolve/a built-in caller needs no prefix query and passes",
               guard(call(caller="Explore"), extra_env=prefix_env), 0)

        # Payload field types: a value of another type cannot read as "no agent".
        for field, value in (("agent_id", 5), ("agent_id", True), ("agent_id", {}), ("agent_id", ["a1"]),
                             ("agent_type", 5), ("agent_type", ["fleet:x"]), ("tool_name", 5),
                             ("hook_event_name", []), ("transcript_path", {})):
            payload = call(caller="Explore")
            payload[field] = value
            expect("types/%s of type %s is refused in MCP mode" % (field, type(value).__name__), guard(payload), 2,
                   "strings or null")
        payload = call(tool="Bash")
        payload["agent_id"] = 5
        expect("types/an agent_id number on a Bash call is refused", guard(payload, mode=None), 2, "strings or null")
        payload = call(tool="Bash", caller="Explore")
        payload["transcript_path"] = None
        expect("types/null fields pass", guard(payload, mode=None), 0)

        # ---- a fleet agent's MCP call against the global lists -------------------------------
        expect("fleet/both lists empty (the shipped rules): passes", guard(call(caller=FLEET_CALLER)), 0)
        expect("fleet/both keys missing: passes",
               guard(call(caller=FLEET_CALLER), rules={k: v for k, v in shipped.items() if "mcp" not in k}), 0)
        deny = dict(shipped, disallowed_mcp_tools=["mcp__gateway__*"])
        expect("fleet/a global deny rule refuses",
               guard(call(caller=FLEET_CALLER), rules=deny), 2,
               'FLEET_MCP_DENIED: "mcp__gateway__vault__search": the global rule "mcp__gateway__*" denies it.\n',
               "SECRET-ARGUMENT")
        rc, out, err, elapsed = guard(call(caller=FLEET_CALLER), rules=deny)
        check("fleet/the refusal is final and starts the message", err.startswith("FLEET_MCP_DENIED: ")
              and FINAL in err and "report" in err, err)
        expect("fleet/a global deny rule leaves other tools alone",
               guard(call(tool="mcp__mail__read", caller=FLEET_CALLER), rules=deny), 0)
        allow = dict(shipped, allowed_mcp_tools=["mcp__gateway*"])
        expect("fleet/a global allow rule that matches passes", guard(call(caller=FLEET_CALLER), rules=allow), 0)
        expect("fleet/a non-empty global allow list without a match refuses",
               guard(call(tool="mcp__mail__send", caller=FLEET_CALLER), rules=allow), 2,
               'FLEET_MCP_DENIED: "mcp__mail__send": no allow rule matches it (global and this agent\'s brief).\n')
        both = dict(shipped, allowed_mcp_tools=["mcp__mail__*"], disallowed_mcp_tools=["mcp__mail__send"])
        expect("fleet/a global deny wins over a global allow",
               guard(call(tool="mcp__mail__send", caller=FLEET_CALLER), rules=both), 2,
               'the global rule "mcp__mail__send" denies it.')
        expect("fleet/the bare type of a fleet agent is governed too",
               guard(call(caller="claude-opus-5-5"), rules=deny), 2, "FLEET_MCP_DENIED")
        for label, rules in (("an allow list of the wrong type", dict(shipped, allowed_mcp_tools="mcp__x")),
                             ("a deny list of the wrong type", dict(shipped, disallowed_mcp_tools={})),
                             ("an invalid rule", dict(shipped, disallowed_mcp_tools=["gateway__*"])),
                             ("a null entry", dict(shipped, allowed_mcp_tools=[None])),
                             ("257 rules", dict(shipped, allowed_mcp_tools=["mcp__t%d" % i for i in range(257)]))):
            expect("fleet/%s is a configuration error" % label, guard(call(caller=FLEET_CALLER), rules=rules), 2,
                   "FLEET_MCP_ERROR: invalid MCP rules in %s\n" % rules_file)
        expect("fleet/a tool name outside printable ASCII is refused",
               guard(call(tool="mcp__gateway__é", caller=FLEET_CALLER)), 2, "FLEET_MCP_ERROR: invalid tool name")
        # The fleet is every model the rules mention, as a caller or as a target.
        without_opus = {k: {t: v for t, v in row.items() if t != "claude-opus-5-5"}
                        for k, row in shipped["rules"].items() if k != "claude-opus-5-5"}
        expect("fleet/a fleet agent whose model left the rules is refused",
               guard(call(caller=FLEET_CALLER), rules=dict(shipped, rules=without_opus)),
               2, "no longer in the fleet rules")

        # Without the policy library nothing a fleet agent calls passes.
        bare = make_plugin("bare", scripts=("subagent-guard.sh", "fleet-rules.sh"))
        expect("library/a missing mcp-policy.sh refuses a fleet agent's MCP call",
               guard(call(caller=FLEET_CALLER), arguments=[str(bare), "", "mcp"],
                     script=bare / "scripts/subagent-guard.sh"), 2, "library is missing")

    print("Guard checks: %d; failures: %d" % (count, len(errors)))
    for error in errors:
        print("FAIL " + error)
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
