#!/usr/bin/env python3
"""Print the OpenAPI schema of a FastAPI app as JSON (ECCode API compatibility guard).

  python openapi_dump.py <module:attr>

Runs inside one worktree with the project's interpreter; the network is closed
as in the behavior diff's probe runner. Nothing is written into the tree.
"""
import importlib
import json
import os
import socket
import sys


def close_network():
    real_connect = socket.socket.connect

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError("eccode guard: network access is closed (%s)" % host)
        return real_connect(self, address, *a, **k)

    socket.socket.connect = guarded


def main(argv):
    if len(argv) != 1:
        sys.stderr.write(__doc__)
        return 2
    sys.path.insert(0, os.getcwd())
    close_network()
    module_name, _, attr = argv[0].partition(":")
    app = getattr(importlib.import_module(module_name), attr or "app")
    json.dump(app.openapi(), sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
