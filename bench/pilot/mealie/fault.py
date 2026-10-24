"""Rewrite a Python module so every function and method raises when called.

The pilot's behavioural fault (A2): reading stdin, writing stdout. Every def
and async def gets `raise RuntimeError("eccode-pilot fault")` as its first
statement, so a registered handler (a FastAPI route, a callback) raises too,
not only the module attribute. The module itself still imports, unless its
own top-level code calls one of its functions.
"""
import ast
import sys

RAISE = 'raise RuntimeError("eccode-pilot fault")'


class Fault(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        self.generic_visit(node)
        node.body = [ast.parse(RAISE).body[0], *node.body]
        return node

    visit_AsyncFunctionDef = visit_FunctionDef


tree = Fault().visit(ast.parse(sys.stdin.read()))
ast.fix_missing_locations(tree)
sys.stdout.write(ast.unparse(tree) + "\n")
