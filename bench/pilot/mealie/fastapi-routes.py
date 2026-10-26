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


def served(routes):
    """(methods, path) for each route; FastAPI 0.141+ keeps an included router
    as one node whose routes, with their full paths, are its effective contexts."""
    for r in routes:
        contexts = getattr(r, "effective_route_contexts", None)
        if callable(contexts):
            for c in contexts():
                # A plain Starlette route (add_route, @router.route) keeps its methods and path on starlette_route.
                plain = getattr(c, "starlette_route", None)
                yield c.methods or getattr(plain, "methods", None), c.path or getattr(plain, "path", None)
        else:
            yield getattr(r, "methods", None), getattr(r, "path", None)


routes = set()
for methods, route_path in served(app.routes):
    for m in methods or []:
        if m != "HEAD":
            routes.add(f"{m} {route_path}")
with open(out, "w", newline="\n") as fh:  # the same bytes on every platform
    fh.write("\n".join(sorted(routes)) + "\n")
