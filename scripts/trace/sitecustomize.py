# Runtime import tracer (Python). Put on PYTHONPATH by `eccode impact --trace`:
# a sys.meta_path finder records every in-project module file the traced
# command loads - importlib/__import__ included - to ECCODE_TRACE_FILE.
# Python import machinery carries no importer file, so these are recorded as
# loads (coverage proof), not from->to edges.
import json
import os
import sys

_out = os.environ.get("ECCODE_TRACE_FILE")
_root = os.environ.get("ECCODE_TRACE_ROOT")

if _out and _root:
    class _EccodeTraceFinder:
        """Delegates resolution to the other finders and logs in-project origins."""

        def find_spec(self, fullname, path=None, target=None):
            for finder in sys.meta_path:
                if finder is self or not hasattr(finder, "find_spec"):
                    continue
                try:
                    spec = finder.find_spec(fullname, path, target)
                except Exception:
                    spec = None
                if spec is None:
                    continue
                origin = getattr(spec, "origin", None)
                if isinstance(origin, str) and origin.startswith(_root):
                    try:
                        rel = os.path.relpath(origin, _root).replace(os.sep, "/")
                        with open(_out, "a") as f:
                            f.write(json.dumps({"to": rel}) + "\n")
                    except OSError:
                        pass  # tracing must never break the traced program
                return spec
            return None

    sys.meta_path.insert(0, _EccodeTraceFinder())
