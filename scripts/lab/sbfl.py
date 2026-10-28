#!/usr/bin/env python3
"""Spectrum data for ECCode's fault localizer (eccode debug localize --sbfl).

Runs the given pytest arguments under coverage.py with one dynamic context per
test function and a JUnit report, then prints one JSON document:

  {"tests": {"<context>": "passed" | "failed"}, "lines": {"<file>": {"<line>": ["<context>", ...]}},
   "collected": <n>, "failed": <n>, "pytestExit": <code>}

Everything it writes goes under --work (a temporary directory the engine
owns), never into the project: the data file, the rcfile, the JUnit report
and the coverage JSON. The project's interpreter runs it, so coverage and
pytest come from the project's environment. Zero dependencies beyond those.
"""
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET


def main(argv):
    if "--" not in argv:
        sys.stderr.write("usage: sbfl.py --work <dir> --out <file> -- <pytest args>\n")
        return 2
    k = argv.index("--")
    opts, pytest_args = argv[:k], argv[k + 1:]
    work = opts[opts.index("--work") + 1]
    out = opts[opts.index("--out") + 1]
    os.makedirs(work, exist_ok=True)
    data = os.path.join(work, "coverage.sqlite")
    rc = os.path.join(work, "coveragerc")
    junit = os.path.join(work, "junit.xml")
    cov_json = os.path.join(work, "coverage.json")
    with open(rc, "w", encoding="utf-8") as f:
        f.write("[run]\ndynamic_context = test_function\nbranch = False\n[json]\nshow_contexts = True\n")
    env = dict(os.environ)
    env["COVERAGE_RCFILE"] = rc
    run = subprocess.run(
        [sys.executable, "-m", "coverage", "run", "--data-file=" + data, "--rcfile=" + rc, "-m", "pytest",
         *pytest_args, "--junitxml=" + junit, "-p", "no:cacheprovider", "-q", "-o", "junit_family=xunit2"],
        env=env,
    )
    report = subprocess.run(
        [sys.executable, "-m", "coverage", "json", "--data-file=" + data, "--rcfile=" + rc, "--show-contexts", "-o", cov_json, "-q"],
        env=env,
    )
    tests = {}
    collected = 0
    failed = 0
    if os.path.exists(junit):
        root = ET.parse(junit).getroot()
        for case in root.iter("testcase"):
            collected += 1
            cls = case.get("classname") or ""
            name = (case.get("name") or "").split("[")[0]
            key = (cls + "." + name) if cls else name
            bad = any(child.tag in ("failure", "error") for child in case)
            if bad:
                failed += 1
            # A parametrized test shares one coverage context: one failing case fails the function.
            if tests.get(key) != "failed":
                tests[key] = "failed" if bad else "passed"
    lines = {}
    if report.returncode == 0 and os.path.exists(cov_json):
        with open(cov_json, encoding="utf-8") as f:
            cov = json.load(f)
        for file, info in cov.get("files", {}).items():
            per_line = {}
            for line, contexts in (info.get("contexts") or {}).items():
                names = [c for c in contexts if c]
                if names:
                    per_line[line] = names
            if per_line:
                lines[file] = per_line
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"tests": tests, "lines": lines, "collected": collected, "failed": failed, "pytestExit": run.returncode, "coverageExit": report.returncode}, f)
    # The run is evidence of the tests' outcome: exit as pytest did (1 = some failed).
    return run.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
