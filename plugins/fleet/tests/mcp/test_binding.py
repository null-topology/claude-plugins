#!/usr/bin/env python3
"""Test the per-spawn MCP rules at a fleet agent's call, on a copy of the plugin: the guard binds the
call to the briefs of the agents above it through synthetic transcript files, evaluates every fleet
frame and prints each result of the policy; the contract hook and the guard read one corpus of
briefs alike."""
from __future__ import annotations
import argparse
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

FLEET = "fleet:claude-opus-5-5"
SOL = "fleet:gpt-6.1-sol"
VAULT = "mcp__gateway__vault__search"
SECRET = "SECRET-ARGUMENT"
SECRET_BRIEF = "Synthetic test content."
BODY = "".join("## %s\n%s\n\n" % (title, SECRET_BRIEF) for title in (
    "Objective", "Context and Evidence", "Scope Boundary", "Acceptance Criteria", "Return and Stop"))
DENIED_FINAL = "The refusal is final: do not retry the call or reach the tool another way; report what needed it."
ERROR_FINAL = ("The tool is not available until this is fixed: do not retry the call or reach the tool another way; "
               "report the error.")
OWN_CLOSED = "no allow rule matches it (global and this agent's brief)."
BINDING = "invalid transcript binding"
BRIEF = "agent brief unavailable"
INVALID = "invalid agent brief"
ANCESTRY = "agent ancestry unavailable"
EVALUATION = "the policy could not be evaluated"


def own_deny(rule):
    return "the deny rule %s of this agent's brief matches it." % json.dumps(rule)


def above_deny(rule, agent_id):
    return "the deny rule %s of the brief of agent %s above matches it." % (json.dumps(rule), agent_id)


def above_closed(agent_id):
    return "no allow rule of agent %s above matches it." % agent_id


def global_deny(rule):
    return "the global rule %s denies it." % json.dumps(rule)


def items(key, rules):
    return key + ":\n" + "".join("  - %s\n" % json.dumps(rule) for rule in rules) if rules else ""


def brief(allow=(), deny=()):
    """A brief whose block holds the given lists; without a block when both are empty."""
    if not allow and not deny:
        return BODY
    return "---\n" + items("allow", allow) + items("deny", deny) + "---\n" + BODY


def long_rules(tag, count=256):
    """count valid rules of 256 bytes each that match no tool used here."""
    return ["mcp__%s%03d" % (tag, i) + "x" * (248 - len(tag)) for i in range(count)]


