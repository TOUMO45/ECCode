"""The refactor item's target check (ours): the duplicated bodies are gone.

usage: python dup_check.py <root> <hash> [<hash> ...]
       python dup_check.py <root> --hash <file.py> <function>   (print one body's hash)
       python dup_check.py <root> --scan                       (every body two or more functions share, largest first)

A function body is normalized (docstring dropped, every name and argument
renamed, annotations dropped) and hashed. The check passes when each given
hash belongs to at most one function under <root>/mealie: the logic that two
classes duplicated now lives in one place. The hashes were taken from the
duplicated methods at the item's base commit, so no source is stored here.
"""
import ast
import copy
import hashlib
import os
import sys


class Normalize(ast.NodeTransformer):
    def visit_Name(self, node):
        return ast.copy_location(ast.Name(id="_", ctx=node.ctx), node)

    def visit_arg(self, node):
        node.arg = "_"
        node.annotation = None
        return node


def body_hash(fn):
    body = fn.body
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
        body = body[1:]
    tree = Normalize().visit(ast.Module(body=copy.deepcopy(body), type_ignores=[]))
    return hashlib.sha256(ast.dump(tree, annotate_fields=False).encode()).hexdigest()[:16]


def functions(root):
    for dirpath, _, files in os.walk(os.path.join(root, "mealie")):
        for name in files:
            if name.endswith(".py"):
                path = os.path.join(dirpath, name)
                try:
                    tree = ast.parse(open(path, encoding="utf-8").read())
                except SyntaxError:
                    continue
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        yield os.path.relpath(path, root), node


def scan(root):
    """Bodies shared by functions of two or more classes, largest first: how the refactor items are chosen."""
    by_hash = {}
    for rel, fn in functions(root):
        lines = fn.end_lineno - fn.lineno + 1
        by_hash.setdefault(body_hash(fn), []).append((rel.replace(os.sep, "/"), fn.name, lines))
    shared = [(h, where) for h, where in by_hash.items() if len(where) > 1 and len({w[0] for w in where}) > 1]
    for h, where in sorted(shared, key=lambda x: (-max(w[2] for w in x[1]), x[0])):
        print(f"{h} {max(w[2] for w in where)} lines: {'; '.join(f'{w[0]} {w[1]}' for w in where)}")
    return 0


def main(argv):
    root = argv[1]
    if argv[2] == "--scan":
        return scan(root)
    if argv[2] == "--hash":
        target, fname = argv[3], argv[4]
        for rel, fn in functions(root):
            if rel.replace(os.sep, "/") == target and fn.name == fname:
                print(body_hash(fn))
        return 0
    counts = {h: [] for h in argv[2:]}
    for rel, fn in functions(root):
        h = body_hash(fn)
        if h in counts:
            counts[h].append(f"{rel}:{fn.lineno} {fn.name}")
    failed = {h: where for h, where in counts.items() if len(where) > 1}
    for h, where in counts.items():
        print(f"{h}: {len(where)} ({', '.join(where) or 'none'})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
