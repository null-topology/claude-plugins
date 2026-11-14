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
# The block reader on one brief, as JSON text ($1); prints what it sets, one value a line.
BLOCK = SOURCE + ('rc=0; mcp_block "$1" || rc=$?; '
                  'allow=$(printf "%s" "$mcp_block_lists" | jq -c .allow) || exit 98; '
                  'deny=$(printf "%s" "$mcp_block_lists" | jq -c .deny) || exit 98; '
                  'printf "%s\\n%s\\n%s\\n%s\\n%s" "$mcp_block_marked" "$mcp_block_found" "$allow" '
                  '"$deny" "$mcp_block_error"; exit $rc')
BODY = "## Objective\nSynthetic test content.\n"
BOUNDS = "MCP policy: more than 256 rules, or a rule longer than 256 bytes."


def line_error(number, reason):
    return "MCP policy: line %d: %s." % (number, reason)

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
        # Full size: 256 rules of 256 bytes in each list. Splitting the 64 KiB of one list off the
        # other with a pattern took seconds in some shells, past the guard's time limit.
        full_allow = ["mcp__a%03d" % i + "x" * 247 for i in range(256)]
        full_deny = ["mcp__d%03d" % i + "x" * 247 for i in range(256)]
        started = time.monotonic()
        code, out, err = lists({"allowed_mcp_tools": full_allow, "disallowed_mcp_tools": full_deny})
        elapsed = time.monotonic() - started
        try:
            read = [json.loads(text) for text in out]
        except ValueError:
            read = None
        check("lists/two full-size lists are read well inside a second",
              code == 0 and read == [full_allow, full_deny] and elapsed < 1.0, (code, round(elapsed, 2), err))
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

    # ---- the per-spawn block ----------------------------------------------------------------
    def block(brief):
        """(status, marked, found, allow, deny, error) of mcp_block on one brief."""
        code, out, err = call(BLOCK, json.dumps(brief))
        values = out.split("\n")
        values += [""] * (5 - len(values))
        return (code,) + tuple(values[:5]) + (err,)

    def items(key, rules):
        return key + ":\n" + "".join('  - %s\n' % json.dumps(r) for r in rules)

    valid_blocks = [
        ("allow and deny", "---\n" + items("allow", ["mcp__mail__read"]) + items("deny", ["*__search"]) + "---\n" + BODY,
         ["mcp__mail__read"], ["*__search"]),
        ("deny before allow", "---\n" + items("deny", ["*__search"]) + items("allow", ["mcp__mail__read"]) + "---\n"
         + BODY, ["mcp__mail__read"], ["*__search"]),
        ("allow alone", "---\n" + items("allow", ["mcp__a", "mcp__b*"]) + "---\n" + BODY, ["mcp__a", "mcp__b*"], []),
        ("deny alone", "---\n" + items("deny", ["*"]) + "---\n" + BODY, [], ["*"]),
        ("CRLF endings", ("---\n" + items("allow", ["mcp__a"]) + items("deny", ["mcp__b"]) + "---\n" + BODY)
         .replace("\n", "\r\n"), ["mcp__a"], ["mcp__b"]),
        ("mixed endings", "---\r\nallow:\n  - \"mcp__a\"\r\ndeny:\r\n  - \"mcp__b\"\n---\r\n" + BODY,
         ["mcp__a"], ["mcp__b"]),
        ("a JSON escape in a rule", '---\nallow:\n  - "mcp\\u005f_a"\n---\n' + BODY, ["mcp__a"], []),
        ("256 rules of 256 bytes in each list",
         "---\n" + items("allow", ["mcp__a%03d" % i + "x" * 247 for i in range(256)])
         + items("deny", ["mcp__d%03d" % i + "x" * 247 for i in range(256)]) + "---\n" + BODY,
         ["mcp__a%03d" % i + "x" * 247 for i in range(256)], ["mcp__d%03d" % i + "x" * 247 for i in range(256)]),
        ("a block and nothing after it", "---\n" + items("allow", ["mcp__a"]) + "---\n", ["mcp__a"], []),
    ]
    for label, brief, allow, deny in valid_blocks:
        code, marked, found, out_allow, out_deny, error, err = block(brief)
        try:
            lists_read = (json.loads(out_allow), json.loads(out_deny))
        except ValueError:
            lists_read = None
        check("block/valid: %s" % label,
              code == 0 and marked == "1" and found == "1" and lists_read == (allow, deny) and error == "",
              (code, marked, found, out_allow[:80], out_deny[:80], error, err))

    no_blocks = [
        ("a brief without a block", BODY),
        ("a thematic break inside a section", BODY + "---\nallow is a word here\n"),
        ("block-like lines after the first heading", BODY + "---\n" + items("allow", ["mcp__a"]) + "---\n"),
        ("allow: before the first heading without a --- line", "allow:\n" + BODY),
        ("--- before the first heading followed by other text", "Intro\n---\nNotes\n" + BODY),
        ("an empty brief", ""),
        # only a byte-order mark, blanks, tabs and carriage returns around a line are dropped
        ("a no-break space before ---", " ---\nallow:\n  - \"mcp__a\"\n---\n" + BODY),
        ("a no-break space before allow:", "Intro\n---\n allow:\n" + BODY),
        ("a form feed after ---", "Intro\n---\f\nallow:\n" + BODY),
        ("blanks inside the dashes", "Intro\n- - -\ndeny:\n" + BODY),
        ("text after --- and blanks", "Intro\n---  x\ndeny:\n" + BODY),
        ("text before allow:", "Intro\n---\nx allow:\n" + BODY),
    ]
    for label, brief in no_blocks:
        code, marked, found, out_allow, out_deny, error, err = block(brief)
        check("block/none: %s" % label,
              code == 0 and marked == "" and found == "" and out_allow == "[]" and out_deny == "[]" and error == "",
              (code, marked, found, out_allow, out_deny, error, err))

    rules_257 = ["mcp__a%03d" % i for i in range(257)]
    invalid_blocks = [
        # step 2: a block that does not start at line 1
        ("a leading blank line", "\n---\n" + items("allow", ["mcp__a"]) + "---\n" + BODY,
         line_error(2, "the policy block must start at line 1"), ""),
        ("--- with a trailing blank", "--- \n" + items("allow", ["mcp__a"]) + "---\n" + BODY,
         line_error(1, "the policy block must start at line 1"), "1"),
        ("a byte-order mark", "﻿---\n" + items("allow", ["mcp__a"]) + "---\n" + BODY,
         line_error(1, "the policy block must start at line 1"), "1"),
        ("a block after other text", "Intro\n---\n" + items("deny", ["*"]) + "---\n" + BODY,
         line_error(2, "the policy block must start at line 1"), ""),
        ("an indented block", "  ---\n  allow:\n    - \"mcp__a\"\n  ---\n" + BODY,
         line_error(1, "the policy block must start at line 1"), "1"),
        ("a block with a lone CR at line 1", "---\r\r\n" + items("allow", ["mcp__a"]) + "---\n" + BODY,
         line_error(1, "the policy block must start at line 1"), "1"),
        ("tabs, marks and CRs around --- and before deny:", "\t﻿--- \r\n \t﻿deny:\r\n  - \"*\"\n---\n"
         + BODY, line_error(1, "the policy block must start at line 1"), "1"),
        ("marks, blanks and CRs around a --- after other text", "Intro\n\r﻿ --- \t﻿\r\n﻿\r allow:\n"
         + BODY, line_error(2, "the policy block must start at line 1"), ""),
        ("--- and blanks alone before the first heading, then deny:", "Intro\n---" + " \t" * 40 + "\ndeny:\n" + BODY,
         line_error(2, "the policy block must start at line 1"), ""),
        # step 1: line 1 is ---, and the grammar applies
        ("--- opening other front matter", "---\ntitle: x\n---\n" + BODY, line_error(2, "expected allow or deny"), ""),
        ("a thematic break at line 1", "---\n" + BODY, line_error(2, "expected allow or deny"), ""),
        ("no key at all", "---\n---\n" + BODY, line_error(2, "expected allow or deny"), ""),
        ("an inline list", '---\nallow: ["mcp__a"]\n---\n' + BODY, line_error(2, "expected allow or deny"), "1"),
        ("a mark, a tab and a CR around deny:", "---\n﻿\tdeny:\r\r\n  - \"*\"\n---\n" + BODY,
         line_error(2, "expected allow or deny"), "1"),
        ("a key with a trailing blank", "---\nallow: \n  - \"mcp__a\"\n---\n" + BODY,
         line_error(2, "expected allow or deny"), "1"),
        ("an item before any key", '---\n  - "mcp__a"\n---\n' + BODY, line_error(2, "expected allow or deny"), ""),
        ("another key after a list", "---\n" + items("allow", ["mcp__a"]) + "other:\n---\n" + BODY,
         line_error(4, "expected allow or deny"), "1"),
        ("a comment in the block", "---\n" + items("allow", ["mcp__a"]) + "# note\n---\n" + BODY,
         line_error(4, "expected allow or deny"), "1"),
        ("a blank line in the block", "---\n" + items("allow", ["mcp__a"]) + "\n---\n" + BODY,
         line_error(4, "expected allow or deny"), "1"),
        ("a duplicate key", "---\n" + items("allow", ["mcp__a"]) + items("allow", ["mcp__b"]) + "---\n" + BODY,
         line_error(4, "duplicate key"), "1"),
        ("a key with no rule before another key", "---\nallow:\n" + items("deny", ["mcp__a"]) + "---\n" + BODY,
         line_error(2, "a key needs at least one rule"), "1"),
        ("a key with no rule before the closing line", "---\ndeny:\n---\n" + BODY,
         line_error(2, "a key needs at least one rule"), "1"),
        ("an unquoted rule", "---\nallow:\n  - mcp__a\n---\n" + BODY, line_error(3, "expected a double-quoted rule"),
         "1"),
        ("a single-quoted rule", "---\nallow:\n  - 'mcp__a'\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("three spaces before the dash", "---\nallow:\n   - \"mcp__a\"\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("a tab before the dash", "---\nallow:\n\t- \"mcp__a\"\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("text after the rule", "---\nallow:\n  - \"mcp__a\" # note\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("two strings on one item", "---\nallow:\n  - \"mcp__a\" \"mcp__b\"\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("a broken escape", "---\nallow:\n  - \"mcp__\\x\"\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("a blank line where a rule is due", "---\nallow:\n\n---\n" + BODY,
         line_error(3, "expected a double-quoted rule"), "1"),
        ("an invalid rule", "---\n" + items("deny", ["gateway__*"]) + "---\n" + BODY,
         line_error(3, 'invalid rule "gateway__*"'), "1"),
        ("an empty rule", "---\n" + items("deny", [""]) + "---\n" + BODY, line_error(3, 'invalid rule ""'), "1"),
        ("a rule holding a line break", "---\n" + items("allow", ["mcp__a\n"]) + "---\n" + BODY,
         line_error(3, 'invalid rule "mcp__a\\n"'), "1"),
        ("a rule of 257 bytes", "---\n" + items("allow", ["mcp__" + "a" * 252]) + "---\n" + BODY, BOUNDS, "1"),
        ("257 rules in one list", "---\n" + items("deny", rules_257) + "---\n" + BODY, BOUNDS, "1"),
        ("no closing line", "---\n" + items("allow", ["mcp__a"]), line_error(4, "missing closing ---"), "1"),
        ("a closing line without a line break", "---\n" + items("allow", ["mcp__a"]) + "---",
         line_error(4, "missing closing ---"), "1"),
    ]
    for label, brief, expected, marked_expected in invalid_blocks:
        code, marked, found, out_allow, out_deny, error, err = block(brief)
        check("block/invalid: %s" % label,
              code == 1 and error == expected and found == "" and out_allow == "[]" and out_deny == "[]"
              and marked == marked_expected and "Synthetic test content" not in error,
              (code, marked, found, error, err))

    for label, text in (("a number", "5"), ("text that is not JSON", "{not json"), ("two strings", '"a" "b"'),
                        ("nothing", "")):
        code, out, err = call(BLOCK, text)
        check("block/%s instead of a brief cannot be read" % label, code == 2, (code, out, err))

    big_brief = "---\n" + items("deny", ["mcp__x"]) + "---\n" + BODY + ("Filler line of a large brief.\n" * 30000)
    started = time.monotonic()
    code, marked, found, out_allow, out_deny, error, err = block(big_brief)
    elapsed = time.monotonic() - started
    check("block/a brief of about 900 KB is read well inside a second",
          code == 0 and out_deny == '["mcp__x"]' and elapsed < 1.0, (code, error, err, round(elapsed, 2)))
    full = ["mcp__f%03d" % i + "x" * 247 for i in range(256)]
    started = time.monotonic()
    code, marked, found, out_allow, out_deny, error, err = block("---\n" + items("allow", full) + items("deny", full)
                                                                  + "---\n" + BODY)
    elapsed = time.monotonic() - started
    check("block/a block of two full-size lists is read well inside a second",
          code == 0 and found == "1" and out_deny == json.dumps(full, separators=(",", ":")) and elapsed < 1.0,
          (code, error, err, round(elapsed, 2)))

    # A long run of blanks inside a line read with blanks dropped (line 1, line 2, and a line holding
    # --- before the first heading or the line after it) is read in time linear in its length: a
    # brief of a few hundred KB stays well inside a second.
    run = " " * 64000
    mixed = "﻿ \t\r" * 16000
    long_runs = [
        ("line 1", "word" + run + "word\n" + BODY, 0, "", ""),
        ("line 1, mixed blanks", "word" + mixed + "word\n" + BODY, 0, "", ""),
        ("line 2 after ---", "---\nallow:" + run + "x\n" + BODY, 1, line_error(2, "expected allow or deny"), "1"),
        ("a --- line before the first heading", "Intro\n---" + run + "x\n" + BODY, 0, "", ""),
        ("a --- line before the first heading, mixed blanks", "Intro\n---" + mixed + "x\n" + BODY, 0, "", ""),
        ("the line after a --- before the first heading", "Intro\n---\nallow:" + run + "x\n" + BODY, 1,
         line_error(2, "the policy block must start at line 1"), ""),
    ]
    for label, brief, code_expected, error_expected, marked_expected in long_runs:
        started = time.monotonic()
        code, marked, found, out_allow, out_deny, error, err = block(brief)
        elapsed = time.monotonic() - started
        check("block/64,000 blanks inside %s are read well inside a second" % label,
              code == code_expected and error == error_expected and marked == marked_expected and found == ""
              and elapsed < 1.0, (code, marked, error, err, round(elapsed, 2)))

    # ---- the per-spawn block of a transcript's first record ------------------------------------
    record_snippet = BLOCK.replace('mcp_block "$1"', 'mcp_block --record "$1"')

    def record_line(content, kind="user"):
        return json.dumps({"type": kind, "message": {"role": kind, "content": content}})

    with tempfile.TemporaryDirectory(prefix="fleet-mcp-policy-test-") as temporary:
        def record(text):
            """(status, marked, found, allow, deny, error) of mcp_block --record on a file of text."""
            path = Path(temporary) / "agent-a1.jsonl"
            path.write_bytes(text.encode())
            code, out, err = call(record_snippet, str(path))
            values = out.split("\n")
            values += [""] * (5 - len(values))
            return (code,) + tuple(values[:5]) + (err,)

        with_block = "---\n" + items("allow", ["mcp__mail__read"]) + items("deny", ["*__search"]) + "---\n" + BODY
        later = "\n" + json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}]}}) + "\n"
        valid_records = [
            ("a record with a block and later records", record_line(with_block) + later,
             '["mcp__mail__read"]', '["*__search"]', "1"),
            ("a record without a trailing line break", record_line(with_block), '["mcp__mail__read"]', '["*__search"]',
             "1"),
            ("a record without a block", record_line(BODY) + later, "[]", "[]", ""),
        ]
        for label, text, allow, deny, found_expected in valid_records:
            code, marked, found, out_allow, out_deny, error, err = record(text)
            check("record/valid: %s" % label, code == 0 and found == found_expected and out_allow == allow
                  and out_deny == deny and not error, (code, marked, found, out_allow, out_deny, error, err))

        code, marked, found, out_allow, out_deny, error, err = record(
            record_line("---\n" + items("allow", ["mcp_bad"]) + "---\n" + BODY) + later)
        check("record/an invalid block in the record is invalid with its reason",
              code == 1 and marked == "1" and error == line_error(3, 'invalid rule "mcp_bad"'),
              (code, marked, error, err))

        unavailable_records = [
            ("an assistant record first", record_line(with_block, kind="assistant") + later),
            ("content given as parts", json.dumps({"type": "user", "message": {"content": [{"type": "text",
                                                                                          "text": with_block}]}}) + "\n"),
            ("a first line that is not JSON", "{not json\n" + record_line(with_block) + "\n"),
            ("an empty file", ""),
            ("a JSON string first", json.dumps(with_block) + "\n"),
        ]
        for label, text in unavailable_records:
            code, marked, found, out_allow, out_deny, error, err = record(text)
            check("record/no brief: %s" % label, code == 3 and not found and not error, (code, found, error, err))
        code, out, err = call(record_snippet, str(Path(temporary) / "agent-missing.jsonl"))
        check("record/no brief: a transcript that cannot be read", code == 3, (code, out, err))

        # The read stops at 1 MiB and one byte, inside a later record; where it cuts a character in
        # two, the text read still ends where the reader left it.
        head = record_line(with_block) + "\n"
        for character, cut in (("€", 1), ("€", 2), ("\U0001f600", 1), ("\U0001f600", 2), ("\U0001f600", 3)):
            text = head + "x" * (1048577 - cut - len(head.encode())) + character * 4 + "\n"
            code, marked, found, out_allow, out_deny, error, err = record(text)
            check("record/a read that ends after %d of the %d bytes of a character in a later record"
                  % (cut, len(character.encode())),
                  code == 0 and found == "1" and out_deny == '["*__search"]', (code, found, error, err))
        code, marked, found, out_allow, out_deny, error, err = record(head + "\x01")
        check("record/a transcript ending in U+0001 is read as it is",
              code == 0 and found == "1" and out_deny == '["*__search"]', (code, found, error, err))

        base = record_line(with_block)
        exact = record_line(with_block + "x" * (1048576 - len(base)))
        code, marked, found, out_allow, out_deny, error, err = record(exact + later)
        check("record/a first line of exactly 1 MiB is read", len(exact.encode()) == 1048576 and code == 0
              and out_deny == '["*__search"]', (len(exact.encode()), code, error, err))
        over = record_line(with_block + "x" * (1048577 - len(base)))
        code, marked, found, out_allow, out_deny, error, err = record(over + later)
        check("record/a first line one byte over 1 MiB is no brief", len(over.encode()) == 1048577 and code == 3,
              (len(over.encode()), code, error, err))
        code, marked, found, out_allow, out_deny, error, err = record(over)
        check("record/a single line over 1 MiB without a line break is no brief", code == 3, (code, error, err))

    print("Policy checks: %d; failures: %d" % (count, len(errors)))
    for error in errors:
        print("FAIL " + error)
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
