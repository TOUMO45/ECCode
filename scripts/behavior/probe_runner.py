#!/usr/bin/env python3
"""Probe runner for ECCode's behavior diff (eccode behavior diff).

Runs inside ONE tree (the baseline or the candidate worktree), with the
project's interpreter. Two commands:

  generate --config <behavior.json> --routes <routes.json> --functions <functions.json> [--files <files.json>] --out <corpus.json>
      Builds the probe corpus from this tree: HTTP probes from the FastAPI
      app's OpenAPI schema for the impacted routes (one per configured role,
      with example inputs), and function probes for the impacted functions
      with Hypothesis (fixed seed, bounded, JSON-able inputs only). An
      operation is impacted when its full path matches a route found by
      pattern, or when the running app's endpoint for it is defined in one of
      the impacted source files (--files): the endpoint-source join, which sees
      routes behind APIRouter prefixes, bound-method endpoints and decorated
      endpoints that a pattern on the decorator cannot. A configuration may
      list "exampleIds", ids that exist in the application after its setup:
      an operation with uuid inputs then gets one variant per id (at most 8).
  run --config <behavior.json> --corpus <corpus.json> --out <results.json>
      Replays the corpus in this tree and writes every probe's raw output.

Isolation: the network is closed for the process (socket connections to
anything but loopback raise), the database and temp paths come from the
engine through {tmp} placeholders in the configured env, and nothing is
written into the tree. Zero dependencies beyond the project's own (fastapi,
httpx for the TestClient, hypothesis for function probes); a missing one is
reported in the output, never silently skipped.
"""
import importlib
import inspect
import json
import os
import re
import socket
import sys
import traceback

JSONABLE = (str, int, float, bool, type(None))


def close_network():
    real_connect = socket.socket.connect

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError("eccode behavior diff: network access is closed during probes (%s)" % host)
        return real_connect(self, address, *a, **k)

    socket.socket.connect = guarded


