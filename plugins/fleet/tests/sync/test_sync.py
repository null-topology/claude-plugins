#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["pyyaml"]
# ///
"""Test the agent sync and the guard's handling of fleet agent types without a definition file.

Runs generate-agents.sh --rules, sync-agents.sh and subagent-guard.sh from a Fleet checkout on
synthetic hook payloads, in temporary copies of the plugin. The guard is the oracle for
reachability: an agent is reachable when the guard lets the main session start it, or lets an
agent of a reachable model start it; the synced agents/ must hold exactly those. The checks prove
the scripts' behaviour on the payloads given. How Claude Code dispatches SessionStart and
FileChanged, honours watchPaths and reloads agents is not covered here.
"""
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
import time

import yaml  # the agents' frontmatter is checked with a YAML parser

SCRIPTS = ("subagent-guard.sh", "fleet-rules.sh", "generate-agents.sh", "sync-agents.sh",
           "seed-rules.sh", "delegation-contract.sh")
REFERENCE = "skills/selecting-subagent-model/references/benchmark.md"
SYNC_COMMAND = 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/sync-agents.sh" "${CLAUDE_PLUGIN_ROOT}" "${CLAUDE_PLUGIN_DATA}"'


def figures(index):
    return {"index": index, "usd": index / 10, "tps": 50}


SYNTHETIC_MODELS = {
    "snapshot": {"benchmark": "Fixture Index", "date": "2026-01-01"},
    "models": [
        {"id": "m-a", "name": "Model A", "efforts": {"low": figures(10), "high": figures(20)}},
        {"id": "m-b", "name": "Model B", "efforts": {"low": figures(11), "high": figures(21)}},
        {"id": "m-c", "name": "Model C", "efforts": {"default": figures(5)}},
        {"id": "m-d", "name": "Model D", "efforts": {"low": figures(3)}},
    ],
}
EVERY_SYNTHETIC = {"m-a-low", "m-a-high", "m-b-low", "m-b-high", "m-c", "m-d-low"}

# Rules shapes and what the guard lets anyone reach under each. The expectations are written out
# so that the oracle is checked as well as the sync.
SYNTHETIC_CASES = [
    ("empty object allows everything", {}, EVERY_SYNTHETIC),
    ("null document reads as empty rules", None, EVERY_SYNTHETIC),
    ("main lists one pair, its row reaches a default rung",
     {"main": {"fleet": {"m-a": ["low"]}}, "rules": {"m-a": {"m-c": ["default"]}}}, {"m-a-low", "m-c"}),
    ("empty rules section opens every spawn",
     {"main": {"fleet": {"m-a": ["high"]}}, "rules": {}}, EVERY_SYNTHETIC),
    ("caller model without a row reaches nothing",
     {"main": {"fleet": {"m-a": ["low"]}}, "rules": {"m-b": {"m-d": ["low"]}}}, {"m-a-low"}),
    ("chain through a default rung",
     {"main": {"fleet": {"m-c": ["default"]}}, "rules": {"m-c": {"m-d": ["low"]}, "m-d": {"m-b": ["high"]}}},
     {"m-c", "m-d-low", "m-b-high"}),
    ("empty main section allows every agent from main",
     {"main": {"fleet": {}}, "rules": {"m-a": {}}}, EVERY_SYNTHETIC),
    ("main lists a model with no efforts", {"main": {"fleet": {"m-a": []}}}, set()),
    ("unknown effort is ignored",
     {"main": {"fleet": {"m-a": ["low", "ultra"]}}, "rules": {"m-a": {"m-a": ["ultra"]}}}, {"m-a-low"}),
]

NARROW_EXPECTED = (
    {"gpt-6-astra-low", "gpt-6-astra-medium"}
    | {f"{model}-{effort}" for model in ("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5")
       for effort in ("low", "medium", "high", "xhigh")}
    | {f"{model}-{effort}" for model in ("gpt-6.1-sol", "gpt-6-luna")
       for effort in ("low", "medium", "high", "xhigh", "max")}
)


def altered(change):
    """A copy of the synthetic models with one change applied to it."""
    models = json.loads(json.dumps(SYNTHETIC_MODELS))
    change(models)
    return models


# Models files that parse but do not have the shape the renderer and the reference need. The first
# is the reproduced failure: a string cost passed the old check, the agents were installed, and the
# reference jq then failed halfway, leaving the reference truncated.
MISSHAPEN_MODELS = (
    ("a usd given as a string", lambda m: m["models"][0]["efforts"]["low"].update(usd="2.37")),
    ("an index given as a string", lambda m: m["models"][0]["efforts"]["low"].update(index="10")),
    ("a tps given as a string", lambda m: m["models"][1]["efforts"]["high"].update(tps="fast")),
    ("a zero usd", lambda m: m["models"][0]["efforts"]["high"].update(usd=0)),
    ("usd_estimated not a boolean", lambda m: m["models"][0]["efforts"]["low"].update(usd_estimated="yes")),
    ("provisional not a boolean", lambda m: m["models"][1].update(provisional="true")),
    ("an effort that is not an object", lambda m: m["models"][2]["efforts"].update(default=5)),
    ("an unknown effort rung", lambda m: m["models"][3]["efforts"].update(ultra=figures(4))),
    ("a model id that is a path", lambda m: m["models"][3].update(id="../m-d")),
    ("a model without a name", lambda m: m["models"][3].pop("name")),
    ("no snapshot", lambda m: m.pop("snapshot")),
    # Text that no quoting in the agent's frontmatter carries as written, and ids written unquoted
    # that YAML would read as something other than a string.
    ("an empty name", lambda m: m["models"][0].update(name="")),
    ("a name with a line break", lambda m: m["models"][0].update(name="Model\nA")),
    ("a name with a tab", lambda m: m["models"][0].update(name="Model\tA")),
    ("a name with a line separator", lambda m: m["models"][0].update(name="Model A")),
    ("a name with a C1 control character", lambda m: m["models"][0].update(name="Model\u0085A")),
    ("a snapshot benchmark with a control character", lambda m: m["snapshot"].update(benchmark="Index\x1b[1m")),
    ("a model id YAML reads as a boolean", lambda m: m["models"][3].update(id="yes")),
    ("a model id YAML reads as a number", lambda m: m["models"][3].update(id="10")),
)


