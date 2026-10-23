# Runtime import tracer (Python). Put on PYTHONPATH by `eccode impact --trace`:
# a sys.meta_path finder records every in-project module file the traced
# command loads - importlib/__import__ included - to ECCODE_TRACE_FILE, with
# the importing file found by walking the call stack to the nearest project
# frame outside the import machinery (a from->to edge, as in Node).
import json
import os
import sys

_out = os.environ.get("ECCODE_TRACE_FILE")
_root = os.environ.get("ECCODE_TRACE_ROOT")
_roots = [r for r in (_root, os.environ.get("ECCODE_TRACE_ROOT_ALT")) if r]
_win = os.name == "nt"


def _rel(p):
    """Project-relative path for either spelling of the root (8.3 short or long
    on Windows, compared case-insensitively there); None outside the project."""
    for r in _roots:
        if (p.lower() if _win else p).startswith(r.lower() if _win else r):
            return p[len(r):].replace(os.sep, "/")
    return None

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
                rel = _rel(origin) if isinstance(origin, str) else None
                if rel:
                    try:
                        rec = {"to": rel}
                        importer = _importer(origin)
                        if importer:
                            rec["from"] = importer
                        with open(_out, "a") as f:
                            f.write(json.dumps(rec) + "\n")
                    except OSError:
                        pass  # tracing must never break the traced program
                return spec
            return None

    def _importer(origin):
        """Nearest in-project file on the call stack that is not the module itself."""
        try:
            frame = sys._getframe(2)
        except ValueError:
            return None
        while frame is not None:
            fn = frame.f_code.co_filename
            rel = _rel(fn)
            if rel and fn != origin and not fn.endswith("sitecustomize.py"):
                return rel
            frame = frame.f_back
        return None

    sys.meta_path.insert(0, _EccodeTraceFinder())
