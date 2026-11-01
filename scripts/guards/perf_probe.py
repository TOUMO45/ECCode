#!/usr/bin/env python3
"""Micro-benchmark of HTTP probes against the FastAPI app of ONE worktree (ECCode performance guard).

  python perf_probe.py --app <module:attr> --probes <probes.json> --out <result.json> [--warmup 3] [--repetitions 15]

probes.json: [{"name", "method", "path", "query"?, "json"?, "headers"?}]. Each probe
runs `warmup` times untimed, then `repetitions` times timed (perf_counter);
the median and interquartile range in milliseconds are reported, plus the
number of SQL statements the LAST request executed (SQLAlchemy's
before_cursor_execute event on every engine, when sqlalchemy is importable).
The network is closed as in the behavior diff's probe runner.
"""
import importlib
import json
import os
import socket
import statistics
import sys
import time


def close_network():
    real_connect = socket.socket.connect

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError("eccode guard: network access is closed (%s)" % host)
        return real_connect(self, address, *a, **k)

    socket.socket.connect = guarded


def install_query_counter():
    counter = {"n": 0}
    try:
        from sqlalchemy import event
        from sqlalchemy.engine import Engine

        @event.listens_for(Engine, "before_cursor_execute")
        def _count(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
            counter["n"] += 1

        counter["available"] = True
    except Exception:  # noqa: BLE001
        counter["available"] = False
    return counter


def main(argv):
    args = {}
    i = 0
    while i < len(argv):
        args[argv[i]] = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
    sys.path.insert(0, os.getcwd())
    close_network()
    warmup = int(args.get("--warmup") or 3)
    reps = int(args.get("--repetitions") or 15)
    with open(args["--probes"], encoding="utf-8") as f:
        probes = json.load(f)
    errors = []
    results = []
    counter = install_query_counter()
    from fastapi.testclient import TestClient

    module_name, _, attr = args["--app"].partition(":")
    app = getattr(importlib.import_module(module_name), attr or "app")
    client = TestClient(app, raise_server_exceptions=False)
    with client:
        for p in probes:
            def call():
                return client.request(p.get("method", "GET"), p["path"], params=p.get("query") or None, headers=p.get("headers") or None, json=p.get("json"))
            try:
                for _ in range(warmup):
                    call()
                times = []
                status = None
                for _ in range(reps):
                    t0 = time.perf_counter()
                    r = call()
                    times.append((time.perf_counter() - t0) * 1000.0)
                    status = r.status_code
                counter["n"] = 0
                call()
                queries = counter["n"] if counter.get("available") else None
                times.sort()
                q1 = times[len(times) // 4]
                q3 = times[(3 * len(times)) // 4]
                results.append({"name": p["name"], "status": status, "median_ms": round(statistics.median(times), 3), "iqr_ms": round(q3 - q1, 3), "min_ms": round(times[0], 3), "queries": queries, "repetitions": reps})
            except Exception as e:  # noqa: BLE001
                errors.append("%s: %s: %s" % (p.get("name"), type(e).__name__, str(e)[:200]))
    with open(args["--out"], "w", encoding="utf-8") as f:
        json.dump({"probes": results, "errors": errors, "queryCounting": bool(counter.get("available"))}, f, sort_keys=True)
    sys.stdout.write("perf: %d probe(s), %d error(s)\n" % (len(results), len(errors)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