def record_line(text):
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}})


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
    timings = []
    count = 0

    def check(name, condition, detail=""):
        nonlocal count
        count += 1
        print("%s %d - %s" % ("ok" if condition else "not ok", count, name))
        if not condition:
            errors.append(name + ": " + str(detail))

    with tempfile.TemporaryDirectory(prefix="fleet-mcp-binding-test-") as temporary:
        base = Path(temporary)
        plugin = base / "fleet"
        (plugin / "scripts").mkdir(parents=True)
        for filename in ("subagent-guard.sh", "fleet-rules.sh", "mcp-policy.sh", "delegation-contract.sh"):
            shutil.copyfile(root / "scripts" / filename, plugin / "scripts" / filename)
        shutil.copytree(root / "agents", plugin / "agents")
        shutil.copyfile(root / "fleet.default.json", plugin / "fleet.default.json")
        (plugin / ".claude-plugin").mkdir()
        shutil.copyfile(root / ".claude-plugin/plugin.json", plugin / ".claude-plugin/plugin.json")
        shipped = json.loads((root / "fleet.default.json").read_text())
        rules_file = base / "rules.json"
        sessions = itertools.count(1)

        def rules(allow=("mcp__gateway*",), deny=()):
            return dict(shipped, allowed_mcp_tools=list(allow), disallowed_mcp_tools=list(deny))

        def session():
            """A main transcript's directory; its subagents' files go under subagents/."""
            directory = base / "projects" / "p" / ("s%d" % next(sessions))
            (directory / "subagents").mkdir(parents=True)
            return directory

        def write_agent(sess, agent_id, kind=FLEET, parent=None, text=BODY, meta=None, record=None):
            """One agent's metadata and transcript, of the shapes the host writes; False leaves a
            file out, a string is written as it is."""
            folder = sess / "subagents"
            if meta is None:
                meta = {"agentType": kind, "toolUseId": "toolu-" + agent_id, "spawnDepth": 1}
                if parent is not None:
                    meta["parentAgentId"] = parent
            if meta is not False:
                (folder / ("agent-%s.meta.json" % agent_id)).write_text(
                    meta if isinstance(meta, str) else json.dumps(meta))
            if record is None:
                record = (json.dumps({"parentUuid": None, "isSidechain": True, "agentId": agent_id, "type": "user",
                                      "message": {"role": "user", "content": text}, "uuid": "u-" + agent_id})
                          + "\n" + json.dumps({"type": "assistant", "message": {
                              "role": "assistant", "content": [{"type": "text", "text": "Working."}]}}) + "\n")
            if record is not False:
                (folder / ("agent-%s.jsonl" % agent_id)).write_text(record)

        def chain(agents, sess=None):
            """agents from the caller up, each (id, type, brief); each one's parent is the next."""
            sess = sess or session()
            for index, (agent_id, kind, text) in enumerate(agents):
                parent = agents[index + 1][0] if index + 1 < len(agents) else None
                write_agent(sess, agent_id, kind, parent, text)
            return sess

        def call(sess, tool=VAULT, agent_id="a1", caller=FLEET, **extra):
            """A PreToolUse payload of the measured shape; a field given as None is left out."""
            data = {"session_id": "s1", "transcript_path": str(sess) + ".jsonl", "cwd": "/",
                    "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": tool,
                    "tool_input": {"query": SECRET}, "tool_use_id": "t1", "prompt_id": "p1",
                    "agent_id": agent_id, "agent_type": caller}
            data.update(extra)
            return {key: value for key, value in data.items() if value is not None}

        def guard(payload, rule_set=None, extra_env=None):
            run_env = dict(env, **(extra_env or {}))
            rules_file.write_text(json.dumps(rules() if rule_set is None else rule_set))
            run_env["FLEET_RULES"] = str(rules_file)
            started = time.monotonic()
            try:
                result = subprocess.run(shell + [str(plugin / "scripts/subagent-guard.sh"), str(plugin), "", "mcp"],
                                        input=json.dumps(payload), capture_output=True, text=True, timeout=20,
                                        env=run_env)
            except subprocess.TimeoutExpired:
                return None, "", "timed out", time.monotonic() - started
            return result.returncode, result.stdout, result.stderr, time.monotonic() - started

        def contract(text, rule_set=None):
            run_env = dict(env)
            rules_file.write_text(json.dumps(rules() if rule_set is None else rule_set))
            run_env["FLEET_RULES"] = str(rules_file)
            payload = {"session_id": "s1", "transcript_path": str(base / "projects/p/s0.jsonl"), "cwd": "/",
                       "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Agent",
                       "tool_input": {"description": "Synthetic task", "prompt": text, "subagent_type": FLEET}}
            result = subprocess.run(shell + [str(plugin / "scripts/delegation-contract.sh"), str(plugin), ""],
                                    input=json.dumps(payload), capture_output=True, text=True, timeout=20,
                                    env=run_env)
            return result.returncode, result.stdout, result.stderr

        def clean(err):
            """The call's arguments and the briefs' text are never printed."""
            return SECRET not in err and SECRET_BRIEF not in err

        def passes(name, outcome):
            rc, out, err, elapsed = outcome
            check(name, rc == 0 and not out and not err, (rc, out, err, round(elapsed, 2)))

        def denied(name, outcome, tool, clause):
            rc, out, err, elapsed = outcome
            expected = "FLEET_MCP_DENIED: %s: %s\n%s\n" % (json.dumps(tool), clause, DENIED_FINAL)
            check(name, rc == 2 and not out and err == expected and clean(err), (rc, out, err, round(elapsed, 2)))

        def fault(name, outcome, reason):
            rc, out, err, elapsed = outcome
            expected = "FLEET_MCP_ERROR: %s\n%s\n" % (reason, ERROR_FINAL)
            check(name, rc == 2 and not out and err == expected and clean(err), (rc, out, err, round(elapsed, 2)))

        def stub(name, condition):
            """A PATH whose jq fails when its arguments match the shell pattern condition."""
            directory = base / name
            directory.mkdir()
            (directory / "jq").write_text('#!/bin/sh\ncase "$*" in %s) exit 5 ;; esac\nexec \'%s\' "$@"\n'
                                          % (condition, real_jq))
            (directory / "jq").chmod(0o755)
            return {"PATH": "%s%s%s" % (directory, os.pathsep, env.get("PATH", ""))}

        # ---- the examples of the policy (global allow list mcp__gateway* unless stated) ---------
        empty = rules(allow=())
        s = chain([("a1", FLEET, BODY)])
        passes("example 1/no block: a tool the global allow list grants passes", guard(call(s)))
        denied("example 2/no block: a tool outside the global allow list is refused",
               guard(call(s, "mcp__mail__send")), "mcp__mail__send", OWN_CLOSED)
        s = chain([("a1", FLEET, brief(deny=[VAULT]))])
        denied("example 3/a deny rule of the brief refuses a tool the global list grants", guard(call(s)), VAULT,
               own_deny(VAULT))
        passes("example 3/another tool the global list grants still passes",
               guard(call(s, "mcp__gateway__kb__read")))
        s = chain([("a1", FLEET, brief(deny=["*__search"]))])
        denied("example 4/a deny mask of the brief refuses every tool it matches",
               guard(call(s, "mcp__gateway__kb__search")), "mcp__gateway__kb__search", own_deny("*__search"))
        s = chain([("a1", FLEET, brief(allow=["mcp__mail__read"]))])
        passes("example 5/an allow rule of the brief adds a tool", guard(call(s, "mcp__mail__read")))
        denied("example 5/a tool neither list grants is refused", guard(call(s, "mcp__mail__send")),
               "mcp__mail__send", OWN_CLOSED)
        text = brief(allow=["mcp__mail__send"])
        rc, out, err = contract(text, rules(deny=["mcp__mail__*"]))
        check("example 6/a brief granting what a global deny rule takes passes the spawn",
              rc == 0 and not out and not err, (rc, out, err))
        s = chain([("a1", FLEET, text)])
        denied("example 6/the call is refused by the global deny rule",
               guard(call(s, "mcp__mail__send"), rules(deny=["mcp__mail__*"])), "mcp__mail__send",
               global_deny("mcp__mail__*"))
        s = chain([("a1", FLEET, brief(allow=["mcp__mail__*"]))])
        passes("example 7/a granted mask lets through what the global deny list leaves",
               guard(call(s, "mcp__mail__read"), rules(deny=["mcp__mail__send"])))
        denied("example 7/the global deny rule still refuses its tool",
               guard(call(s, "mcp__mail__send"), rules(deny=["mcp__mail__send"])), "mcp__mail__send",
               global_deny("mcp__mail__send"))
        s = chain([("a1", FLEET, BODY)])
        passes("example 8/both global lists empty, no block: any tool passes",
               guard(call(s, "mcp__mail__send"), empty))
        s = chain([("a1", FLEET, brief(allow=["mcp__mail__read"]))])
        passes("example 9/both global lists empty, the granted tool passes", guard(call(s, "mcp__mail__read"), empty))
        denied("example 9/both global lists empty, another tool is refused",
               guard(call(s, "mcp__mail__send"), empty), "mcp__mail__send", OWN_CLOSED)
        denied("example 9/both global lists empty, a gateway tool is refused", guard(call(s), empty), VAULT,
               OWN_CLOSED)
        s = chain([("a1", FLEET, BODY), ("p1", SOL, brief(deny=[VAULT]))])
        denied("example 10/a deny rule of the agent above binds a child without a block", guard(call(s)), VAULT,
               above_deny(VAULT, "p1"))
        s = chain([("a1", FLEET, BODY), ("p1", SOL, brief(allow=["mcp__mail__read"]))])
        denied("example 11/a grant above does not reach a child without it", guard(call(s, "mcp__mail__read")),
               "mcp__mail__read", OWN_CLOSED)
        s = chain([("a1", FLEET, brief(allow=["mcp__mail__read"])), ("p1", SOL, brief(allow=["mcp__mail__read"]))])
        passes("example 11/the same grant in the child's block passes", guard(call(s, "mcp__mail__read")))
        s = chain([("e1", "Explore", brief(deny=["*"])), ("p1", SOL, brief(deny=["*"]))])
        passes("example 12/a subagent that is not a fleet agent is not governed",
               guard(call(s, "mcp__mail__send", agent_id="e1", caller="Explore"), rules(deny=())))
        passes("example 12/the main session is not governed",
               guard(call(s, "mcp__mail__send", agent_id=None, caller=None)))
        s = chain([("a1", FLEET, BODY), ("p1", SOL, brief(allow=["mcp__mail__read"]))])
        passes("example 13/both global lists empty, the grant above admits the tool",
               guard(call(s, "mcp__mail__read"), empty))
        denied("example 13/both global lists empty, the frame above refuses another tool",
               guard(call(s, "mcp__mail__send"), empty), "mcp__mail__send", above_closed("p1"))

        # ---- chains ------------------------------------------------------------------------------
        three = [("a1", FLEET, brief(allow=["mcp__mail__read", "mcp__docs__read"], deny=["mcp__gateway__kb__*"])),
                 ("p1", SOL, brief(allow=["mcp__mail__*"], deny=["*__delete"])),
                 ("g1", FLEET, brief(allow=["mcp__mail__read", "mcp__docs__read"], deny=[VAULT]))]
        s = chain(three)
        before = sorted((str(path), path.stat().st_mtime_ns) for path in (base / "projects").rglob("*"))
        outcome = guard(call(s, "mcp__mail__read"))
        passes("chain/three fleet agents with a block each: a tool every frame grants passes", outcome)
        timings.append(("3 fleet agents, a block at each level", outcome[3]))
        check("chain/three fleet agents with a block each are bound well inside a second", outcome[3] < 1.0,
              round(outcome[3], 2))
        check("chain/the transcript files are only read",
              before == sorted((str(path), path.stat().st_mtime_ns) for path in (base / "projects").rglob("*")))
        denied("chain/a deny rule two levels above refuses", guard(call(s)), VAULT, above_deny(VAULT, "g1"))
        denied("chain/the nearest deny rule is named", guard(call(s, "mcp__gateway__kb__delete")),
               "mcp__gateway__kb__delete", own_deny("mcp__gateway__kb__*"))
        denied("chain/a frame in the middle without the grant refuses", guard(call(s, "mcp__docs__read")),
               "mcp__docs__read", above_closed("p1"))
        denied("chain/the caller's frame without the grant refuses", guard(call(s, "mcp__mail__list")),
               "mcp__mail__list", OWN_CLOSED)
        s = chain([("a1", FLEET, BODY), ("e1", "general-purpose", brief(deny=["*"])),
                   ("g1", FLEET, brief(deny=[VAULT]))])
        denied("chain/fleet, other, fleet: the fleet agent above the other one still binds", guard(call(s)), VAULT,
               above_deny(VAULT, "g1"))
        passes("chain/fleet, other, fleet: the other agent's brief is not read",
               guard(call(s, "mcp__gateway__kb__read")))
        s = session()
        write_agent(s, "a1", FLEET, "e1")
        write_agent(s, "e1", "Explore", "g1", record=False)
        write_agent(s, "g1", FLEET, None, brief(deny=[VAULT]))
        passes("chain/an agent above that is not a fleet agent needs no first record",
               guard(call(s, "mcp__gateway__kb__read")))
        denied("chain/the fleet agent above it still binds", guard(call(s)), VAULT, above_deny(VAULT, "g1"))
        s = chain([("a1", FLEET, BODY), ("p1", "fleet:retired-model-9", brief(deny=[VAULT]))])
        denied("chain/a fleet agent above whose model left the rules keeps its frame", guard(call(s)), VAULT,
               above_deny(VAULT, "p1"))
        s = chain([("a1", FLEET, BODY), ("p1", "other:claude-opus-5-5", brief(deny=[VAULT]))])
        passes("chain/an agent of another plugin above is not a frame", guard(call(s)))
        s = chain([("a1", FLEET, brief(deny=[VAULT]))])
        denied("binding/the agent's own transcript path binds the same files",
               guard(call(s, transcript_path=str(s / "subagents/agent-a1.jsonl"))), VAULT, own_deny(VAULT))

        # ---- the binding -------------------------------------------------------------------------
        s = chain([("a1", FLEET, BODY)])
        for label, agent_id in (("a slash", "a/1"), ("a dot-dot", ".."), ("a dot", "a.1"), ("a space", "a 1")):
            fault("binding/an agent_id with %s" % label, guard(call(s, agent_id=agent_id)), BINDING)
        for label, path in (("a .. segment", str(s) + "/../" + s.name + ".jsonl"),
                            ("a . segment", str(s.parent) + "/./" + s.name + ".jsonl"),
                            ("no .jsonl suffix", str(s)),
                            ("a relative path", "projects/p/" + s.name + ".jsonl"),
                            ("a line break", str(s.parent) + "/\n" + s.name + ".jsonl")):
            fault("binding/a transcript_path with %s" % label, guard(call(s, transcript_path=path)), BINDING)
        fault("binding/no transcript_path", guard(call(s, transcript_path=None)), BINDING)
        rc, out, err, elapsed = guard(call(s, transcript_path=7))
        check("binding/a transcript_path of another type keeps the guard's refusal of the payload",
              rc == 2 and not out and "transcript_path must be strings or null" in err and clean(err), (rc, out, err))
        for label, parent in (("a slash", "../a1"), ("a dot-dot", ".."), ("nothing", "")):
            s = session()
            write_agent(s, "a1", FLEET, parent)
            fault("binding/a parentAgentId with %s" % label, guard(call(s)), BINDING)
        s = session()
        write_agent(s, "a1", meta={"toolUseId": "toolu-a1"})
        fault("binding/the caller's metadata without agentType", guard(call(s)), ANCESTRY)
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        write_agent(s, "p1", meta={"toolUseId": "toolu-p1"})
        fault("binding/the metadata above without agentType", guard(call(s)), ANCESTRY)
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        write_agent(s, "p1", meta={"agentType": 7})
        fault("binding/the metadata above with an agentType that is not a string", guard(call(s)), ANCESTRY)
        s = session()
        write_agent(s, "a1", "Explore")
        fault("binding/the caller's metadata naming an agent that is not a fleet agent", guard(call(s)), BINDING)

        # ---- the brief and the metadata ----------------------------------------------------------
        s = session()
        write_agent(s, "a1", meta=False)
        fault("brief/the caller's metadata missing", guard(call(s)), BRIEF)
        s = session()
        write_agent(s, "a1", record=False)
        fault("brief/the caller's first record missing", guard(call(s)), BRIEF)
        fault("brief/no fallback to the global lists when the caller's brief is unreadable",
              guard(call(s, "mcp__mail__send"), empty), BRIEF)
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        write_agent(s, "p1", SOL, record=False)
        fault("brief/the first record of a fleet agent above missing", guard(call(s)), BRIEF)
        fault("brief/no fallback to the global lists when a brief above is unreadable",
              guard(call(s, "mcp__mail__send"), empty), BRIEF)
        for label, filename in (("metadata", "agent-a1.meta.json"), ("first record", "agent-a1.jsonl")):
            s = session()
            write_agent(s, "z1")
            write_agent(s, "a1", meta=False if "meta" in filename else None,
                        record=False if "meta" not in filename else None)
            (s / "subagents" / filename).symlink_to(s / "subagents" / filename.replace("a1", "z1"))
            fault("brief/the caller's %s a symbolic link" % label, guard(call(s)), BRIEF)
            s = session()
            write_agent(s, "a1", meta=False if "meta" in filename else None,
                        record=False if "meta" not in filename else None)
            (s / "subagents" / filename).mkdir()
            fault("brief/the caller's %s a directory" % label, guard(call(s)), BRIEF)
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        write_agent(s, "z1", SOL)
        write_agent(s, "p1", SOL, record=False)
        (s / "subagents/agent-p1.jsonl").symlink_to(s / "subagents/agent-z1.jsonl")
        fault("brief/the first record above a symbolic link", guard(call(s)), BRIEF)
        meta_text = json.dumps({"agentType": FLEET})
        s = session()
        write_agent(s, "a1", meta=meta_text + " " * (65536 - len(meta_text)))
        passes("brief/metadata of 64 KiB is read", guard(call(s)))
        s = session()
        write_agent(s, "a1", meta=meta_text + " " * (65537 - len(meta_text)))
        fault("brief/metadata over 64 KiB", guard(call(s)), BRIEF)
        for label, meta in (("not JSON", "agentType"), ("two objects", meta_text + meta_text),
                            ("an array", "[" + meta_text + "]"), ("empty", ""),
                            ("with a parentAgentId that is not a string",
                             json.dumps({"agentType": FLEET, "parentAgentId": 7}))):
            s = session()
            write_agent(s, "a1", meta=meta)
            fault("brief/metadata %s" % label, guard(call(s)), BRIEF)
        first = record_line(BODY)
        s = session()
        write_agent(s, "a1", record=first + "\n" + "x" * (2 * 1048576) + "\n")
        passes("brief/a first line under 1 MiB is read whatever follows it", guard(call(s)))
        s = session()
        write_agent(s, "a1", record=first)
        passes("brief/a first record without a line break is read", guard(call(s)))
        padding = 1048576 - len(first)
        s = session()
        write_agent(s, "a1", record=record_line(BODY + "x" * padding) + "\n")
        passes("brief/a first line of 1 MiB is read", guard(call(s)))
        s = session()
        write_agent(s, "a1", record=record_line(BODY + "x" * (padding + 1)) + "\n")
        fault("brief/a first line over 1 MiB", guard(call(s)), BRIEF)
        for label, record in (("that is not JSON", "user\n"),
                              ("of another type", json.dumps({"type": "assistant", "message": {"content": BODY}})),
                              ("with content blocks", json.dumps({"type": "user", "message": {
                                  "content": [{"type": "text", "text": BODY}]}})),
                              ("without a message", json.dumps({"type": "user"})),
                              ("that is empty", ""),
                              ("after an empty line", "\n" + first + "\n")):
            s = session()
            write_agent(s, "a1", record=record)
            fault("brief/a first record %s" % label, guard(call(s)), BRIEF)

        # ---- invalid briefs, and one corpus through both hooks ----------------------------------
        s = chain([("a1", FLEET, '---\nallow:\n  - mcp__a\n---\n' + BODY)])
        fault("invalid/the caller's block does not parse", guard(call(s)), INVALID)
        s = chain([("a1", FLEET, BODY), ("p1", SOL, "---\ndeny:\n---\n" + BODY)])
        fault("invalid/a block above does not parse", guard(call(s)), INVALID)
        s = chain([("a1", FLEET, BODY), ("e1", "Explore", "---\ndeny:\n---\n" + BODY)])
        passes("invalid/a block of an agent above that is not a fleet agent is not read", guard(call(s)))
        block = "---\n" + items("deny", [VAULT]) + "---\n"
        corpus = (
            ("a valid block", block + BODY, "applies"),
            ("CRLF endings", (block + BODY).replace("\n", "\r\n"), "applies"),
            ("mixed endings", "---\r\ndeny:\n  - %s\r\n---\n" % json.dumps(VAULT) + BODY, "applies"),
            ("no block", BODY, "none"),
            ("a thematic break after the first heading", BODY + block, "none"),
            ("a leading blank line", "\n" + block + BODY, "invalid"),
            ("--- with a trailing blank", "--- \n" + items("deny", [VAULT]) + "---\n" + BODY, "invalid"),
            ("a byte-order mark", "﻿" + block + BODY, "invalid"),
            ("a block after other text", "Intro\n" + block + BODY, "invalid"),
            ("--- opening other front matter", "---\ntitle: x\n---\n" + BODY, "invalid"),
        )
        for label, text, verdict in corpus:
            rc, out, err = contract(text)
            s = chain([("a1", FLEET, text)])
            outcome = guard(call(s))
            if verdict == "invalid":
                check("corpus/%s: the contract hook refuses the spawn" % label,
                      rc == 2 and not out and "FLEET_DELEGATION_INVALID" in err and "\nMCP policy: " in err,
                      (rc, out, err))
                fault("corpus/%s: the guard refuses the call" % label, outcome, INVALID)
            else:
                check("corpus/%s: the contract hook passes the spawn" % label, rc == 0 and not out and not err,
                      (rc, out, err))
                if verdict == "applies":
                    denied("corpus/%s: the guard applies the block" % label, outcome, VAULT, own_deny(VAULT))
                else:
                    passes("corpus/%s: the guard finds no block" % label, outcome)

        # ---- the ancestry ------------------------------------------------------------------------
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        fault("ancestry/the metadata of the agent above missing", guard(call(s)), ANCESTRY)
        s = session()
        write_agent(s, "a1", FLEET, "p1")
        write_agent(s, "p1", SOL, "a1")
        fault("ancestry/a repeated agent id", guard(call(s)), ANCESTRY)
        s = session()
        write_agent(s, "a1", FLEET, "a1")
        fault("ancestry/an agent that is its own parent", guard(call(s)), ANCESTRY)
        agents = [("a1", FLEET, BODY)] + [("p%d" % number, SOL, BODY) for number in range(2, 33)]
        s = chain(agents)
        passes("ancestry/32 agents are followed", guard(call(s)))
        s = chain(agents + [("p33", SOL, BODY)])
        fault("ancestry/a 33rd agent", guard(call(s)), ANCESTRY)

        # ---- the other results -------------------------------------------------------------------
        s = chain([("a1", FLEET, brief(deny=[VAULT]))])
        fault("results/invalid global lists, with a block in the brief", guard(call(s), rules(allow=["bad rule"])),
              "invalid MCP rules in %s" % rules_file)
        fault("results/an invalid tool name", guard(call(s, "mcp__gateway__café")), "invalid tool name")
        fault("results/a failed query of the metadata", guard(call(s), extra_env=stub("stub-meta", "*agentType*")),
              EVALUATION)
        fault("results/a failed query of the block",
              guard(call(s), extra_env=stub("stub-block", "*'.message.content | mcp_block_text'*")), EVALUATION)

        # ---- what the hook description promises ---------------------------------------------------
        description = json.loads((root / "hooks/hooks.json").read_text())["description"]
        check("description/states that an untrappable kill is not refused",
              "ends in any other way, is refused" not in description
              and "a kill the guard cannot trap ends it without a decision and is not refused" in description)
        check("description/states the per-spawn rules of every fleet agent in the chain",
              "a block at the top of a fleet agent's brief" in description
              and "for the caller and for every fleet agent above it" in description
              and "the global lists are never used alone in their place" in description)
        check("description/states that a block in a brief to another agent type is refused",
              "calls to other agent types are not inspected" not in description
              and "which works only for fleet agents" in description)

        # ---- the time limit ----------------------------------------------------------------------
        full = brief(allow=long_rules("fa"), deny=long_rules("fd"))
        s = chain([("a1", FLEET, full)] + [("p%d" % number, SOL, full) for number in range(2, 33)])
        outcome = guard(call(s), rules(allow=long_rules("ga", 255) + ["mcp__gateway*"], deny=long_rules("gd")))
        timings.append(("32 fleet agents, full-size lists at each level and in the rules", outcome[3]))
        passes("timing/32 fleet agents with full-size lists are bound and evaluated", outcome)
        check("timing/32 fleet agents with full-size lists finish inside 3 seconds", outcome[3] is not None
              and outcome[3] < 3.0, round(outcome[3], 2))

    for label, elapsed in timings:
        print("timing: %s: %.2f s" % (label, elapsed))
    print("Binding checks: %d; failures: %d" % (count, len(errors)))
    for error in errors:
        print("FAIL: " + error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
