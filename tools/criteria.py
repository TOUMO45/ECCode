#!/usr/bin/env python3
"""S4 metric M1 (plan section 6): criteria passed / criteria total from a pytest junit file.

  python3 tools/criteria.py junit.xml criteria.json [--second junit2.xml]   -> JSON on stdout

A criterion passes iff every one of its tests passed. It fails closed: a test that is skipped, errored,
or listed in criteria.json but absent from the junit file does not pass its criterion.
criteria.json maps criterion ids to test ids: {"C1": ["tests/test_ingest.py::test_good_file", ...]}.
A test id may be a pytest node id, "classname::name", or a bare test name when that name is unique.
--second compares a second run of the same suite (plan: "Run twice; differing results mark the flaky
tests"; continuation criterion C3 needs agreement on at least 98% of tests).
Exit: 0 scored, 1 usage or unreadable input, 2 scored but criteria.json names tests the run does not contain.
"""
import json
import sys
import xml.etree.ElementTree as ET


def outcomes(junit_path):
    """{key: outcome} for every testcase, under each spelling a criteria file may use."""
    by_key, names, cases = {}, {}, []
    for case in ET.parse(junit_path).getroot().iter("testcase"):
        classname, name = case.get("classname", ""), case.get("name", "")
        kinds = {child.tag for child in case}
        outcome = "failed" if kinds & {"failure", "error"} else "skipped" if "skipped" in kinds else "passed"
        cases.append((classname, name, outcome))
        node = classname.replace(".", "/") + ".py::" + name          # tests.test_x -> tests/test_x.py::name
        for key in (f"{classname}::{name}", node, f"{classname}.{name}"):
            by_key[key] = outcome
        names.setdefault(name, []).append(outcome)
    for name, found in names.items():                                 # a bare name only when it is unambiguous
        if len(found) == 1:
            by_key.setdefault(name, found[0])
    return by_key, cases


def score(junit_path, criteria):
    by_key, cases = outcomes(junit_path)
    rows, unmatched = {}, []
    for cid, tests in criteria.items():
        results = {t: by_key.get(t, "missing") for t in tests}
        unmatched += [f"{cid}: {t}" for t, r in results.items() if r == "missing"]
        rows[cid] = {"passed": bool(tests) and all(r == "passed" for r in results.values()), "tests": results}
    raw = {k: sum(1 for c in cases if c[2] == k) for k in ("passed", "failed", "skipped")}
    passed = sum(1 for r in rows.values() if r["passed"])
    return {"criteria_passed": passed, "criteria_total": len(rows),
            "pass_rate": round(passed / len(rows), 4) if rows else None,
            "raw": {**raw, "total": len(cases)}, "unmatched": unmatched, "criteria": rows}, cases


def main(argv):
    argv, second = list(argv), None
    if "--second" in argv:                      # take the flag and its value out by position, not by value
        at = argv.index("--second")
        second = argv[at + 1] if at + 1 < len(argv) else None
        del argv[at:at + 2]
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        sys.stderr.write("usage: criteria.py junit.xml criteria.json [--second junit2.xml]\n")
        return 1
    try:
        with open(args[1], encoding="utf-8") as handle:
            criteria = json.load(handle)
        if not isinstance(criteria, dict) or not all(isinstance(v, list) for v in criteria.values()):
            raise ValueError("criteria.json must map criterion ids to lists of test ids")
        result, cases = score(args[0], criteria)
        if second:
            _, cases2 = score(second, criteria)
            first = {(c, n): o for c, n, o in cases}
            other = {(c, n): o for c, n, o in cases2}
            keys = sorted(set(first) | set(other))
            flaky = [f"{c}::{n}" for c, n in keys if first.get((c, n)) != other.get((c, n))]
            agree = (len(keys) - len(flaky)) / len(keys) if keys else None
            result["stability"] = {"tests": len(keys), "differing": flaky,
                                   "agreement": round(agree, 4) if agree is not None else None,
                                   "meets_C3": agree is not None and agree >= 0.98}
    except (OSError, ValueError, ET.ParseError) as exc:
        sys.stderr.write(f"criteria.py: {exc}\n")
        return 1
    print(json.dumps(result, indent=2))
    return 2 if result["unmatched"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