def load_config(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def import_app(spec):
    module_name, _, attr = spec.partition(":")
    mod = importlib.import_module(module_name)
    return getattr(mod, attr or "app")


def module_for(path):
    rel = os.path.relpath(path, os.getcwd()).replace(os.sep, "/")
    if rel.endswith("/__init__.py"):
        rel = rel[: -len("/__init__.py")]
    elif rel.endswith(".py"):
        rel = rel[:-3]
    if rel.startswith("src/"):
        rel = rel[4:]
    return rel.replace("/", ".")


def jsonable(value, depth=0):
    if isinstance(value, JSONABLE):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return repr(value)
        return value
    if depth > 6:
        return repr(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
        if isinstance(value, (set, frozenset)):
            items = sorted(items, key=repr)
        return [jsonable(v, depth + 1) for v in items]
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump(), depth + 1)
    if hasattr(value, "__dict__") and not inspect.isroutine(value):
        return {"__class__": type(value).__name__, **jsonable(vars(value), depth + 1)}
    return repr(value)


# ------------------------------------------------------------- generate

MAX_SCHEMA_DEPTH = 8
UUID_FORMATS = ("uuid", "uuid1", "uuid3", "uuid4", "uuid5")
MAX_ID_VARIANTS = 8
CONFIRM_TOKENS = ("confirmation", "confirm")


def has_uuid(schema, components, depth=0):
    """True when a schema, at any depth up to 4, declares a uuid-format string."""
    if not isinstance(schema, dict) or depth > 4:
        return False
    if "$ref" in schema:
        return has_uuid(components.get(schema["$ref"].split("/")[-1], {}), components, depth + 1)
    if schema.get("format") in UUID_FORMATS:
        return True
    for key in ("anyOf", "oneOf", "allOf"):
        if any(has_uuid(o, components, depth + 1) for o in (schema.get(key) or [])):
            return True
    if has_uuid(schema.get("items"), components, depth + 1):
        return True
    return any(has_uuid(sub, components, depth + 1) for sub in (schema.get("properties") or {}).values())


def confirm_base(name):
    """For a confirmation field (passwordConfirm, confirm_password ...) the normalized name of the field it confirms."""
    n = re.sub(r"[_\-\s]", "", name).lower()
    for token in CONFIRM_TOKENS:
        if n.startswith(token) and len(n) > len(token):
            return n[len(token):]
        if n.endswith(token) and len(n) > len(token):
            return n[: -len(token)]
    return None


def uuid_example(variant, ctx):
    """An id from the configuration's exampleIds when there are any (the first uuid field of an operation takes ids[variant], the next one ids[variant + 1] ...), else a valid synthetic uuid."""
    if ctx and ctx.get("ids"):
        ids = ctx["ids"]
        value = ids[(variant + ctx["n"]) % len(ids)]
        ctx["n"] += 1
        return value
    return "00000000-0000-4000-8000-%012d" % variant


STRINGS = ["alpha", "  Beta value  ", "Zed zed", "a-1", "x" * 40]


def example_for_schema(schema, variant, components, depth=0, ctx=None):
    """A deterministic example for a JSON schema (OpenAPI parameters and bodies).

    A schema that refers to itself (a tree, nested categories) is cut at MAX_SCHEMA_DEPTH with null:
    an unbounded example is never built.
    """
    if not isinstance(schema, dict) or depth > MAX_SCHEMA_DEPTH:
        return None
    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        return example_for_schema(components.get(name, {}), variant, components, depth + 1, ctx)
    if "example" in schema:
        return schema["example"]
    if "default" in schema and variant == 0:
        return schema["default"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][variant % len(schema["enum"])]
    for key in ("anyOf", "oneOf"):
        if key in schema and schema[key]:
            options = [o for o in schema[key] if o.get("type") != "null"] or schema[key]
            return example_for_schema(options[variant % len(options)], variant, components, depth + 1, ctx)
    t = schema.get("type")
    if isinstance(t, list):
        t = [x for x in t if x != "null"][0] if [x for x in t if x != "null"] else "null"
    if t == "integer":
        lo = schema.get("minimum", schema.get("exclusiveMinimum", -1) + 1 if "exclusiveMinimum" in schema else 0)
        hi = schema.get("maximum", lo + 50)
        return min(hi, max(lo, [1, 0, 2, 50, 7][variant % 5] if lo <= 0 else lo + [1, 0, 2, 50, 7][variant % 5]))
    if t == "number":
        return [1.5, 0.0, 2.25, 99.99, 0.1][variant % 5]
    if t == "boolean":
        return variant % 2 == 0
    if t == "string":
        fmt = schema.get("format")
        if fmt in UUID_FORMATS:
            return uuid_example(variant, ctx)
        if fmt == "date-time":
            return "2026-01-0%dT00:00:00Z" % (1 + variant % 9)
        if fmt == "date":
            return "2026-01-0%d" % (1 + variant % 9)
        if fmt == "time":
            return "%02d:30:00" % ((12 + 3 * variant) % 24)
        if fmt == "email":
            return ("Probe%d@Example.TEST" if variant % 3 == 2 else "probe%d@example.test") % variant
        if fmt in ("uri", "url", "uri-reference"):
            return "https://example.test/%d" % variant
        if fmt == "ipv4":
            return "192.0.2.%d" % (1 + variant % 250)
        if fmt == "ipv6":
            return "2001:db8::%x" % (1 + variant % 15)
        if fmt == "hostname":
            return "host%d.example.test" % variant
        if fmt == "duration":
            return "PT%dH" % (1 + variant % 9)
        value = STRINGS[variant % 5][: schema.get("maxLength", 40)] or "a"
        minimum = schema.get("minLength", 0)
        if len(value) < minimum:
            value = value + "x" * (minimum - len(value))
        return value
    if t == "array":
        return [example_for_schema(schema.get("items", {}), variant + i, components, depth + 1, ctx) for i in range(min(2, variant + 1))]
    if t == "object" or "properties" in schema:
        out = {}
        required = set(schema.get("required", []))
        for name, sub in (schema.get("properties") or {}).items():
            if name in required or variant % 2 == 0:
                out[name] = example_for_schema(sub, variant, components, depth + 1, ctx)
        # A confirmation field repeats the field it confirms.
        normalized = {re.sub(r"[_\-\s]", "", n).lower(): n for n in out}
        for name in list(out):
            base = confirm_base(name)
            if base and base in normalized and normalized[base] != name:
                out[name] = out[normalized[base]]
        return out
    return None


def source_files_of(endpoint):
    """Source files (relative to the working tree) of an endpoint and of everything it wraps or binds."""
    cwd = os.path.realpath(os.getcwd())
    found = set()
    seen = []
    stack = [endpoint]
    while stack:
        fn = stack.pop()
        if fn is None or any(fn is other for other in seen):
            continue
        seen.append(fn)
        stack.extend([getattr(fn, "__wrapped__", None), getattr(fn, "__func__", None), getattr(fn, "func", None)])
        code = getattr(fn, "__code__", None)
        if code is None and not inspect.isroutine(fn) and not inspect.isclass(fn):
            stack.append(getattr(type(fn), "__call__", None))
        if code is not None:
            try:
                rel = os.path.relpath(os.path.realpath(code.co_filename), cwd).replace(os.sep, "/")
            except ValueError:
                continue
            if not rel.startswith(".."):
                found.add(rel)
    return found


def api_routes(app, errors):
    """The app's effective API routes: full path, methods and endpoint.

    Newer FastAPI keeps include_router lazy (app.routes holds an included-router object, not the routes),
    so the routes are walked the way FastAPI's own OpenAPI generation walks them; older versions flatten
    them into app.routes, which is read directly.
    """
    try:
        from fastapi import routing
        walk = getattr(routing, "iter_route_contexts", None)
        if walk is not None:
            return [c for c in walk(app.routes) if isinstance(getattr(c, "original_route", None), routing.APIRoute)]
    except Exception as e:  # noqa: BLE001
        errors.append("could not walk the app's included routers (%s); reading app.routes as it is" % e)
    return [r for r in (getattr(app, "routes", None) or []) if getattr(r, "methods", None) and getattr(r, "endpoint", None) is not None]


def endpoint_table(app, errors):
    """{(METHOD, path): source files} for the app's API routes, paths spelled as OpenAPI spells them."""
    table = {}
    for route in api_routes(app, errors):
        methods = getattr(route, "methods", None)
        endpoint = getattr(route, "endpoint", None)
        path = getattr(route, "path_format", None) or getattr(route, "path", None)
        if not methods or not path or endpoint is None:
            continue
        found = source_files_of(endpoint)
        for method in methods:
            table.setdefault((method.upper(), path), set()).update(found)
    return table


def generate_http(config, routes, errors, files=None, blanket_ok=True):
    probes = []
    app_spec = config.get("app")
    if not app_spec:
        errors.append("no app configured: .eccode/behavior.json needs \"app\": \"<module>:<attr>\" for HTTP probes")
        return probes
    try:
        app = import_app(app_spec)
        schema = app.openapi()
    except Exception as e:  # noqa: BLE001
        errors.append("could not import the app %s: %s" % (app_spec, e))
        return probes
    components = (schema.get("components") or {}).get("schemas") or {}
    roles = config.get("roles") or [{"name": "default", "headers": {}}]
    example_ids = [str(i) for i in (config.get("exampleIds") or [])][:MAX_ID_VARIANTS]
    wanted = {(r["method"].upper(), r["path"]) for r in routes}
    joined = set()
    if files:
        try:
            impacted = set(files)
            joined = {key for key, sources in endpoint_table(app, errors).items() if sources & impacted}
        except Exception as e:  # noqa: BLE001
            errors.append("could not map the app's routes to their source files: %s" % e)
    # v1 probed every operation when nothing was named and no function was impacted; that fallback stays
    # unless the join found the impacted operations, which are then the only ones.
    restrict = bool(wanted) or bool(joined) or not blanket_ok
    matched = set()
    for path, methods in (schema.get("paths") or {}).items():
        for method, op in methods.items():
            m = method.upper()
            by_file = (m, path) in joined
            named = (m, path) in wanted or ("ANY", path) in wanted
            if named:
                matched.add((m, path) if (m, path) in wanted else ("ANY", path))
            if m not in ("GET", "POST", "PUT", "PATCH", "DELETE") or (restrict and not named and not by_file):
                continue
            params = op.get("parameters") or []
            body_schema = None
            rb = op.get("requestBody") or {}
            for ctype, media in (rb.get("content") or {}).items():
                if "json" in ctype:
                    body_schema = media.get("schema")
            variants = 3 if (params or body_schema) else 1
            if example_ids and (any(has_uuid(p.get("schema") or {}, components) for p in params) or has_uuid(body_schema, components)):
                variants = max(3, len(example_ids))
            for variant in range(variants):
                url = path
                query = {}
                headers = {}
                ctx = {"ids": example_ids, "n": 0}
                try:
                    for p in params:
                        value = example_for_schema(p.get("schema") or {}, variant, components, 0, ctx)
                        if p.get("in") == "path":
                            url = url.replace("{%s}" % p["name"], str(value))
                        elif p.get("in") == "query" and (p.get("required") or variant % 2 == 1):
                            query[p["name"]] = value
                        elif p.get("in") == "header" and p.get("required"):
                            headers[p["name"]] = str(value)
                    body = example_for_schema(body_schema, variant, components, 0, ctx) if body_schema else None
                except Exception as e:  # noqa: BLE001
                    errors.append("skipped %s %s variant %d: could not build an example (%s: %s)" % (m, path, variant, type(e).__name__, str(e)[:120]))
                    continue
                for role in roles:
                    probes.append({
                        "id": "http:%s %s#%d@%s" % (m, path, variant, role["name"]),
                        "surface": "http", "target": "%s %s" % (m, path), "role": role["name"],
                        "input": {"method": m, "url": url, "query": query, "headers": {**headers, **(role.get("headers") or {})}, "json": body},
                        **({"via": "endpoint-file"} if by_file else {}),
                    })
    unmatched = wanted - matched
    if unmatched and joined:
        errors.append("%d route path(s) found by pattern matched no OpenAPI operation (declared behind a router prefix); %d operation(s) were found through the endpoint-source join" % (len(unmatched), len(joined)))
    return probes


def strategy_for(annotation):
    import typing
    from hypothesis import strategies as st
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if annotation is int:
        return st.integers(min_value=-1000, max_value=1000)
    if annotation is float:
        return st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False)
    if annotation is str:
        return st.text(max_size=20)
    if annotation is bool:
        return st.booleans()
    if annotation is type(None):
        return st.none()
    if origin in (list, typing.List) and args:
        inner = strategy_for(args[0])
        return st.lists(inner, max_size=6) if inner is not None else None
    if origin in (dict, typing.Dict) and len(args) == 2 and args[0] is str:
        inner = strategy_for(args[1])
        return st.dictionaries(st.text(max_size=8), inner, max_size=4) if inner is not None else None
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        parts = [strategy_for(a) for a in args]
        if all(p is not None for p in parts):
            return st.one_of(*parts)
    return None


