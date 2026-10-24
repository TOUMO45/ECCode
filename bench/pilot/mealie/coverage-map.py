"""Which test files run each backend module (A2's ground truth).

usage: <venv python> coverage-map.py <tree> <out.json>

Runs the whole backend suite under coverage with one context per test
(cov_context.py), then writes {"exitCode": n, "map": {module: [test files]}}
for every measured file under mealie/. A test file counts for a module when
at least one of its tests ran a line of it in its own context.
"""
import json
import os
import subprocess
import sys

tree, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
data_file = os.path.join(tree, ".coverage.pilot")
env = dict(os.environ, PYTHONPATH=here + os.pathsep + os.environ.get("PYTHONPATH", ""), COVERAGE_FILE=data_file)
cmd = [sys.executable, "-m", "coverage", "run", "--source=mealie", "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "cov_context", "tests"]
code = subprocess.run(cmd, cwd=tree, env=env).returncode

import coverage  # noqa: E402  (the tree's venv provides it)

data = coverage.CoverageData(basename=data_file)
data.read()
result = {}
for f in data.measured_files():
    rel = os.path.relpath(f, tree).replace(os.sep, "/")
    files = set()
    for contexts in data.contexts_by_lineno(f).values():
        files.update(c.split("::")[0] for c in contexts if c)
    result[rel] = sorted(files)
with open(out, "w") as fh:
    json.dump({"exitCode": code, "map": result}, fh)
