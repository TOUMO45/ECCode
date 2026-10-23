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
            if fn.startswith(_root) and fn != origin and not fn.endswith("sitecustomize.py"):
                return os.path.relpath(fn, _root).replace(os.sep, "/")
            frame = frame.f_back
        return None

    sys.meta_path.insert(0, _EccodeTraceFinder())