def generate_functions(config, functions, errors):
    probes = []
    if not functions:
        return probes
    try:
        from hypothesis import given, settings, HealthCheck, Phase
    except Exception as e:  # noqa: BLE001
        errors.append("hypothesis is not importable (%s): function probes need it" % e)
        return probes
    examples = int(config.get("functionExamples") or 25)
    for spec in functions:
        file, _, name = spec.partition("::")
        try:
            mod = importlib.import_module(module_for(file))
            fn = getattr(mod, name)
            sig = inspect.signature(fn)
        except Exception as e:  # noqa: BLE001
            errors.append("skipped %s: %s" % (spec, e))
            continue
        strategies = {}
        skip = None
        for pname, p in sig.parameters.items():
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                skip = "*args/**kwargs"
                break
            if p.annotation is inspect.Parameter.empty:
                skip = "parameter %s has no type annotation" % pname
                break
            s = strategy_for(p.annotation)
            if s is None:
                skip = "parameter %s: %r is not a JSON-able annotation" % (pname, p.annotation)
                break
            strategies[pname] = s
        if skip:
            errors.append("skipped %s: %s" % (spec, skip))
            continue
        collected = []

        @settings(max_examples=examples, derandomize=True, database=None, deadline=None, phases=[Phase.generate], suppress_health_check=list(HealthCheck))
        @given(**strategies)
        def collect(**kwargs):
            collected.append(kwargs)

        try:
            collect()
        except Exception as e:  # noqa: BLE001
            errors.append("hypothesis failed on %s: %s" % (spec, e))
        seen = set()
        for i, kwargs in enumerate(collected):
            key = json.dumps(kwargs, sort_keys=True, default=repr)
            if key in seen:
                continue
            seen.add(key)
            probes.append({"id": "fn:%s#%d" % (spec, i), "surface": "function", "target": spec, "input": {"kwargs": jsonable(kwargs)}})
    return probes


