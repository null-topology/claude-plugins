#!/usr/bin/env python3
"""Test the MCP rule validator, the matcher, the global list reader and the evaluation of
scripts/mcp-policy.sh, sourced into the shell under test."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

# Each snippet sources the library ($1) and runs one function on the remaining arguments; the
# function's status is the snippet's status, and what it sets is printed on stdout. A missing
# library ends the snippet with 99, so that no status of a shell that failed to source it can read
# as an answer.
SOURCE = '[ -f "$1" ] || exit 99; . "$1"; shift; '
RULE_VALID = SOURCE + 'mcp_rule_valid "$@"'
MATCH = SOURCE + 'mcp_match "$@"'
LISTS = SOURCE + 'rc=0; mcp_lists "$@" || rc=$?; printf "%s\\n%s\\n" "$mcp_allow" "$mcp_deny"; exit $rc'
PERMITS = SOURCE + 'rc=0; mcp_permits "$@" || rc=$?; printf "%s" "$mcp_verdict"; exit $rc'
# The same with the two lists and the frames read from files ($2, $3, $4): input of the largest size
# the evaluation takes does not fit in process arguments, though it fits in shell variables.
PERMITS_FILES = SOURCE + ('allow=$(cat "$2") && deny=$(cat "$3") && frames=$(cat "$4") || exit 98; '
                          'rc=0; mcp_permits "$1" "$allow" "$deny" "$frames" || rc=$?; '
                          'printf "%s" "$mcp_verdict"; exit $rc')

SELF = [{"self": True, "allow": [], "deny": []}]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fleet-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--shell", nargs="+", default=["/bin/sh"])
    args = parser.parse_args()
    root = args.fleet_root.resolve()
    library = root / "scripts/mcp-policy.sh"
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
            errors.append(name + ": " + str(detail))

    def call(snippet, *arguments):
        result = subprocess.run(shell + ["-c", snippet, "sh", str(library)] + [str(a) for a in arguments],
                                capture_output=True, text=True, timeout=30, env=env)
        return result.returncode, result.stdout, result.stderr

    # ---- the shipped defaults ----------------------------------------------------------------
    shipped = json.loads((root / "fleet.default.json").read_text())
    check("defaults/allowed_mcp_tools ships as []", shipped.get("allowed_mcp_tools", None) == [], shipped.keys())
    check("defaults/disallowed_mcp_tools ships as []", shipped.get("disallowed_mcp_tools", None) == [],
          shipped.keys())
    check("library/exists", library.is_file(), library)

    # ---- rule validation ---------------------------------------------------------------------
    valid = ["mcp__gateway__vault__search", "mcp__gateway*", "mcp__gateway__*", "*__search", "mcp__*__send_*",
             "*", "**", "mcp__", "mcp__a-b.c_d", "*.x", "mcp__" + "a" * 251]
    invalid = ["", "x", "mcp_x", "MCP__x", "gateway__*", "mcp__x y", "mcp__x?", "mcp__[ab]", "mcp__(a)",
               "mcp__x\n", "\nmcp__x", "mcp__x\t", "mcp__é", "mcp__a/b", "mcp__a+b", "mcp__a$",
               "mcp__" + "a" * 252]
    for rule in valid:
        code, out, err = call(RULE_VALID, rule)
        check("rule/valid %s" % json.dumps(rule[:40]), code == 0, (code, err))
    for rule in invalid:
        code, out, err = call(RULE_VALID, rule)
        check("rule/invalid %s" % json.dumps(rule[:40]), code == 1, (code, err))
    code, out, err = call(RULE_VALID, "mcp__" + "a" * 251)
    check("rule/256 bytes is the longest valid rule", code == 0 and len("mcp__" + "a" * 251) == 256, (code, err))

    # ---- matching ----------------------------------------------------------------------------
    table = [
        # complete names
        ("mcp__a__b", "mcp__a__b", 0), ("mcp__a__b", "mcp__a__bc", 1), ("mcp__a__b", "mcp__a__", 1),
        ("mcp__a__b", "mcp__A__b", 1),
        # punctuation is literal: "." is no wildcard, "-" no range
        ("mcp__a.b__c", "mcp__a.b__c", 0), ("mcp__a.b__c", "mcp__aXb__c", 1), ("mcp__a-c", "mcp__abc", 1),
        # prefixes
        ("mcp__gateway*", "mcp__gateway__vault__search", 0), ("mcp__gateway*", "mcp__gateway2__x", 0),
        ("mcp__gateway*", "mcp__gatewa", 1), ("mcp__gateway__*", "mcp__gateway2__x", 1),
        ("mcp__gateway__*", "mcp__gateway__", 0), ("mcp__gateway__*", "mcp__gateway_x__y", 1),
        # leading *
        ("*__search", "mcp__kb__search", 0), ("*__search", "mcp__kb__search2", 1), ("*", "mcp__x", 0),
        ("*__search", "__search", 0),
        # inner *
        ("mcp__*__send_*", "mcp__mail__send_now", 0), ("mcp__*__send_*", "mcp__mail__read", 1),
        ("mcp__*__send_*", "mcp____send_", 0), ("mcp__a*b*c", "mcp__abc", 0), ("mcp__a*b*c", "mcp__acb", 1),
        ("mcp__a*b*c", "mcp__a_c_b_c", 0), ("mcp__a**b", "mcp__ab", 0), ("mcp__*x*x*", "mcp__x", 1),
        # anchoring: a piece must open and close the name, and the pieces may not overlap
        ("mcp__a", "mcp__a__b", 1), ("*a", "mcp__ab", 1), ("mcp__ab*ba", "mcp__aba", 1),
        ("mcp__ab*ba", "mcp__abba", 0), ("mcp__a*", "xmcp__a", 1),
        # an inner piece is looked for only before the closing piece, never inside it
        ("mcp__*ab*ab", "mcp__ab", 1), ("mcp__*ab*ab", "mcp__abab", 0), ("*b*b", "mcp__b", 1),
        ("*b*b", "mcp__bb", 0),
    ]
    for rule, name, expected in table:
        code, out, err = call(MATCH, rule, name)
        check("match/%s against %s answers %s" % (rule, name, ("match", "no match")[expected]),
              code == expected, (code, err))
    for rule, name in (("mcp__x\n", "mcp__x"), ("x*", "mcp__x"), ("", "mcp__x")):
        code, out, err = call(MATCH, rule, name)
        check("match/an invalid rule %s is an error, not a no-match" % json.dumps(rule), code == 2, (code, err))
    for name in ("mcp__aé", "mcp__a\tb", "mcp__a\x7f", "mcp__a\nb", "mcp__ "):
        code, out, err = call(MATCH, "*", name)
        check("match/a name outside printable ASCII %s is an error" % json.dumps(name), code == 2, (code, err))

    # Many * against a long name: no backtracking, no error, well inside a second.
    many = "mcp__*" + "a*" * 123 + "c*b"
    long_name = "mcp__" + "a" * 20000 + "b"
    started = time.monotonic()
    code, out, err = call(MATCH, many, long_name)
    elapsed = time.monotonic() - started
    check("match/a mask of many * against a long name: no match, no error, under a second",
          len(many) <= 256 and code == 1 and elapsed < 1.0, (code, elapsed, err))
    started = time.monotonic()
    code, out, err = call(MATCH, "mcp__" + "*a" * 124 + "*b", long_name)
    elapsed = time.monotonic() - started
    check("match/a mask of many * against a long name it fits: match, under a second",
          code == 0 and elapsed < 1.0, (code, elapsed, err))

    # ---- the global lists --------------------------------------------------------------------
    with tempfile.TemporaryDirectory(prefix="fleet-mcp-policy-test-") as temporary:
        rules_file = Path(temporary) / "fleet.json"

        def lists(document):
            rules_file.write_text(document if isinstance(document, str) else json.dumps(document))
            code, out, err = call(LISTS, rules_file)
            return code, out.split("\n")[:2], err

        code, out, err = lists({"main": {}})
        check("lists/missing keys read as []", code == 0 and out == ["[]", "[]"], (code, out, err))
        code, out, err = lists({"allowed_mcp_tools": None, "disallowed_mcp_tools": None})
        check("lists/null reads as []", code == 0 and out == ["[]", "[]"], (code, out, err))
        code, out, err = lists("null")
        check("lists/a null rules file reads as empty lists", code == 0 and out == ["[]", "[]"], (code, out, err))
        code, out, err = lists({"allowed_mcp_tools": ["mcp__gateway*"], "disallowed_mcp_tools": ["mcp__a__b", "*x"]})
        check("lists/valid lists are returned as JSON",
              code == 0 and [json.loads(o) for o in out] == [["mcp__gateway*"], ["mcp__a__b", "*x"]],
              (code, out, err))
        for key in ("allowed_mcp_tools", "disallowed_mcp_tools"):
            for label, value in (("a string", "mcp__x"), ("an object", {}), ("a number", 5), ("true", True),
                                 ("a null entry", [None]), ("a number entry", [5]), ("a list entry", [["mcp__x"]]),
                                 ("an invalid rule", ["gateway__*"]), ("a rule ending in a newline", ["mcp__x\n"]),
                                 ("an empty rule", [""]), ("a rule of 257 bytes", ["mcp__" + "a" * 252])):
                code, out, err = lists({key: value})
                check("lists/%s: %s is a configuration error" % (key, label), code == 1, (code, out, err))
            code, out, err = lists({key: ["mcp__t%d" % i for i in range(256)]})
            check("lists/%s: 256 rules are accepted" % key, code == 0, (code, err))
            try:
                returned = json.loads(out[0 if key == "allowed_mcp_tools" else 1])
            except ValueError:
                returned = None
            check("lists/%s: all 256 rules are returned, the 256th included" % key,
                  returned == ["mcp__t%d" % i for i in range(256)],
                  (code, len(returned) if isinstance(returned, list) else returned, err))
            code, out, err = lists({key: ["mcp__t%d" % i for i in range(257)]})
            check("lists/%s: 257 rules are refused" % key, code == 1, (code, err))

    # ---- evaluation --------------------------------------------------------------------------
    def permits(name, allow, deny, frames=SELF):
        return call(PERMITS, json.dumps(name), json.dumps(allow), json.dumps(deny), json.dumps(frames))

    code, out, err = permits("mcp__mail__send", [], [])
    check("permits/both lists empty: passes", code == 0, (code, out, err))
    code, out, err = permits("mcp__gateway__kb__search", ["mcp__gateway*"], [])
    check("permits/global allow matches: passes", code == 0, (code, out, err))
    code, out, err = permits("mcp__mail__send", ["mcp__gateway*"], [])
    check("permits/global allow without a match: refused",
          code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__send": no allow rule matches it '
                               '(global and this agent\'s brief).', (code, out, err))
    code, out, err = permits("mcp__mail__send", ["mcp__mail__*"], ["mcp__mail__s*"])
    check("permits/global deny wins over global allow",
          code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__send": the global rule "mcp__mail__s*" denies it.',
          (code, out, err))
    code, out, err = permits("mcp__mail__read", [], [], [{"self": True, "allow": [], "deny": ["*__read"]}])
    check("permits/a deny rule of this agent's frame",
          code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__read": the deny rule "*__read" of this agent\'s '
                               'brief matches it.', (code, out, err))
    code, out, err = permits("mcp__mail__read", [], [], SELF + [{"id": "a1", "allow": [], "deny": ["*__read"]}])
    check("permits/a deny rule of a frame above",
          code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__read": the deny rule "*__read" of the brief of '
                               'agent a1 above matches it.', (code, out, err))
    code, out, err = permits("mcp__mail__read", [], [], SELF + [{"id": "a1", "allow": ["mcp__kb__*"], "deny": []}])
    check("permits/a frame above whose allow set has no match",
          code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__read": no allow rule of agent a1 above matches it.',
          (code, out, err))
    code, out, err = permits("mcp__mail__read", [], [], [{"self": True, "allow": ["mcp__mail__read"], "deny": []}])
    check("permits/a frame's allow adds to an empty global list", code == 0, (code, out, err))
    code, out, err = permits("mcp__aé", [], [])
    check("permits/a name outside printable ASCII is an invalid name", code == 3, (code, out, err))
    code, out, err = permits("mcp__a\u0000", [], [])
    check("permits/a name holding NUL is an invalid name", code == 3, (code, out, err))
    code, out, err = permits(5, [], [])
    check("permits/a name that is not a string is an invalid name", code == 3, (code, out, err))
    code, out, err = permits("mcp__x", ["bad"], [])
    check("permits/an invalid rule in a list cannot be evaluated", code == 2, (code, out, err))
    code, out, err = call(PERMITS, "{not json", "[]", "[]", json.dumps(SELF))
    check("permits/input that is not JSON cannot be evaluated", code == 2, (code, out, err))

    # The largest input the evaluation takes: 32 frames, each with two lists of 256 rules of 256
    # bytes, beside global lists of the same size, about 4 MB in all. Handed to jq as process
    # arguments it would end every call in "could not be evaluated".
    def full_list(tag, last=None):
        rules = ["mcp__%s%03d" % (tag, i) + "x" * (248 - len(tag)) for i in range(256)]
        if last is not None:
            rules[-1] = last
        return rules

    every = "mcp__" + "*" * 251
    mail = "mcp__mail__" + "*" * 245
    big_frames = [{"self": True, "allow": full_list("sa", every), "deny": full_list("sd")}] + [
        {"id": "agent%02d" % i, "allow": full_list("a%02d" % i, every), "deny": full_list("d%02d" % i)}
        for i in range(1, 32)]
    sizes_ok = (len(big_frames) == 32 and all(len(f[k]) == 256 and all(len(r) == 256 for r in f[k])
                                              for f in big_frames for k in ("allow", "deny"))
                and len(every) == 256 and len(mail) == 256)
    check("permits/fixture: 32 frames of two lists of 256 rules of 256 bytes", sizes_ok)
    with tempfile.TemporaryDirectory(prefix="fleet-mcp-policy-test-") as temporary:
        def permits_files(name, allow, deny, frames):
            paths = []
            for label, value in (("allow", allow), ("deny", deny), ("frames", frames)):
                path = Path(temporary) / label
                path.write_text(json.dumps(value))
                paths.append(path)
            return call(PERMITS_FILES, json.dumps(name), *paths)

        started = time.monotonic()
        code, out, err = permits_files("mcp__mail__read", full_list("ga", every), full_list("gd"), big_frames)
        elapsed = time.monotonic() - started
        check("permits/the largest input: permitted when every frame permits it",
              code == 0 and out == "", (code, out[:200], err[:200], round(elapsed, 2)))
        last_denies = big_frames[:-1] + [dict(big_frames[-1], deny=full_list("d31", mail))]
        code, out, err = permits_files("mcp__mail__read", full_list("ga", every), full_list("gd"), last_denies)
        check("permits/the largest input: the 256th deny rule of the 32nd frame refuses",
              code == 1 and out == 'FLEET_MCP_DENIED: "mcp__mail__read": the deny rule %s of the brief of agent '
                                   'agent31 above matches it.' % json.dumps(mail), (code, out[:300], err[:200]))

    print("Policy checks: %d; failures: %d" % (count, len(errors)))
    for error in errors:
        print("FAIL " + error)
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