def catalog_of(models):
    """Agent name to (model, effort), the last entry winning as the generator's last file does."""
    names = {}
    for model in models["models"]:
        for effort in model.get("efforts", {}):
            names[model["id"] if effort == "default" else f'{model["id"]}-{effort}'] = (model["id"], effort)
    return names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--shell", nargs="+", default=["/bin/sh"])
    args = parser.parse_args()
    source = args.fleet_root.resolve()
    for path in [f"scripts/{name}" for name in SCRIPTS] + ["templates/agent.md", "hooks/hooks.json",
                                                           "models.json", "fleet.default.json",
                                                           ".claude-plugin/plugin.json"]:
        if not (source / path).is_file():
            parser.error("missing " + str(source / path))
    interpreter = shutil.which(args.shell[0])
    if not interpreter:
        parser.error("Requested shell is unavailable")
    shell = [interpreter] + args.shell[1:]
    base_env = {k: v for k, v in os.environ.items() if k not in ("FLEET_RULES", "FLEET_SYNC_AGENTS")}
    narrow_rules = Path(__file__).resolve().parent / "fixtures" / "narrow-rules.json"
    errors = []
    count = 0

    def check(name, condition, detail=""):
        nonlocal count
        count += 1
        print("%s %d - %s" % ("ok" if condition else "not ok", count, name))
        if not condition:
            errors.append(name + (": " + str(detail) if detail else ""))

    def run(command, payload=None, env=None, cwd=None, timeout=120):
        environment = dict(base_env)
        environment.update(env or {})
        try:
            process = subprocess.run([str(part) for part in command],
                                     # A string is sent as written (raw JSON text), anything else as JSON.
                                     input=("" if payload is None else payload if isinstance(payload, str)
                                            else json.dumps(payload)),
                                     capture_output=True, text=True, env=environment, cwd=cwd, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, "", f"timed out after {timeout}s"
        return process.returncode, process.stdout, process.stderr

    def generate(root, rules=None, env=None, timeout=120):
        command = shell + [root / "scripts/generate-agents.sh"] + (["--rules", rules] if rules is not None else [])
        return run(command, env=env, timeout=timeout)

    def frontmatter_of(path):
        lines = path.read_text().split("\n")
        return yaml.safe_load("\n".join(lines[1:lines.index("---", 1)]))

    def dead_pid():
        process = subprocess.Popen(["true"])
        process.wait()
        return process.pid

    def make_root(base, name, models=None, default_rules=None):
        root = base / name
        (root / "scripts").mkdir(parents=True)
        for script in SCRIPTS:
            shutil.copyfile(source / "scripts" / script, root / "scripts" / script)
        (root / "templates").mkdir()
        shutil.copyfile(source / "templates/agent.md", root / "templates/agent.md")
        (root / ".claude-plugin").mkdir()
        shutil.copyfile(source / ".claude-plugin/plugin.json", root / ".claude-plugin/plugin.json")
        if models is None:
            shutil.copyfile(source / "models.json", root / "models.json")
        else:
            (root / "models.json").write_text(json.dumps(models))
        if default_rules is None:
            shutil.copyfile(source / "fleet.default.json", root / "fleet.default.json")
        else:
            (root / "fleet.default.json").write_text(json.dumps(default_rules))
        code, _, err = generate(root)
        if code != 0:
            raise SystemExit("fixture generation failed: " + err)
        return root

    def kept(root):
        return {path.stem for path in (root / "agents").glob("*.md")}

    def snapshot(root):
        state = {}
        for path in sorted((root / "agents").iterdir()):
            if path.is_dir():
                continue
            stat = path.stat()
            state[path.name] = (stat.st_ino, stat.st_mtime_ns, path.read_bytes())
        return state

    def reference_state(root):
        path = root / REFERENCE
        return path.stat().st_mtime_ns, path.read_bytes()

    def guard(root, payload, rules=None, data=""):
        env = {"FLEET_RULES": str(rules)} if rules else {}
        return run(shell + [root / "scripts/subagent-guard.sh", root, data], payload, env)

    def main_call(target, model=""):
        tool_input = {"subagent_type": target, "prompt": "x"}
        if model:
            tool_input["model"] = model
        return {"hook_event_name": "PreToolUse", "tool_name": "Agent", "agent_id": "", "agent_type": "",
                "tool_input": tool_input}

    def nested_call(caller, tool="Agent", **tool_input):
        return {"hook_event_name": "PreToolUse", "tool_name": tool, "agent_id": "agent-1",
                "agent_type": caller, "tool_input": tool_input}

    def oracle(root, rules, catalog, pool):
        """The agents the guard lets anyone reach under the rules file, asked one call at a time."""
        names = sorted(catalog)

        def passes(payload):
            return guard(root, payload, rules)[0] == 0

        reach = {n for n, ok in zip(names, pool.map(lambda n: passes(main_call("fleet:" + n)), names)) if ok}
        expanded = set()
        while True:
            pending = sorted({catalog[n][0] for n in reach} - expanded)
            if not pending:
                return reach
            for model in pending:
                caller = "fleet:" + min(n for n in reach if catalog[n][0] == model)
                found = list(pool.map(lambda n: passes(nested_call(caller, subagent_type="fleet:" + n)), names))
                reach |= {n for n, ok in zip(names, found) if ok}
                expanded.add(model)

    def sync(root, data, payload, env=None, cwd=None):
        code, out, err = run(shell + [root / "scripts/sync-agents.sh", root, data], payload, env, cwd)
        try:
            parsed = json.loads(out) if out.strip() else None
        except json.JSONDecodeError:
            parsed = "not JSON: " + out
        return code, parsed, err

    def session_start(source_name, session=None):
        payload = {"hook_event_name": "SessionStart", "source": source_name}
        if session:
            payload["session_id"] = session
        return payload

    def file_changed(path, event="change", session=None):
        payload = {"hook_event_name": "FileChanged", "file_path": str(path), "event": event}
        if session:
            payload["session_id"] = session
        return payload

    def message(output):
        return output.get("systemMessage", "") if isinstance(output, dict) else ""

    def context_of(output):
        if not isinstance(output, dict):
            return ""
        return output.get("hookSpecificOutput", {}).get("additionalContext", "")

    def no_temporaries(root):
        return not [p.name for p in (root / "agents").iterdir() if p.name.startswith(".")]

    # ---- configuration ----------------------------------------------------------------------
    hooks = json.loads((source / "hooks/hooks.json").read_text())["hooks"]
    for event in ("SessionStart", "FileChanged"):
        groups = hooks.get(event, [])
        handlers = groups[0].get("hooks", []) if len(groups) == 1 else []
        check(f"configuration/{event} is one group without a matcher running the sync",
              len(groups) == 1 and "matcher" not in groups[0] and len(handlers) == 1
              and handlers[0].get("type") == "command" and handlers[0].get("command") == SYNC_COMMAND
              and handlers[0].get("timeout", 600) >= 10 and not handlers[0].get("async", False), groups)
    check("configuration/seeding runs only inside the sync, so it comes first",
          not any("seed-rules.sh" in handler.get("command", "")
                  for groups in hooks.values() for group in groups for handler in group.get("hooks", [])))
    description = json.loads((source / "hooks/hooks.json").read_text()).get("description", "")
    check("configuration/the description states the rules-file check the guard applies",
          "not exactly one JSON object" in description and "several documents" in description
          and "not valid JSON makes" not in description, description)
    # The subagents documentation says a plugin subagent whose frontmatter does not parse still
    # loads under its file name, and names `claude plugin validate` as the check for it.
    readme = " ".join((source / "README.md").read_text().split())
    check("configuration/the README states what the docs say of frontmatter that does not parse",
          "still loads, under its file name" in readme and "claude plugin validate" in readme
          and "skips an agent whose frontmatter" not in readme, None)

    with tempfile.TemporaryDirectory(prefix="fleet-sync-test-") as temporary, ThreadPoolExecutor(16) as pool:
        base = Path(temporary)

        # ---- reachability parity with the guard -------------------------------------------
        synthetic_oracle = make_root(base, "synthetic-oracle", SYNTHETIC_MODELS, {})
        synthetic_work = make_root(base, "synthetic-work", SYNTHETIC_MODELS, {})
        synthetic_catalog = catalog_of(SYNTHETIC_MODELS)
        for index, (name, rules, expected) in enumerate(SYNTHETIC_CASES):
            rules_file = base / f"synthetic-rules-{index}.json"
            rules_file.write_text(json.dumps(rules))
            reach = oracle(synthetic_oracle, rules_file, synthetic_catalog, pool)
            generate(synthetic_work)
            before = reference_state(synthetic_work)
            code, out, err = generate(synthetic_work, rules_file)
            check(f"parity/{name}: guard oracle as written", reach == expected, sorted(reach))
            check(f"parity/{name}: sync keeps what the guard reaches", code == 0 and kept(synthetic_work) == reach,
                  (code, sorted(kept(synthetic_work)), err))
            check(f"parity/{name}: reference untouched", reference_state(synthetic_work) == before)

        real_oracle = make_root(base, "real-oracle")
        real_work = make_root(base, "real-work")
        real_models = json.loads((source / "models.json").read_text())
        real_catalog = catalog_of(real_models)
        for name, rules_file in (("narrow rules", narrow_rules), ("shipped default", source / "fleet.default.json")):
            reach = oracle(real_oracle, rules_file, real_catalog, pool)
            generate(real_work)
            started = time.monotonic()
            code, out, err = generate(real_work, rules_file)
            elapsed = time.monotonic() - started
            check(f"parity/{name} over models.json: sync keeps what the guard reaches ({len(reach)} of "
                  f"{len(real_catalog)}, {elapsed:.1f}s)", code == 0 and kept(real_work) == reach,
                  (sorted(kept(real_work) ^ reach), err))
            if name == "narrow rules":
                check("parity/narrow rules keep the expected agents", reach == NARROW_EXPECTED & set(real_catalog),
                      sorted(reach ^ (NARROW_EXPECTED & set(real_catalog))))

        # ---- generator --rules edge cases ----------------------------------------------------
        root = make_root(base, "generator", SYNTHETIC_MODELS, {})
        state = snapshot(root)
        reference = reference_state(root)
        for name, content in (("invalid JSON", "{\"main\": "), ("empty file", ""),
                              ("two documents", "{} {}"), ("whitespace only", "  \n"),
                              ("top-level array", "[]"), ("top-level string", "\"rules\"")):
            bad = base / "bad-rules.json"
            bad.write_text(content)
            code, out, err = generate(root, bad)
            check(f"generator/rules: {name} exits 3 and changes nothing",
                  code == 3 and out == "" and snapshot(root) == state and reference_state(root) == reference,
                  (code, out, err))
        code, out, err = generate(root, base / "absent.json")
        check("generator/missing rules file exits 3 and changes nothing", code == 3 and snapshot(root) == state, (code, err))
        # A section of the wrong type fails its query: the generator leaves agents/ as it is, and
        # the guard refuses the call that reads it. jq's length gives 0 for "" and 0, so only a typed
        # size keeps such an allowlist from reading as empty, which would allow everything. The guard
        # already refused false, a list, a string section and a string row; only "" and 0 are new for
        # it. Each case starts from a full set on its own root, so a run that changes agents/ on old
        # code cannot leak into the checks after it.
        wrong_root = make_root(base, "wrong-typed", SYNTHETIC_MODELS, {})
        wrong_state = snapshot(wrong_root)
        wrong_reference = reference_state(wrong_root)
        wrong_typed = [
            ("main.fleet is an empty string", {"main": {"fleet": ""}}, "main"),
            ("main.fleet is 0", {"main": {"fleet": 0}}, "main"),
            ("main.fleet is false", {"main": {"fleet": False}}, None),
            ("main.fleet is a list", {"main": {"fleet": ["m-a"]}}, None),
            ("main is a string", {"main": "m-a"}, None),
            ("rules is an empty string", {"main": {"fleet": {"m-a": ["low"]}}, "rules": ""}, "nested"),
            ("rules is 0", {"main": {"fleet": {"m-a": ["low"]}}, "rules": 0}, "nested"),
            ("a caller's row is a string", {"main": {"fleet": {"m-a": ["low"]}}, "rules": {"m-a": "m-b"}}, None),
        ]
        for name, rules, where in wrong_typed:
            if snapshot(wrong_root) != wrong_state:
                generate(wrong_root)
                wrong_state = snapshot(wrong_root)
            bad = base / "wrong-typed-rules.json"
            bad.write_text(json.dumps(rules))
            code, out, err = generate(wrong_root, bad)
            check(f"generator/rules: {name}: exits 3, changes nothing, says the rules could not be read",
                  code == 3 and out == "" and snapshot(wrong_root) == wrong_state
                  and reference_state(wrong_root) == wrong_reference and "could not be read" in err,
                  (code, out, err))
            if where is None:
                continue
            payload = (main_call("fleet:m-b-high") if where == "main"
                       else nested_call("fleet:m-a-low", subagent_type="fleet:m-b-low"))
            code, out, err = guard(wrong_root, payload, bad)
            check(f"guard/rules: {name}: the {where} Agent call is refused as unreadable",
                  code == 2 and "could not be read" in err, (code, out, err))
        # Two sections that cannot be read: .main.fleet | size is the first query that fails, and
        # the later ones (.rules | size, the per-model .main.fleet reads) follow from it.
        if snapshot(wrong_root) != wrong_state:
            generate(wrong_root)
            wrong_state = snapshot(wrong_root)
        bad = base / "wrong-typed-rules.json"
        bad.write_text(json.dumps({"main": {"fleet": ""}, "rules": 0}))
        code, out, err = generate(wrong_root, bad)
        check("generator/rules: two sections that cannot be read: the message names the first failing query",
              code == 3 and snapshot(wrong_root) == wrong_state
              and "the query .main.fleet | size failed" in err, (code, out, err))
        code, _, _ = run(shell + [root / "scripts/generate-agents.sh", "--rule", "x"])
        check("generator/unknown argument is a usage error", code == 64, code)
        code, out, err = generate(root, "")
        check("generator/an empty --rules argument is a usage error and changes nothing",
              code == 64 and snapshot(root) == state and reference_state(root) == reference, (code, out, err))

        # Invalid models input preserves the existing set, filtered or not.
        bad_models = make_root(base, "bad-models", SYNTHETIC_MODELS, {})
        narrowed_rules = base / "narrowed-for-models.json"
        narrowed_rules.write_text(json.dumps(SYNTHETIC_CASES[2][1]))
        models_state = snapshot(bad_models)
        models_reference = reference_state(bad_models)
        bad_inputs = [("empty file", ""), ("two documents", "{} {}"), ("no models array", "{}"),
                      ("empty models array", "{\"models\": []}"),
                      ("models that render no agent",
                       json.dumps({"snapshot": {"benchmark": "x", "date": "x"},
                                   "models": [{"id": "m-x", "name": "X", "efforts": {}}]}))]
        bad_inputs += [(name, json.dumps(altered(change))) for name, change in MISSHAPEN_MODELS]
        for name, content in bad_inputs:
            (bad_models / "models.json").write_text(content)
            for mode, rules_arg in (("filtered", narrowed_rules), ("full", None)):
                code, out, err = generate(bad_models, rules_arg)
                check(f"generator/models: {name}, {mode} run exits 3 and keeps every agent",
                      code == 3 and snapshot(bad_models) == models_state
                      and reference_state(bad_models) == models_reference, (code, out, err))

        # Free text in a model name or the benchmark name reaches each agent's description as a quoted
        # scalar: every frontmatter parses as YAML and the description reads back as written. A name
        # holding a placeholder is not substituted again (the old loop never ended on it).
        awkward_names = ["Claude Fable: 5.1", "Model # one", "*star", "&anchor", "it's \"quoted\"",
                         "back\\slash \\n", "- dash", "? key", "{{DESCRIPTION}} and {{MODEL}}"]
        awkward = {"snapshot": {"benchmark": "Index: v1 #2 \"q\" \\", "date": "2026-01-01"},
                   "models": [{"id": f"w-{i}", "name": name, "efforts": {"low": figures(10), "default": figures(10)}}
                              for i, name in enumerate(awkward_names)]}
        awkward_root = make_root(base, "awkward", SYNTHETIC_MODELS)
        (awkward_root / "models.json").write_text(json.dumps(awkward))
        code, out, err = generate(awkward_root, timeout=30)
        guidance = {"low": "Use for straightforward tasks of any size, where the steps are clear and there are no "
                           "real decision points.",
                    "default": "Reasoning effort is not adjustable on this model."}
        bench = f'{awkward["snapshot"]["benchmark"]}, {awkward["snapshot"]["date"]}'
        mismatched = []
        for model in awkward["models"] if code == 0 else []:
            for effort in ("low", "default"):
                agent = model["id"] if effort == "default" else f'{model["id"]}-{effort}'
                lead = (f'Executor subagent on {model["name"]}.' if effort == "default"
                        else f'Executor subagent on {model["name"]} at {effort} reasoning effort.')
                expected = (f"{lead} {guidance[effort]} Benchmark {bench}; Index 10, $1.00 per task, "
                            "50 output tokens/s. Follows the prompt literally; does not invent scope.")
                try:
                    parsed = frontmatter_of(awkward_root / "agents" / f"{agent}.md")
                except Exception as error:  # a parse error is the failure this check looks for
                    mismatched.append((agent, repr(error)[:160]))
                    continue
                if (not isinstance(parsed, dict) or parsed.get("description") != expected
                        or parsed.get("name") != agent or parsed.get("model") != model["id"]):
                    mismatched.append((agent, parsed))
        check("generator/descriptions holding YAML-significant text parse as YAML and read back as written",
              code == 0 and not mismatched, (code, err, mismatched[:3]))
        shipped = sorted((source / "agents").glob("*.md"))
        unquoted = [p.name for p in shipped if not p.read_text().split("\n")[2].startswith('description: "')]
        unparsed = []
        for path in shipped:
            try:
                parsed = frontmatter_of(path)
                if not str(parsed.get("description", "")).startswith("Executor subagent on "):
                    unparsed.append(path.name)
            except Exception:
                unparsed.append(path.name)
        check("generator/the shipped agents carry a quoted description that parses as YAML",
              bool(shipped) and not unquoted and not unparsed, (unquoted[:3], unparsed[:3]))

        # Temporary files an interrupted run left are removed by the next run, in both modes.
        (root / "agents" / ".m-a-low.md.99999").write_text("half")
        (root / "agents" / ".m-x.md.1").write_text("half")
        open_rules = base / "open.json"
        open_rules.write_text("{}")
        code, out, err = generate(root, open_rules)
        check("generator/a filtered run removes leftover temporary files", code == 0 and no_temporaries(root), (code, err))
        (root / "agents" / ".m-a-low.md.99999").write_text("half")
        code, out, err = generate(root)
        check("generator/a full run removes leftover temporary files", code == 0 and no_temporaries(root), (code, err))

        # The reference explains provisional generically, and the shipped one was regenerated with it.
        for where, text in (("generated", (root / REFERENCE).read_text()), ("shipped", (source / REFERENCE).read_text())):
            check(f"generator/{where} reference explains provisional as preliminary figures",
                  "marks as preliminary" in text and "pricing tier" in text and "evidence ledger" in text
                  and "announced it will re-run" not in text, text[:600])

        # The lock: concurrent filtered runs take turns, so agents/ ends as one of the two sets.
        locked_root = make_root(base, "locked")
        only = {}
        for agent in ("claude-opus-5-5-high", "gpt-6.1-sol-high"):
            model, effort = agent.rsplit("-", 1)
            only[agent] = base / f"only-{agent}.json"
            only[agent].write_text(json.dumps({"main": {"fleet": {model: [effort]}}, "rules": {model: {model: [effort]}}}))
        outcomes = []
        for _ in range(6):
            runs = list(pool.map(lambda agent: generate(locked_root, only[agent]), sorted(only)))
            outcomes.append(([code for code, _, _ in runs], sorted(kept(locked_root)), no_temporaries(locked_root)))
        check("generator/concurrent filtered runs never leave agents/ empty or mixed",
              all(codes == [0, 0] and len(names) == 1 and names[0] in only and clean
                  for codes, names, clean in outcomes), outcomes)
        lock = locked_root / "agents" / ".sync.lock"
        lock.mkdir(exist_ok=True)
        (lock / "pid").write_text(str(os.getpid()))
        state = snapshot(locked_root)
        code, out, err = generate(locked_root, only["claude-opus-5-5-high"] if kept(locked_root) != {"claude-opus-5-5-high"}
                                  else only["gpt-6.1-sol-high"], {"FLEET_SYNC_LOCK_WAIT": "0"})
        check("generator/a live lock held past the wait exits 75 and changes nothing",
              code == 75 and snapshot(locked_root) == state and lock.is_dir(), (code, out, err))
        (lock / "pid").write_text(str(dead_pid()))
        code, out, err = generate(locked_root, only["gpt-6.1-sol-high"], {"FLEET_SYNC_LOCK_WAIT": "0"})
        check("generator/a lock whose holder has exited is broken",
              code == 0 and kept(locked_root) == {"gpt-6.1-sol-high"} and not lock.exists(), (code, out, err))
        lock.mkdir(exist_ok=True)
        (lock / "pid").unlink(missing_ok=True)
        old = time.time() - 600
        os.utime(lock, (old, old))
        code, out, err = generate(locked_root, only["claude-opus-5-5-high"], {"FLEET_SYNC_LOCK_WAIT": "0"})
        check("generator/a lock older than two minutes without a pid is broken",
              code == 0 and kept(locked_root) == {"claude-opus-5-5-high"} and not lock.exists(), (code, out, err))
        # A reference that fails to render after the models passed the check changes nothing: the
        # reference is rendered in staging before agents/ is touched. A jq stub on PATH fails the one
        # call that renders the named part and hands every other call to the real jq.
        real_jq = shutil.which("jq")
        stub_dir = base / "jq-stub"
        stub_dir.mkdir()
        # With FLEET_TEST_LOG it also notes the ladder render, and with FLEET_TEST_STEAL_LOCK it hands
        # the lock to another live process at that point; a touch stub notes its arguments.
        (stub_dir / "jq").write_text(
            "#!/bin/sh\n"
            "if [ -n \"${FLEET_TEST_JQ_FAIL_ON:-}\" ]; then\n"
            "  for arg in \"$@\"; do\n"
            "    case $arg in *\"$FLEET_TEST_JQ_FAIL_ON\"*) echo 'jq stub: forced failure' >&2; exit 5 ;; esac\n"
            "  done\n"
            "fi\n"
            "for arg in \"$@\"; do\n"
            "  case $arg in *'Escalation ladder'*)\n"
            "    [ -z \"${FLEET_TEST_LOG:-}\" ] || echo 'jq ladder' >> \"$FLEET_TEST_LOG\"\n"
            "    [ -z \"${FLEET_TEST_STEAL_LOCK:-}\" ] || echo \"$FLEET_TEST_THIEF\" > \"$FLEET_TEST_STEAL_LOCK/pid\" ;;\n"
            "  esac\n"
            "done\n"
            f"exec '{real_jq}' \"$@\"\n")
        (stub_dir / "jq").chmod(0o755)
        (stub_dir / "touch").write_text(
            "#!/bin/sh\n"
            "[ -z \"${FLEET_TEST_LOG:-}\" ] || echo \"touch $*\" >> \"$FLEET_TEST_LOG\"\n"
            "[ -z \"${FLEET_TEST_STEAL_AT_TOUCH:-}\" ] || echo \"$FLEET_TEST_THIEF\" > \"$FLEET_TEST_STEAL_AT_TOUCH/pid\"\n"
            f"exec '{shutil.which('touch')}' \"$@\"\n")
        (stub_dir / "touch").chmod(0o755)
        stub_path = f"{stub_dir}{os.pathsep}{base_env.get('PATH', '')}"
        failing = make_root(base, "reference-failure", SYNTHETIC_MODELS)
        reference_dir = (failing / REFERENCE).parent
        (failing / "models.json").write_text(json.dumps(altered(
            lambda m: (m["models"].pop(), m["models"][0]["efforts"]["low"].update(tps=77)))))
        for part, marker in (("benchmark table", "Historical routing priors"), ("escalation ladder", "Escalation ladder")):
            state, reference_before = snapshot(failing), reference_state(failing)
            code, out, err = generate(failing, None, {"PATH": stub_path, "FLEET_TEST_JQ_FAIL_ON": marker})
            check(f"generator/a {part} that fails to render changes neither agents/ nor the reference",
                  code != 0 and snapshot(failing) == state and reference_state(failing) == reference_before
                  and no_temporaries(failing) and not [p for p in reference_dir.iterdir() if p.name.startswith(".")],
                  (code, err))
        code, out, err = generate(failing, None, {"PATH": stub_path})
        check("generator/the jq stub passes every call through when told to fail none",
              code == 0 and kept(failing) == EVERY_SYNTHETIC - {"m-d-low"}
              and "| 77 |" in (failing / REFERENCE).read_text(), (code, err))

        # The lock's age is refreshed once rendering is done, before the install; a run whose lock was
        # broken and taken over while it rendered installs nothing and leaves the new holder's lock.
        failing_lock = failing / "agents" / ".sync.lock"
        log = base / "lock-order.log"
        (failing / "models.json").write_text(json.dumps(altered(
            lambda m: (m["models"].pop(), m["models"][0]["efforts"]["low"].update(tps=78)))))
        code, out, err = generate(failing, None, {"PATH": stub_path, "FLEET_TEST_LOG": str(log)})
        steps = log.read_text().splitlines() if log.is_file() else []
        touches = [i for i, step in enumerate(steps) if step.startswith("touch ") and step.endswith(str(failing_lock))]
        check("generator/the lock's age is refreshed after rendering, before the install",
              code == 0 and "jq ladder" in steps and bool(touches) and steps.index("jq ladder") < touches[0]
              and "| 78 |" in (failing / REFERENCE).read_text(), (code, steps, err))
        (failing / "models.json").write_text(json.dumps(altered(
            lambda m: (m["models"].pop(), m["models"][0]["efforts"]["low"].update(tps=79)))))
        state, reference_before = snapshot(failing), reference_state(failing)
        code, out, err = generate(failing, None, {"PATH": stub_path, "FLEET_TEST_STEAL_LOCK": str(failing_lock),
                                                  "FLEET_TEST_THIEF": str(os.getpid())})
        check("generator/a run that lost its lock while rendering installs nothing and keeps the new holder's lock",
              code == 75 and snapshot(failing) == state and reference_state(failing) == reference_before
              and (failing_lock / "pid").read_text().strip() == str(os.getpid()), (code, err))
        shutil.rmtree(failing_lock, ignore_errors=True)
        # The refresh comes before the ownership check, so a lock taken over at the moment of the
        # refresh is still seen and the run installs nothing.
        (failing / "models.json").write_text(json.dumps(altered(
            lambda m: (m["models"].pop(), m["models"][0]["efforts"]["low"].update(tps=80)))))
        state, reference_before = snapshot(failing), reference_state(failing)
        code, out, err = generate(failing, None, {"PATH": stub_path, "FLEET_TEST_STEAL_AT_TOUCH": str(failing_lock),
                                                  "FLEET_TEST_THIEF": str(os.getpid())})
        check("generator/a lock taken over at its refresh: ownership is checked after it, nothing installed",
              code == 75 and snapshot(failing) == state and reference_state(failing) == reference_before, (code, err))
        shutil.rmtree(failing_lock, ignore_errors=True)

        # models.json saved while a run waits for the lock: the run reads one copy, taken under the
        # lock, so agents/ and the reference come from the same file, never a mix of the two.
        set_a = {"snapshot": {"benchmark": "Bench A", "date": "2026-01-01"},
                 "models": [{"id": "m-a", "name": "Alpha", "efforts": {"low": figures(10), "high": figures(20)}}]}
        set_b = {"snapshot": {"benchmark": "Bench B", "date": "2026-02-02"},
                 "models": [{"id": "m-b", "name": "Beta", "efforts": {"low": figures(15)}},
                            {"id": "m-c", "name": "Gamma", "efforts": {"default": figures(5)}}]}
        model_sets = {"old": ({"m-a-low", "m-a-high"}, set_a), "new": ({"m-b-low", "m-c"}, set_b)}
        replaced = make_root(base, "replaced", set_a)
        replaced_lock = replaced / "agents" / ".sync.lock"
        replaced_lock.mkdir()
        (replaced_lock / "pid").write_text(str(os.getpid()))
        environment = dict(base_env)
        environment["FLEET_SYNC_LOCK_WAIT"] = "30"
        waiting = subprocess.Popen([str(part) for part in shell + [replaced / "scripts/generate-agents.sh"]],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=environment)
        time.sleep(1.5)
        pending = replaced / "models.json.saving"
        pending.write_text(json.dumps(set_b))
        os.replace(pending, replaced / "models.json")
        shutil.rmtree(replaced_lock)
        out, err = waiting.communicate(timeout=120)
        replaced_names = kept(replaced)
        replaced_reference = (replaced / REFERENCE).read_text()

        def one_set(label):
            names, models = model_sets[label]
            stamp = f'{models["snapshot"]["benchmark"]}, {models["snapshot"]["date"]}'
            title = f'# {models["snapshot"]["benchmark"]}, snapshot {models["snapshot"]["date"]}\n'
            others = [m["name"] for other, (_, o) in model_sets.items() if other != label for m in o["models"]]
            return (replaced_names == names
                    and all(f"Benchmark {stamp};" in (replaced / "agents" / f"{n}.md").read_text() for n in names)
                    and replaced_reference.startswith(title)
                    and all(f'| {m["name"]} |' in replaced_reference for m in models["models"])
                    and not any(name in replaced_reference for name in others))
        check("generator/models.json saved while a run waits for the lock: agents/ and the reference "
              "come from one file",
              waiting.returncode == 0 and (one_set("old") or one_set("new")),
              (waiting.returncode, sorted(replaced_names), err, replaced_reference[:200]))

        narrowed = base / "narrowed.json"
        narrowed.write_text(json.dumps(SYNTHETIC_CASES[2][1]))
        code, out, err = generate(root, narrowed)
        check("generator/--rules reports each change",
              code == 0 and sorted(out.split("\n")) == sorted(["", "removed m-a-high", "removed m-b-high",
                                                              "removed m-b-low", "removed m-d-low"]), out)
        code, out, err = generate(root)
        check("generator/no argument restores the full set and the reference",
              code == 0 and kept(root) == EVERY_SYNTHETIC and (root / REFERENCE).is_file(), (code, err))

        # ---- the hook: startup, idempotency, FileChanged ------------------------------------
        narrow = SYNTHETIC_CASES[2][1]
        root = make_root(base, "hook", SYNTHETIC_MODELS, narrow)
        data = base / "hook-data"
        reference = reference_state(root)
        code, out, err = sync(root, data, session_start("startup"))
        seeded = data / "fleet.json"
        specific = out.get("hookSpecificOutput", {}) if isinstance(out, dict) else {}
        check("startup/seeds the rules file first and syncs to it",
              code == 0 and seeded.is_file() and json.loads(seeded.read_text()) == narrow
              and kept(root) == {"m-a-low", "m-c"}, (code, out, err))
        check("startup/seed message goes to Claude's context",
              "rules seeded" in specific.get("additionalContext", ""), out)
        check("startup/watchPaths holds the active rules file",
              specific.get("hookEventName") == "SessionStart" and specific.get("watchPaths") == [str(seeded)], out)
        check("startup/asks for /reload-plugins with the counts",
              "/reload-plugins" in message(out) and "0 added, 4 removed, 0 updated" in message(out), out)
        check("startup/the same notice also goes to additionalContext",
              message(out) != "" and message(out) in specific.get("additionalContext", "")
              and "rules seeded" in specific.get("additionalContext", ""), out)
        check("startup/reference untouched", reference_state(root) == reference)
        check("startup/no temporary files left", no_temporaries(root))

        state = snapshot(root)
        for source_name in ("startup", "resume", "clear", "compact"):
            code, out, err = sync(root, data, session_start(source_name))
            specific = out.get("hookSpecificOutput", {}) if isinstance(out, dict) else {}
            check(f"idempotent/{source_name}: no writes, no message, watch list kept",
                  code == 0 and snapshot(root) == state and "systemMessage" not in out
                  and "additionalContext" not in specific and specific.get("watchPaths") == [str(seeded)],
                  (code, out, err))

        name = "m-a-low.md"
        rendered = (root / "agents" / name).read_bytes()
        (root / "agents" / name).write_text("stale\n")
        code, out, err = sync(root, data, session_start("resume"))
        check("sync/a kept file that differs is rewritten and counted as updated",
              (root / "agents" / name).read_bytes() == rendered and "0 added, 0 removed, 1 updated" in message(out), out)

        seeded.write_text(json.dumps({}))
        code, out, err = sync(root, data, file_changed(seeded))
        check("filechanged/rules edit syncs and asks for /reload-plugins",
              code == 0 and kept(root) == EVERY_SYNTHETIC and "4 added, 0 removed" in message(out)
              and "/reload-plugins" in message(out), (code, out, err))
        check("filechanged/watchPaths at the top level, no SessionStart fields",
              isinstance(out, dict) and out.get("watchPaths") == [str(seeded)] and "hookSpecificOutput" not in out, out)
        state = snapshot(root)
        code, out, err = sync(root, data, file_changed(seeded))
        check("filechanged/same rules again: no writes, no message",
              code == 0 and snapshot(root) == state and "systemMessage" not in out, out)

        other = base / "elsewhere.json"
        other.write_text("{}")
        seeded.write_text(json.dumps(narrow))
        state = snapshot(root)
        code, out, err = sync(root, data, file_changed(other))
        check("filechanged/another plugin's path is ignored without output",
              code == 0 and out is None and snapshot(root) == state, (code, out, err))
        link = base / "data-link"
        link.symlink_to(data)
        code, out, err = sync(root, data, file_changed(link / "fleet.json"))
        check("filechanged/the rules file reported through a symlinked directory still syncs",
              code == 0 and kept(root) == {"m-a-low", "m-c"}, (code, out, err))
        code, out, err = sync(root, link, file_changed(data / "fleet.json"))
        check("filechanged/the real path matches a watch path registered through a symlink",
              code == 0 and isinstance(out, dict) and out.get("watchPaths") == [str(link / "fleet.json")], (code, out, err))

        # ---- invalid rules never delete agents ------------------------------------------------
        state = snapshot(root)
        for name, content in (("invalid JSON", "{\"rules\": {"), ("empty file", ""), ("two documents", "{}\n{}")):
            seeded.write_text(content)
            code, out, err = sync(root, data, file_changed(seeded))
            check(f"invalid/{name}: agents untouched, user told, exit 0",
                  code == 0 and snapshot(root) == state and "left as it is" in message(out)
                  and out.get("watchPaths") == [str(seeded)], (code, out, err))
        code, out, err = sync(root, data, session_start("startup"))
        check("invalid/startup with a broken rules file keeps agents and watches the file",
              code == 0 and snapshot(root) == state and "left as it is" in message(out)
              and out["hookSpecificOutput"].get("watchPaths") == [str(seeded)], (code, out, err))

        # ---- fallback to the shipped default and the FLEET_RULES override -------------------
        seeded.unlink()
        code, out, err = sync(root, data, file_changed(seeded, "unlink"))
        check("fallback/deleted data file syncs to the shipped default and watches both",
              code == 0 and kept(root) == {"m-a-low", "m-c"} and not seeded.exists()
              and out.get("watchPaths") == [str(seeded), str(root / "fleet.default.json")], (code, out, err))
        seeded.write_text(json.dumps({}))
        code, out, err = sync(root, data, file_changed(seeded, "add"))
        check("fallback/a recreated data file is picked up", code == 0 and kept(root) == EVERY_SYNTHETIC, (code, out))

        # FLEET_RULES: agents/ is shared, so the override is left to the guard and nothing is written.
        override = base / "override.json"
        override.write_text(json.dumps(SYNTHETIC_CASES[5][1]))
        env = {"FLEET_RULES": str(override)}
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup", "override-session"), env)
        check("override/FLEET_RULES set: agents/ not written, no watchPaths, the context says why",
              code == 0 and snapshot(root) == state and "watchPaths" not in out["hookSpecificOutput"]
              and "systemMessage" not in out and "FLEET_RULES is set" in context_of(out), (code, out, err))
        code, out, err = sync(root, data, file_changed(seeded, session="override-session"), env)
        check("override/FLEET_RULES set: a change of the data file is ignored",
              code == 0 and out is None and snapshot(root) == state, (code, out))
        code, out, err = sync(root, data, file_changed(override), env)
        check("override/FLEET_RULES set: a change of the override file writes nothing",
              code == 0 and out is None and snapshot(root) == state, (code, out))
        code, out, err = guard(root, main_call("fleet:m-a-low"), override)
        check("override/the guard still applies FLEET_RULES to each call",
              code == 2 and "not enabled for the main session" in err, (code, err))

        # ---- per-session notices: every session watching the file hears of a change -----------
        root = make_root(base, "sessions", SYNTHETIC_MODELS, narrow)
        data = base / "sessions-data"
        code, out_a, err = sync(root, data, session_start("startup", "session-a"))
        code, out_b, err = sync(root, data, session_start("startup", "session-b"))
        check("sessions/the first startup is told of its sync, the second loads the synced set and is not",
              "4 removed" in message(out_a) and "systemMessage" not in out_b, (out_a, out_b))
        seeded = data / "fleet.json"
        seeded.write_text(json.dumps({}))
        code, out_a, err = sync(root, data, file_changed(seeded, session="session-a"))
        code, out_b, err = sync(root, data, file_changed(seeded, session="session-b"))
        check("sessions/one edit: the session whose run wrote agents/ is told",
              "4 added, 0 removed, 0 updated" in message(out_a), out_a)
        check("sessions/one edit: the other session is told too, though its run changed nothing",
              "4 added, 0 removed, 0 updated" in message(out_b) and "/reload-plugins" in message(out_b), out_b)
        code, out_b, err = sync(root, data, file_changed(seeded, session="session-b"))
        check("sessions/told once: the same set again says nothing", "systemMessage" not in out_b, out_b)
        seeded.write_text(json.dumps(narrow))
        code, out_a, err = sync(root, data, file_changed(seeded, session="session-a"))
        code, out_b, err = sync(root, data, session_start("compact", "session-b"))
        check("sessions/a compaction compares with what the session was told, not with the disk before",
              "0 added, 4 removed" in message(out_b) and "0 added, 4 removed" in context_of(out_b), out_b)
        code, out_a, err = sync(root, data, session_start("clear", "session-a"))
        check("sessions/a clear with nothing new says nothing", "systemMessage" not in out_a, out_a)
        # A session with an out-of-date record that then sees an invalid rules file: agents/ was left
        # as it is, so the notice must not claim it follows the rules in force.
        seeded.write_text(json.dumps({}))
        code, out_a, err = sync(root, data, file_changed(seeded, session="session-a"))
        seeded.write_text("{ not json")
        code, out_b, err = sync(root, data, file_changed(seeded, session="session-b"))
        check("sessions/invalid rules after an unseen change: the notice says the set differs from the "
              "loaded one, not that it follows the rules",
              "4 added, 0 removed, 0 updated" in message(out_b) and "differs from the set this session loaded" in message(out_b)
              and "left as it is" in message(out_b) and "rules in force can reach" not in message(out_b), out_b)
        seeded.write_text(json.dumps(narrow))
        code, out_a, err = sync(root, data, file_changed(seeded, session="session-a"))
        code, out_b, err = sync(root, data, file_changed(seeded, session="session-b"))
        records = data / "sessions"
        check("sessions/each session has its record",
              (records / "session-a").is_file() and (records / "session-b").is_file(), sorted(records.iterdir()) if records.is_dir() else None)
        stale_record = records / "session-old"
        recent_record = records / "session-recent"
        records.mkdir(parents=True, exist_ok=True)
        stale_record.write_text("x\n")
        recent_record.write_text("x\n")
        month_ago = time.time() - 31 * 86400
        ten_days_ago = time.time() - 10 * 86400
        os.utime(stale_record, (month_ago, month_ago))
        os.utime(recent_record, (ten_days_ago, ten_days_ago))
        code, out, err = sync(root, data, session_start("resume", "session-a"))
        check("sessions/SessionStart prunes records older than thirty days and keeps one ten days old",
              not stale_record.exists() and recent_record.is_file() and (records / "session-a").is_file(),
              sorted(records.iterdir()) if records.is_dir() else None)
        code, out, err = sync(root, data, session_start("startup", "../escape"))
        check("sessions/a session id that is not a plain file name keeps no record",
              code == 0 and not (base / "escape").exists() and not (data / "escape").exists(), (code, out, err))

        # A run that waits out another session's lock is skipped and says so.
        lock = root / "agents" / ".sync.lock"
        lock.mkdir(exist_ok=True)
        (lock / "pid").write_text(str(os.getpid()))
        state = snapshot(root)
        seeded.write_text(json.dumps({}))
        code, out, err = sync(root, data, file_changed(seeded, session="session-a"), {"FLEET_SYNC_LOCK_WAIT": "0"})
        check("busy/a held lock: agents/ untouched, the session is told the sync was skipped",
              code == 0 and snapshot(root) == state and "skipped, busy" in message(out), (code, out, err))
        shutil.rmtree(lock, ignore_errors=True)

        # ---- opting out, and a git checkout ----------------------------------------------------
        root = make_root(base, "optout", SYNTHETIC_MODELS, narrow)
        data = base / "optout-data"
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup"), {"FLEET_SYNC_AGENTS": "0"})
        check("optout/FLEET_SYNC_AGENTS=0 seeds but neither syncs nor watches",
              code == 0 and (data / "fleet.json").is_file() and snapshot(root) == state
              and "watchPaths" not in out["hookSpecificOutput"] and "systemMessage" not in out, (code, out, err))

        checkout = base / "checkout"
        checkout.mkdir()
        run(["git", "init", "-q"], cwd=checkout)
        root = make_root(checkout / "plugins", "fleet", SYNTHETIC_MODELS, narrow)
        data = base / "checkout-data"
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup"))
        check("checkout/untracked agents/ under a git work tree is synced",
              code == 0 and kept(root) == {"m-a-low", "m-c"}, (code, out, err))
        generate(root)
        run(["git", "add", "plugins/fleet/agents"], cwd=checkout)
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup"))
        check("checkout/tracked agents/ is left alone and not watched",
              code == 0 and snapshot(root) == state and "watchPaths" not in out["hookSpecificOutput"]
              and "systemMessage" not in out, (code, out, err))
        code, out, err = sync(root, data, session_start("startup"), {"FLEET_SYNC_AGENTS": "1"})
        check("checkout/FLEET_SYNC_AGENTS=1 syncs a checkout too",
              code == 0 and kept(root) == {"m-a-low", "m-c"}
              and out["hookSpecificOutput"].get("watchPaths") == [str(data / "fleet.json")], (code, out, err))

        # Without git to ask, a work tree counts as tracking agents/, and the session hears of it once.
        nogit_bin = base / "nogit-bin"
        nogit_bin.mkdir()
        for tool in ("sh", "jq", "cat", "grep", "awk", "sed", "find", "mkdir", "rm", "mv", "cp", "dirname",
                     "basename", "tail", "head", "sort", "cksum", "tr", "wc", "ls", "cmp", "mktemp", "sleep", "touch"):
            found = shutil.which(tool)
            if found:
                (nogit_bin / tool).symlink_to(found)
        nogit_env = {"PATH": str(nogit_bin)}
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup", "nogit-session"), nogit_env)
        check("checkout/without git on PATH: agents/ untouched, not watched, the context says why",
              code == 0 and snapshot(root) == state and "git is not on PATH" in context_of(out)
              and "watchPaths" not in out["hookSpecificOutput"], (code, out, err))
        code, out, err = sync(root, data, session_start("resume", "nogit-session"), nogit_env)
        check("checkout/without git on PATH: said once per session",
              code == 0 and "git is not on PATH" not in context_of(out) and snapshot(root) == state, (code, out, err))
        # A week-old stamp of a session that is still running is its own: its next SessionStart
        # neither prunes it nor repeats the note, and refreshes its age.
        stamp = data / "sessions" / "nogit-session.nogit"
        week_ago = time.time() - 8 * 86400
        if stamp.is_file():
            os.utime(stamp, (week_ago, week_ago))
        code, out, err = sync(root, data, session_start("compact", "nogit-session"), nogit_env)
        check("checkout/without git on PATH: an active session's week-old stamp is kept and the note not repeated",
              code == 0 and stamp.is_file() and stamp.stat().st_mtime > week_ago + 86400
              and "git is not on PATH" not in context_of(out), (code, out, err))

        # ---- an active session keeps its record ------------------------------------------------
        root = make_root(base, "activity", SYNTHETIC_MODELS, narrow)
        data = base / "activity-data"
        sync(root, data, session_start("startup", "session-c"))
        seeded = data / "fleet.json"
        record = data / "sessions" / "session-c"
        week_ago = time.time() - 8 * 86400
        if record.is_file():
            os.utime(record, (week_ago, week_ago))
        sync(root, data, file_changed(seeded, session="session-c"))
        sync(root, data, session_start("startup", "session-e"))
        check("activity/a sync with nothing new refreshes the record, so another session's start keeps it",
              record.is_file() and record.stat().st_mtime > week_ago + 86400,
              sorted(p.name for p in record.parent.iterdir()) if record.parent.is_dir() else None)
        if record.is_file():
            os.utime(record, (week_ago, week_ago))
        seeded.write_text(json.dumps({}))
        sync(root, data, file_changed(seeded, session="session-f"))
        code, out, err = sync(root, data, session_start("compact", "session-c"))
        check("activity/a week-old record survives its own session's next start and still yields the notice",
              record.is_file() and "4 added, 0 removed, 0 updated" in message(out)
              and "4 added, 0 removed, 0 updated" in context_of(out), (code, out, err))
        seeded.write_text(json.dumps(narrow))

        # ---- an invalid models.json ------------------------------------------------------------
        # ---- a record pruned meanwhile, or never written --------------------------------------
        # Such a session cannot know which set it loaded: another session may already have synced.
        root = make_root(base, "pruned", SYNTHETIC_MODELS, narrow)
        data = base / "pruned-data"
        seeded = data / "fleet.json"
        sync(root, data, session_start("startup", "session-p"))
        sync(root, data, session_start("startup", "session-q"))
        record_p = data / "sessions" / "session-p"
        month_ago = time.time() - 31 * 86400
        if record_p.is_file():
            os.utime(record_p, (month_ago, month_ago))
        sync(root, data, session_start("resume", "session-q"))
        pruned = not record_p.exists()
        seeded.write_text(json.dumps({}))
        code, out_q, err = sync(root, data, file_changed(seeded, session="session-q"))
        code, out_p, err = sync(root, data, file_changed(seeded, session="session-p"))
        code, again_p, again_err = sync(root, data, file_changed(seeded, session="session-p"))
        check("sessions/a record pruned meanwhile: the next rules change says the loaded set is unknown and "
              "asks for /reload-plugins, once",
              pruned and "4 added, 0 removed, 0 updated" in message(out_q)
              and "no record of the agent set it loaded" in message(out_p) and "/reload-plugins" in message(out_p)
              and record_p.is_file() and message(again_p) == "",
              (pruned, out_q, out_p, again_p, err, again_err))
        code, out_r, err = sync(root, data, session_start("compact", "session-r"))
        code_r, again_r, err_r = sync(root, data, session_start("compact", "session-r"))
        code_c, out_c, err_c = sync(root, data, session_start("clear", "session-cleared"))
        code_s, out_s, err_s = sync(root, data, session_start("startup", "session-s"))
        check("sessions/a compaction with no record says the loaded set is unknown in both fields, once; "
              "a clear or a startup with no record says nothing",
              "no record of the agent set it loaded" in message(out_r)
              and "no record of the agent set it loaded" in context_of(out_r)
              and code_r == 0 and message(again_r) == "" and context_of(again_r) == ""
              and code_c == 0 and message(out_c) == "" and context_of(out_c) == ""
              and code_s == 0 and message(out_s) == "",
              (code, out_r, err, code_r, again_r, err_r, code_c, out_c, err_c, code_s, out_s, err_s))

        # ---- a section of the wrong type ------------------------------------------------------
        state = snapshot(root)
        seeded.write_text(json.dumps({"main": {"fleet": ""}}))
        code, out, err = sync(root, data, file_changed(seeded, session="session-q"))
        check("unreadable/a wrong-typed allowlist: agents/ untouched, the notice says the rules could not be read",
              code == 0 and snapshot(root) == state and "could not be read" in message(out)
              and "left as it is" in message(out) and "runs again when the rules file changes" in message(out),
              (code, out, err))
        seeded.write_text(json.dumps(narrow))

        # ---- /clear: a new session id, so normally no record ------------------------------------
        # The docs say "Running /clear starts a new session"; these payloads are synthetic. A clear
        # with no record compares with agents/ as found, like a startup.
        root = make_root(base, "clear", SYNTHETIC_MODELS, narrow)
        data = base / "clear-data"
        seeded = data / "fleet.json"
        records = data / "sessions"
        sync(root, data, session_start("startup", "before-clear"))
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("clear", "after-clear"))
        check("clear/no record and nothing changed: silent in both fields, record written",
              code == 0 and isinstance(out, dict) and message(out) == "" and context_of(out) == ""
              and snapshot(root) == state and (records / "after-clear").is_file(), (code, out, err))
        # The session's own change, synced and reported before the next clear: the cleared session
        # finds agents/ already synced and, like a startup, is not told (the accepted residual).
        seeded.write_text(json.dumps({}))
        code, own, err = sync(root, data, file_changed(seeded, session="after-clear"))
        code_c, out_c, err_c = sync(root, data, session_start("clear", "after-second-clear"))
        code_s, out_s, err_s = sync(root, data, session_start("startup", "fresh-start"))
        check("clear/no record after the session's own change: compared with agents/ as found, so silent, "
              "as a startup is",
              "4 added, 0 removed, 0 updated" in message(own)
              and code_c == 0 and message(out_c) == "" and context_of(out_c) == ""
              and code_s == 0 and message(out_s) == "", (own, err, code_c, out_c, err_c, code_s, out_s, err_s))
        # A rules change no sync has applied yet: the clear's own sync changes agents/ and reports it.
        seeded.write_text(json.dumps(narrow))
        code_c, out_c, err_c = sync(root, data, session_start("clear", "after-third-clear"))
        check("clear/no record, a rules change not yet synced: counted from agents/ as found, in both fields",
              code_c == 0 and "0 added, 4 removed, 0 updated" in message(out_c)
              and "0 added, 4 removed, 0 updated" in context_of(out_c), (code_c, out_c, err_c))

        root = make_root(base, "models-notice", SYNTHETIC_MODELS, narrow)
        data = base / "models-notice-data"
        (root / "models.json").write_text("{}")
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup", "session-m"))
        check("models/an invalid models.json: agents/ kept, the notice says a fixed file is picked up at the next "
              "session start or rules change",
              code == 0 and snapshot(root) == state and "models.json is missing or invalid" in message(out)
              and "picked up at the next session start or rules change" in message(out)
              and "runs again when the rules file changes" not in message(out), (code, out, err))

        # ---- without jq ------------------------------------------------------------------------
        nojq_bin = base / "nojq-bin"
        nojq_bin.mkdir()
        for tool in ("sh", "cat", "grep", "dirname", "mkdir", "cp", "rm", "tr"):
            found = shutil.which(tool)
            if found:
                (nojq_bin / tool).symlink_to(found)
        nojq_env = {"PATH": str(nojq_bin)}
        root = make_root(base, "nojq", SYNTHETIC_MODELS, narrow)
        data = base / "nojq-data"
        state = snapshot(root)
        code, out, err = sync(root, data, session_start("startup", "nojq-session"), nojq_env)
        check("nojq/SessionStart: the notice goes to both systemMessage and additionalContext",
              code == 0 and isinstance(out, dict) and "jq is not on PATH" in message(out)
              and "jq is not on PATH" in context_of(out)
              and out.get("hookSpecificOutput", {}).get("hookEventName") == "SessionStart"
              and (data / "fleet.json").is_file() and snapshot(root) == state, (code, out, err))
        code, out, err = sync(root, data, file_changed(data / "fleet.json", session="nojq-session"), nojq_env)
        check("nojq/FileChanged: the notice is a systemMessage, with no SessionStart fields",
              code == 0 and isinstance(out, dict) and "jq is not on PATH" in message(out)
              and "hookSpecificOutput" not in out, (code, out, err))
        # Valid JSON may break lines around a key's colon; the payload is matched without jq.
        lines_data = base / "nojq-lines-data"
        broken = ('{\n  "hook_event_name"\n    :\n  "SessionStart",\n  "source":\n\t"startup",\n'
                  '  "session_id": "nojq-lines"\n}\n')
        code, out, err = sync(root, lines_data, broken, nojq_env)
        # A string value holding the same text (its quotes escaped) is not taken for the key.
        decoy = file_changed('/tmp/x,"hook_event_name": "SessionStart","source": "startup"', session="nojq-decoy")
        decoy_data = base / "nojq-decoy-data"
        decoy_code, decoy_out, decoy_err = sync(root, decoy_data, decoy, nojq_env)
        check("nojq/SessionStart with line breaks around the colons: seeded, and both fields carry the notice; "
              "a value holding the key's text is not read as the key",
              code == 0 and isinstance(out, dict) and "jq is not on PATH" in message(out)
              and "jq is not on PATH" in context_of(out)
              and out.get("hookSpecificOutput", {}).get("hookEventName") == "SessionStart"
              and (lines_data / "fleet.json").is_file()
              and decoy_code == 0 and isinstance(decoy_out, dict) and "hookSpecificOutput" not in decoy_out
              and not (decoy_data / "fleet.json").exists(), (code, out, err, decoy_code, decoy_out, decoy_err))

        # ---- the guard with definition files gone ----------------------------------------------
        root = make_root(base, "guard")
        generate(root, narrow_rules)
        gone = sorted(set(real_catalog) - kept(root))
        check("guard/the narrow sync removed the unreachable files",
              "gpt-5.6-terra-high" in gone and "claude-opus-5-5-max" in gone and "gpt-6-astra-high" in gone, gone)

        def refused(payload, text):
            code, out, err = guard(root, payload, narrow_rules)
            return code == 2 and text in err, (code, err)

        def passed(payload):
            code, out, err = guard(root, payload, narrow_rules)
            return code == 0, (code, err)

        cases = [
            ("removed caller is governed by its model, not passed as built-in",
             refused(nested_call("fleet:gpt-5.6-terra-high", subagent_type="fleet:gpt-6-luna-low"),
                     "no spawn rules exist for a gpt-5.6-terra agent")),
            ("removed caller without a prefix is governed too",
             refused(nested_call("gpt-5.6-terra-high", subagent_type="fleet:gpt-6-luna-low"),
                     "no spawn rules exist for a gpt-5.6-terra agent")),
            ("removed caller's row allows what it lists",
             passed(nested_call("fleet:claude-opus-5-5-max", subagent_type="fleet:gpt-6-luna-low"))),
            ("removed caller's row refuses what it does not list",
             refused(nested_call("fleet:claude-opus-5-5-max", subagent_type="fleet:claude-fable-5-1-low"),
                     "not available from a claude-opus-5-5 agent")),
            ("removed target is checked against the caller's row",
             refused(nested_call("fleet:claude-opus-5-5-low", subagent_type="fleet:gpt-5.6-terra-high"),
                     "not available from a claude-opus-5-5 agent")),
            ("removed caller: disallowed command refused",
             refused(nested_call("fleet:claude-opus-5-5-max", "Bash", command="sudo ls"), "'sudo' is not available")),
            ("removed caller: disallowed skill refused",
             refused(nested_call("fleet:claude-opus-5-5-max", "Skill", skill="code-review"), "skill 'code-review'")),
            ("removed caller: Workflow refused",
             refused(nested_call("fleet:claude-opus-5-5-max", "Workflow"), "workflows spawn their own agents")),
            ("unknown fleet caller refused for every checked tool",
             refused(nested_call("fleet:no-such-model-high", "Bash", command="ls"), "no definition under agents/")),
            ("main: removed agent outside main.fleet refused",
             refused(main_call("fleet:gpt-5.6-terra-high"), "not enabled for the main session")),
            ("main: removed agent with a model parameter refused",
             refused(main_call("fleet:gpt-6-astra-high", "opus"), "fleet agent types carry their own model")),
            ("main: unknown fleet type refused, not taken for built-in",
             refused(main_call("fleet:no-such-model-low"), "not defined in this fleet")),
            ("main: kept agent in main.fleet passes", passed(main_call("fleet:claude-opus-5-5-high"))),
            ("main: built-in agent passes", passed(main_call("general-purpose"))),
            ("main: built-in agent with a listed model passes", passed(main_call("general-purpose", "opus"))),
            ("main: built-in agent with an unlisted model refused",
             refused(main_call("general-purpose", "haiku"), "not enabled for built-in agents")),
            ("main session running as an unknown --agent type stays the main session",
             passed({"hook_event_name": "PreToolUse", "tool_name": "Bash", "agent_id": "",
                     "agent_type": "fleet:no-such-model-high", "tool_input": {"command": "sudo ls"}})),
            ("built-in caller passes, as before",
             passed(nested_call("general-purpose", subagent_type="fleet:gpt-5.6-terra-high"))),
        ]
        for name, (ok, detail) in cases:
            check("guard/" + name, ok, detail)

        for agent_type in ("fleet:gpt-5.6-terra-high", "fleet:no-such-model-high"):
            code, out, err = guard(root, {"hook_event_name": "SubagentStart", "agent_type": agent_type,
                                          "agent_id": "agent-1"}, narrow_rules)
            context = json.loads(out)["hookSpecificOutput"]["additionalContext"] if code == 0 and out else ""
            check(f"guard/SubagentStart hands the limits to {agent_type}",
                  "Skills you cannot load: code-review" in context, (code, out, err))
        code, out, err = guard(root, {"hook_event_name": "SubagentStart", "agent_type": "general-purpose",
                                      "agent_id": "agent-1"}, narrow_rules)
        check("guard/SubagentStart leaves built-in agents alone", code == 0 and out == "", (code, out))

        bare = base / "bare"
        (bare / "scripts").mkdir(parents=True)
        shutil.copyfile(source / "scripts/subagent-guard.sh", bare / "scripts/subagent-guard.sh")
        code, out, err = guard(bare, main_call("general-purpose"), narrow_rules)
        check("guard/refuses everything when its library is missing", code == 2 and "library is missing" in err,
              (code, err))

        # ---- the guard refuses a rules file that is not exactly one JSON object or null --------
        first_denies = json.dumps({"main": {"fleet": {"claude-opus-5-5": ["high"]}}})
        for name, content in (("empty file", ""), ("whitespace only", " \n"),
                              ("two documents, the first denying", first_denies + "\n{}"), ("top-level array", "[]")):
            bad = base / "guard-bad-rules.json"
            bad.write_text(content)
            for what, payload in (
                    ("main-session target", main_call("fleet:gpt-5.6-terra-high")),
                    ("skill", nested_call("fleet:claude-opus-5-5-high", "Skill", skill="code-review")),
                    ("command", nested_call("fleet:claude-opus-5-5-high", "Bash", command="sudo ls")),
                    ("SubagentStart", {"hook_event_name": "SubagentStart", "agent_type": "fleet:claude-opus-5-5-high",
                                       "agent_id": "agent-1"})):
                code, out, err = guard(root, payload, bad)
                check(f"guard/invalid rules ({name}): {what} refused",
                      code == 2 and "rules file is invalid" in err, (code, out, err))
        null_rules = base / "guard-null-rules.json"
        null_rules.write_text("null")
        code, out, err = guard(root, main_call("fleet:gpt-5.6-terra-high"), null_rules)
        check("guard/a null rules document still reads as empty rules", code == 0, (code, err))

        # ---- the guard decides on one read of the rules ----------------------------------------
        # The rules file changes between the guard's validity check and its queries. The stub runs
        # the real jq; right after the validity call it replaces the original with text that is not
        # JSON, or removes it. The guard queries the copy it checked, so the denylists still hold.
        swap_dir = base / "jq-swap"
        swap_dir.mkdir()
        (swap_dir / "jq").write_text(
            "#!/bin/sh\n"
            f"'{shutil.which('jq')}' \"$@\"\n"
            "status=$?\n"
            "case \"$*\" in *'length == 1 and'*)\n"
            "  if [ \"${FLEET_TEST_SWAP:-}\" = remove ]; then rm -f \"$FLEET_TEST_SWAP_TARGET\"\n"
            "  else printf '{ not json' > \"$FLEET_TEST_SWAP_TARGET\"; fi ;;\n"
            "esac\n"
            "exit $status\n")
        (swap_dir / "jq").chmod(0o755)
        swap_path = f"{swap_dir}{os.pathsep}{base_env.get('PATH', '')}"
        caller = "fleet:claude-opus-5-5-high"
        start = {"hook_event_name": "SubagentStart", "agent_type": caller, "agent_id": "agent-1"}
        for mode, label in (("swap", "replaced with text that is not JSON"), ("remove", "removed")):
            for what, payload, holds in (
                    ("a denied skill is refused", nested_call(caller, "Skill", skill="code-review"),
                     lambda code, out, err: code == 2 and "skill 'code-review' is not available" in err),
                    ("a denied command is refused", nested_call(caller, "Bash", command="sudo ls"),
                     lambda code, out, err: code == 2 and "'sudo' is not available" in err),
                    ("SubagentStart hands the limits", start,
                     lambda code, out, err: code == 0 and "Skills you cannot load: code-review" in out)):
                racing = base / f"guard-racing-{mode}.json"
                shutil.copyfile(narrow_rules, racing)
                code, out, err = run(shell + [root / "scripts/subagent-guard.sh", root, ""], payload,
                                     {"FLEET_RULES": str(racing), "PATH": swap_path, "FLEET_TEST_SWAP": mode,
                                      "FLEET_TEST_SWAP_TARGET": str(racing)})
                swapped = racing.is_file() if mode == "swap" else not racing.exists()
                check(f"guard/rules {label} after the validity check: {what}",
                      swapped and holds(code, out, err), (code, out, err))
        # A query that fails on the copy (a section of the wrong type) refuses; it never reads as an
        # empty list.
        for what, rules_doc, payload in (
                ("a skills denylist that is a string", {"disallowed_skills": "code-review"},
                 nested_call(caller, "Skill", skill="code-review")),
                ("a commands denylist that is a string", {"disallowed_commands": "sudo"},
                 nested_call(caller, "Bash", command="sudo ls")),
                ("a skills denylist that is an object, at SubagentStart", {"disallowed_skills": {"a": "code-review"}},
                 start),
                ("a built-in model list that is a string", {"main": {"builtin_agent_models": "claude-opus-5-5"}},
                 main_call("general-purpose", "claude-haiku-4-5"))):
            typed = base / "guard-typed-rules.json"
            typed.write_text(json.dumps(rules_doc))
            code, out, err = guard(root, payload, typed)
            check(f"guard/{what}: the failed query refuses the call",
                  code == 2 and "could not be read" in err, (code, out, err))

    for error in errors:
        print("FAIL " + error, file=sys.stderr)
    print("\nSync checks: %d; failures: %d" % (count, len(errors)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