# Probes run in this order on every side: reads first, then creations and
# updates, deletions last, so a destructive probe shapes as few later probes
# as possible (state carries within a side, identically on both sides).
METHOD_ORDER = {"GET": 0, "HEAD": 0, "OPTIONS": 0, "POST": 1, "PUT": 2, "PATCH": 3, "DELETE": 4}


def ordered(probes):
    return sorted(probes, key=lambda p: (0 if p["surface"] == "function" else 1, METHOD_ORDER.get((p.get("input") or {}).get("method", ""), 5), p["id"]))


def generate(args):
    config = load_config(args.get("--config"))
    routes = json.load(open(args["--routes"], encoding="utf-8")) if args.get("--routes") and os.path.exists(args["--routes"]) else []
    functions = json.load(open(args["--functions"], encoding="utf-8")) if args.get("--functions") and os.path.exists(args["--functions"]) else []
    files = json.load(open(args["--files"], encoding="utf-8")) if args.get("--files") and os.path.exists(args["--files"]) else []
    errors = []
    probes = []
    if routes or files or not functions:
        probes += generate_http(config, routes, errors, files, blanket_ok=not routes and not functions)
    probes += generate_functions(config, functions, errors)
    probes = ordered(probes)
    with open(args["--out"], "w", encoding="utf-8") as f:
        json.dump({"probes": probes, "errors": errors, "routes": routes, "functions": functions}, f, sort_keys=True)
    sys.stdout.write("generated %d probe(s); %d note(s)\n" % (len(probes), len(errors)))
    for e in errors:
        sys.stdout.write("  note: %s\n" % e)
    return 0


