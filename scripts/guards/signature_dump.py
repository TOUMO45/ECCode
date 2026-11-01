#!/usr/bin/env python3
"""Print the top-level function and method signatures of Python files as JSON (ECCode API compatibility guard).

  python signature_dump.py <file.py> [<file.py> ...]

Pure `ast`: no import of the project. Output: {"<file>::<qualname>": {"params": [{"name", "kind", "default": bool, "annotation": str|null}], "returns": str|null}}.
Names starting with an underscore are private and left out.
"""
import ast
import json
import sys


def sig(fn):
    a = fn.args
    params = []
    pos = a.posonlyargs + a.args
    defaults = [None] * (len(pos) - len(a.defaults)) + list(a.defaults)
    for p, d in zip(pos, defaults):
        params.append({"name": p.arg, "kind": "positional", "default": d is not None, "annotation": ast.unparse(p.annotation) if p.annotation else None})
    if a.vararg:
        params.append({"name": "*" + a.vararg.arg, "kind": "var", "default": False, "annotation": None})
    for p, d in zip(a.kwonlyargs, a.kw_defaults):
        params.append({"name": p.arg, "kind": "keyword", "default": d is not None, "annotation": ast.unparse(p.annotation) if p.annotation else None})
    if a.kwarg:
        params.append({"name": "**" + a.kwarg.arg, "kind": "var", "default": False, "annotation": None})
    return {"params": params, "returns": ast.unparse(fn.returns) if fn.returns else None}


def main(argv):
    out = {}
    for file in argv:
        try:
            with open(file, encoding="utf-8") as f:
                tree = ast.parse(f.read())
        except Exception as e:  # noqa: BLE001
            out[file + "::<parse-error>"] = {"error": str(e)[:200]}
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
                out["%s::%s" % (file, node.name)] = sig(node)
            elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
                for sub in node.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and not sub.name.startswith("_"):
                        out["%s::%s.%s" % (file, node.name, sub.name)] = sig(sub)
    json.dump(out, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
