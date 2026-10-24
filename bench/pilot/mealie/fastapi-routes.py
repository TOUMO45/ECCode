"""Every HTTP route Mealie's app serves, as "METHOD /path" lines (A3's ground truth).

usage: <venv python> fastapi-routes.py <tree> <out.txt>

Imports mealie.app from the tree with the environment Mealie's own tests set,
then writes the sorted routes FastAPI registered to out.txt, one per line
(HEAD left out: FastAPI adds it for every GET). The app logs to stdout when
it is imported, so stdout is not the output.
"""
import os
import sys

tree = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2])
os.environ.setdefault("PRODUCTION", "True")
os.environ.setdefault("TESTING", "True")
os.chdir(tree)
sys.path.insert(0, tree)

from mealie.app import app  # noqa: E402

routes = set()
for r in app.routes:
    for m in getattr(r, "methods", None) or []:
        if m != "HEAD":
            routes.add(f"{m} {r.path}")
with open(out, "w", newline="\n") as fh:  # the same bytes on every platform
    fh.write("\n".join(sorted(routes)) + "\n")