# ------------------------------------------------------------------ run

def run_http(config, probes, results, errors):
    if not probes:
        return
    app_spec = config.get("app")
    try:
        from fastapi.testclient import TestClient
        app = import_app(app_spec)
        client = TestClient(app, raise_server_exceptions=False)
    except Exception as e:  # noqa: BLE001
        errors.append("could not start the app %s: %s" % (app_spec, e))
        for p in probes:
            results[p["id"]] = {"error": "app unavailable"}
        return
    with client:
        for p in probes:
            i = p["input"]
            try:
                r = client.request(i["method"], i["url"], params=i.get("query") or None, headers=i.get("headers") or None, json=i.get("json"))
                ctype = r.headers.get("content-type", "")
                try:
                    body = r.json() if "json" in ctype else r.text
                except Exception:  # noqa: BLE001
                    body = r.text
                results[p["id"]] = {"status": r.status_code, "contentType": ctype.split(";")[0], "body": body}
            except Exception as e:  # noqa: BLE001
                results[p["id"]] = {"exception": type(e).__name__, "message": str(e)[:200]}


def run_functions(probes, results, errors):
    cache = {}
    for p in probes:
        file, _, name = p["target"].partition("::")
        try:
            if file not in cache:
                cache[file] = importlib.import_module(module_for(file))
            fn = getattr(cache[file], name)
        except Exception as e:  # noqa: BLE001
            results[p["id"]] = {"exception": "ImportError", "message": str(e)[:200]}
            continue
        try:
            results[p["id"]] = {"returned": jsonable(fn(**p["input"]["kwargs"]))}
        except Exception as e:  # noqa: BLE001
            results[p["id"]] = {"exception": type(e).__name__}


def run(args):
    config = load_config(args.get("--config"))
    with open(args["--corpus"], encoding="utf-8") as f:
        corpus = json.load(f)
    errors = []
    results = {}
    probes = corpus.get("probes") or []
    run_http(config, [p for p in probes if p["surface"] == "http"], results, errors)
    run_functions([p for p in probes if p["surface"] == "function"], results, errors)
    with open(args["--out"], "w", encoding="utf-8") as f:
        json.dump({"results": results, "errors": errors, "executed": len(results)}, f, sort_keys=True, default=repr)
    sys.stdout.write("executed %d probe(s); %d note(s)\n" % (len(results), len(errors)))
    for e in errors:
        sys.stdout.write("  note: %s\n" % e)
    return 0


def main(argv):
    if not argv or argv[0] not in ("generate", "run"):
        sys.stderr.write(__doc__)
        return 2
    args = {}
    i = 1
    while i < len(argv):
        args[argv[i]] = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
    sys.path.insert(0, os.getcwd())
    close_network()
    try:
        return generate(args) if argv[0] == "generate" else run(args)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
