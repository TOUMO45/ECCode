#!/usr/bin/env python3
"""Race probe against the FastAPI app of ONE worktree (ECCode concurrency guard).

  python race_probe.py --app <module:attr> --operations <ops.json> --database <sqlalchemy url | sqlite path> --out <result.json>

ops.json: [{"name", "concurrency": 8, "repeat": 4, "setup"?: {"method","path","json","headers"},
            "request": {"method","path","json","headers"},
            "invariants": [{"name", "kind": "conserved" | "equals" | "max", "query": "SELECT ...", "expect"?: number}]}]
For each operation: the setup request runs once, every invariant query is
evaluated (before), `concurrency` threads each send the request `repeat`
times at once (one TestClient per thread), and the queries are evaluated
again (after). conserved: before == after; equals: after == expect;
max: after <= expect. Statuses are counted. The network is closed.
"""
import importlib
import json
import os
import socket
import sys
import threading
from concurrent.futures import ThreadPoolExecutor


def close_network():
    real_connect = socket.socket.connect

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError("eccode guard: network access is closed (%s)" % host)
        return real_connect(self, address, *a, **k)

    socket.socket.connect = guarded


def main(argv):
    args = {}
    i = 0
    while i < len(argv):
        args[argv[i]] = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
    sys.path.insert(0, os.getcwd())
    close_network()
    with open(args["--operations"], encoding="utf-8") as f:
        operations = json.load(f)
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, text

    module_name, _, attr = args["--app"].partition(":")
    app = getattr(importlib.import_module(module_name), attr or "app")
    db = args["--database"]
    engine = create_engine(db if "://" in db else "sqlite:///" + db)

    def value(query):
        with engine.connect() as conn:
            row = conn.execute(text(query)).fetchone()
            v = row[0] if row else None
            return float(v) if isinstance(v, (int, float)) else v

    out = []
    errors = []
    with TestClient(app, raise_server_exceptions=False) as main_client:
        for op in operations:
            try:
                if op.get("setup"):
                    s = op["setup"]
                    main_client.request(s.get("method", "POST"), s["path"], json=s.get("json"), headers=s.get("headers") or None)
                before = {inv["name"]: value(inv["query"]) for inv in op.get("invariants", [])}
                req = op["request"]
                statuses = {}
                lock = threading.Lock()
                barrier = threading.Barrier(int(op.get("concurrency", 8)))

                def worker():
                    with TestClient(app, raise_server_exceptions=False) as c:
                        barrier.wait(timeout=30)
                        for _ in range(int(op.get("repeat", 1))):
                            r = c.request(req.get("method", "POST"), req["path"], json=req.get("json"), headers=req.get("headers") or None)
                            with lock:
                                statuses[str(r.status_code)] = statuses.get(str(r.status_code), 0) + 1

                with ThreadPoolExecutor(max_workers=int(op.get("concurrency", 8))) as pool:
                    list(pool.map(lambda _: worker(), range(int(op.get("concurrency", 8)))))
                after = {inv["name"]: value(inv["query"]) for inv in op.get("invariants", [])}
                invariants = []
                for inv in op.get("invariants", []):
                    b = before[inv["name"]]
                    a = after[inv["name"]]
                    kind = inv.get("kind", "conserved")
                    if kind == "conserved":
                        held = a == b
                    elif kind == "equals":
                        held = a == inv.get("expect")
                    elif kind == "max":
                        held = a is not None and a <= inv.get("expect", 0)
                    else:
                        held = False
                    invariants.append({"name": inv["name"], "kind": kind, "before": b, "after": a, "expect": inv.get("expect"), "held": bool(held)})
                out.append({"name": op["name"], "statuses": statuses, "invariants": invariants, "held": all(x["held"] for x in invariants)})
            except Exception as e:  # noqa: BLE001
                errors.append("%s: %s: %s" % (op.get("name"), type(e).__name__, str(e)[:200]))
    with open(args["--out"], "w", encoding="utf-8") as f:
        json.dump({"operations": out, "errors": errors}, f, sort_keys=True)
    sys.stdout.write("race: %d operation(s), %d error(s)\n" % (len(out), len(errors)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
