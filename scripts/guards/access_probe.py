#!/usr/bin/env python3
"""Access-control probe against the FastAPI app of ONE worktree (ECCode security guard).

  python access_probe.py <matrix|idor|authflow|input> --app <module:attr> --config <runspec.json> --out <result.json> [--endpoints <reached.json>]

This is the standard access-control test battery a CI suite runs against the
project's OWN app: an access matrix (role x endpoint x ownership), IDOR/BOLA
probes, auth-flow checks and targeted input probes. Every request goes to the
app under test through FastAPI's TestClient; the network is closed exactly as
in the behavior diff's probe_runner, so nothing can reach a third party.

The runspec (written by lib/security.js) carries the resolved roles (name,
headers, level), the object definitions, the matrix cells to probe, the auth
flows and the input probes. Each subcommand writes the JSON the Node side
expects: raw request/response evidence; the Node side overlays the declared
policy, counts failures and records the content-hashed artifact.

Dependency-free beyond fastapi/httpx (the TestClient) and the app's own deps.
"""
import importlib
import json
import os
import socket
import sys
import traceback

JSONABLE = (str, int, float, bool, type(None))


def close_network():
    real_connect = socket.socket.connect

    def guarded(self, address, *a, **k):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise OSError("eccode security guard: network access is closed during probes (%s)" % host)
        return real_connect(self, address, *a, **k)

    socket.socket.connect = guarded


def load_json(path, default=None):
    if not path or not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def import_app(spec):
    module_name, _, attr = spec.partition(":")
    mod = importlib.import_module(module_name)
    return getattr(mod, attr or "app")


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
        return [jsonable(v, depth + 1) for v in list(value)]
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump(), depth + 1)
    return repr(value)


# ----------------------------------------------- OpenAPI example inputs

def example_for_schema(schema, variant, components):
    """A deterministic example for a JSON schema (copied from the behavior probe runner)."""
    if not isinstance(schema, dict):
        return None
    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        return example_for_schema(components.get(name, {}), variant, components)
    if "example" in schema:
        return schema["example"]
    if "default" in schema and variant == 0:
        return schema["default"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][variant % len(schema["enum"])]
    for key in ("anyOf", "oneOf"):
        if key in schema and schema[key]:
            options = [o for o in schema[key] if o.get("type") != "null"] or schema[key]
            return example_for_schema(options[variant % len(options)], variant, components)
    t = schema.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        t = non_null[0] if non_null else "null"
    if t == "integer":
        lo = schema.get("minimum", 0)
        hi = schema.get("maximum", lo + 50)
        return min(hi, max(lo, [1, 0, 2, 50, 7][variant % 5] if lo <= 0 else lo + [1, 0, 2, 50, 7][variant % 5]))
    if t == "number":
        return [1.5, 0.0, 2.25, 99.99, 0.1][variant % 5]
    if t == "boolean":
        return variant % 2 == 0
    if t == "string":
        fmt = schema.get("format")
        if fmt == "uuid":
            return "00000000-0000-4000-8000-%012d" % variant
        if fmt == "date-time":
            return "2026-01-0%dT00:00:00Z" % (1 + variant % 9)
        if fmt == "date":
            return "2026-01-0%d" % (1 + variant % 9)
        if fmt == "email":
            return "probe%d@example.test" % variant
        return ["alpha", "", "Zed zed", "a-1", "x" * 40][variant % 5][: schema.get("maxLength", 40)] or "a"
    if t == "array":
        return [example_for_schema(schema.get("items", {}), variant, components)]
    if t == "object" or "properties" in schema:
        out = {}
        required = set(schema.get("required", []))
        for name, sub in (schema.get("properties") or {}).items():
            if name in required:
                out[name] = example_for_schema(sub, variant, components)
        return out
    return None


class App:
    """The imported app with its OpenAPI schema, roles and a shared TestClient."""

    def __init__(self, spec, config):
        from fastapi.testclient import TestClient
        self.app = import_app(spec)
        self.config = config
        try:
            self.schema = self.app.openapi()
        except Exception:  # noqa: BLE001
            self.schema = {}
        self.components = (self.schema.get("components") or {}).get("schemas") or {}
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.roles = {r["name"]: r for r in (config.get("roles") or [])}

    def headers_for(self, role_name):
        r = self.roles.get(role_name) or {}
        return r.get("headers") or {}

    def op_for(self, method, path):
        return ((self.schema.get("paths") or {}).get(path) or {}).get(method.lower()) or {}

    def baseline_request(self, method, path, variant=0):
        """Query/body filled from the OpenAPI schema so a request is otherwise valid."""
        op = self.op_for(method, path)
        url = path
        query = {}
        for p in op.get("parameters") or []:
            value = example_for_schema(p.get("schema") or {}, variant, self.components)
            if p.get("in") == "path":
                url = url.replace("{%s}" % p["name"], str(value))
            elif p.get("in") == "query" and p.get("required"):
                query[p["name"]] = value
        body = None
        rb = op.get("requestBody") or {}
        for ctype, media in (rb.get("content") or {}).items():
            if "json" in ctype:
                body = example_for_schema(media.get("schema"), variant, self.components)
        return url, query, body

    def send(self, method, path, headers=None, query=None, json_body=None):
        r = self.client.request(method, path, params=query or None, headers=headers or None, json=json_body)
        ctype = r.headers.get("content-type", "")
        try:
            body = r.json() if "json" in ctype else r.text
        except Exception:  # noqa: BLE001
            body = r.text
        return {"status": r.status_code, "contentType": ctype.split(";")[0], "body": body}


def observed_of(status):
    if 200 <= status < 300:
        return "allow"
    if status in (401, 403, 404, 405):
        return "deny"
    return "other"


def split_endpoint(endpoint):
    parts = endpoint.split(" ", 1)
    if len(parts) == 2:
        return parts[0].upper(), parts[1]
    return "GET", parts[0]


def object_for(endpoint_path, objects):
    """The object whose item endpoint this path addresses (by base-path prefix)."""
    best = None
    for obj in objects:
        base = (obj.get("list") or obj.get("create") or {}).get("path")
        if not base:
            continue
        if endpoint_path == base or endpoint_path.startswith(base.rstrip("/") + "/"):
            if best is None or len(base) > len((best.get("list") or best.get("create") or {}).get("path", "")):
                best = obj
    return best


def substitute_id(path, obj, value):
    param = obj.get("idParam") if obj else None
    token = "{%s}" % param if param else None
    if token and token in path:
        return path.replace(token, str(value))
    # Fall back to the first path parameter.
    import re
    return re.sub(r"\{[^}]+\}", str(value), path, count=1)


def create_objects(app, objects):
    """Create one object per authenticated role; returns {kind: {role_name: id}} and a nonexistent id."""
    owners = {}
    max_id = 0
    errors = []
    for obj in objects:
        kind = obj.get("kind") or "object"
        create = obj.get("create") or {}
        owners[kind] = {}
        for name, role in app.roles.items():
            if (role.get("level") or 0) <= 0:
                continue
            method = (create.get("method") or "POST").upper()
            path = create.get("path")
            if not path:
                continue
            body = create.get("json")
            if body is None:
                _, _, body = app.baseline_request(method, path)
            resp = app.send(method, path, headers=app.headers_for(name), json_body=body)
            if 200 <= resp["status"] < 300 and isinstance(resp["body"], dict):
                oid = resp["body"].get(create.get("idField") or "id")
                if oid is not None:
                    owners[kind][name] = oid
                    try:
                        max_id = max(max_id, int(oid))
                    except (TypeError, ValueError):
                        pass
            else:
                errors.append("create %s as %s: status %s" % (kind, name, resp["status"]))
    return owners, (max_id + 1000000), errors


def resolve_id(ownership, role_name, obj, owners, nonexistent):
    if obj is None:
        return 1
    kind = obj.get("kind") or "object"
    mine = owners.get(kind, {})
    if ownership == "own":
        return mine.get(role_name) if mine.get(role_name) is not None else (next(iter(mine.values())) if mine else 1)
    if ownership == "other":
        for other_name, oid in mine.items():
            if other_name != role_name:
                return oid
        return next(iter(mine.values())) if mine else 1
    return nonexistent  # none


# -------------------------------------------------------------- matrix

def run_matrix(app, config):
    objects = config.get("objects") or []
    cells = config.get("cells") or []
    out = []
    with app.client:
        owners, nonexistent, errors = create_objects(app, objects)
        for cell in cells:
            method, path = split_endpoint(cell["endpoint"])
            obj = object_for(path, objects)
            has_id = "{" in path
            url = path
            if has_id:
                oid = resolve_id(cell["ownership"], cell["role"], obj, owners, nonexistent)
                url = substitute_id(path, obj, oid)
            _, query, body = app.baseline_request(method, url)
            if method in ("POST", "PUT", "PATCH") and obj and (obj.get("create") or {}).get("json") is not None and ((obj.get("create") or {}).get("path") == path):
                body = (obj.get("create") or {}).get("json")
            resp = app.send(method, url, headers=app.headers_for(cell["role"]), query=query, json_body=body)
            out.append({"role": cell["role"], "endpoint": cell["endpoint"], "ownership": cell["ownership"], "status": resp["status"], "observed": observed_of(resp["status"])})
    return {"cells": out, "errors": errors}


# ---------------------------------------------------------------- idor

def run_idor(app, config):
    objects = config.get("objects") or []
    focus = set(config.get("endpoints") or [])
    probes = []
    errors = []
    with app.client:
        owners, nonexistent, errs = create_objects(app, objects)
        errors += errs
        for obj in objects:
            kind = obj.get("kind") or "object"
            item = obj.get("item") or {}
            base = (obj.get("list") or obj.get("create") or {}).get("path", "")
            method = (item.get("method") or "GET").upper()
            item_path = item.get("path") or (base.rstrip("/") + "/{%s}" % (obj.get("idParam") or "id"))
            endpoint = "%s %s" % (method, item_path)
            if focus and endpoint not in focus and item_path not in focus:
                continue
            mine = owners.get(kind, {})
            # Each owner A's objects, fetched by A, then by every non-owner at or below A's level.
            for owner_name, oid in mine.items():
                owner_level = app.roles.get(owner_name, {}).get("level") or 0
                owner_url = substitute_id(item_path, obj, oid)
                owner_resp = app.send(method, owner_url, headers=app.headers_for(owner_name))
                owner_body = owner_resp["body"] if isinstance(owner_resp["body"], dict) else {}
                for other_name, other_role in app.roles.items():
                    if other_name == owner_name:
                        continue
                    other_level = other_role.get("level") or 0
                    if other_level > owner_level:
                        continue  # a higher-privilege role legitimately sees more; not an IDOR probe
                    relationship = ("unauthenticated" if other_level <= 0 else ("peer" if other_level == owner_level else "lower"))
                    resp = app.send(method, owner_url, headers=app.headers_for(other_name))
                    leaked = []
                    if 200 <= resp["status"] < 300 and isinstance(resp["body"], dict):
                        for k, v in resp["body"].items():
                            if k in owner_body and owner_body[k] == v:
                                leaked.append(k)
                    fail = (200 <= resp["status"] < 300)
                    probes.append({
                        "endpoint": endpoint, "kind": kind, "as": other_name, "relationship": relationship,
                        "ownerRole": owner_name, "status": resp["status"], "leaked": leaked, "fail": bool(fail),
                        "request": {"method": method, "path": owner_url, "as": other_name},
                        "response": {"status": resp["status"], "body": resp["body"]},
                        "ownerResponse": {"status": owner_resp["status"], "body": owner_resp["body"]},
                    })
    return {"probes": probes, "errors": errors}


# ------------------------------------------------------------ authflow

def run_authflow(app, config):
    flows = config.get("authFlows") or {}
    checks = []
    errors = []

    def bearer(token):
        return {"Authorization": "Bearer %s" % token}

    with app.client:
        login = flows.get("login")
        if login:
            resp = app.send((login.get("method") or "POST").upper(), login["path"], json_body=login.get("json"))
            token = None
            if isinstance(resp["body"], dict):
                token = resp["body"].get(login.get("tokenField") or "token") or resp["body"].get("access_token")
            verify = flows.get("verify") or login.get("verify")
            if token and verify:
                vm = (verify.get("method") or "GET").upper()
                before = app.send(vm, verify["path"], headers=bearer(token))
                checks.append({"name": "token works before logout", "kind": "session", "passed": 200 <= before["status"] < 300, "detail": "status %s" % before["status"], "request": {"method": vm, "path": verify["path"]}, "response": {"status": before["status"]}})
                logout = flows.get("logout")
                if logout:
                    app.send((logout.get("method") or "POST").upper(), logout["path"], headers=bearer(token))
                    after = app.send(vm, verify["path"], headers=bearer(token))
                    checks.append({"name": "logout invalidates the token", "kind": "session", "passed": after["status"] in (401, 403), "detail": "status %s after logout (expected 401/403)" % after["status"], "request": {"method": vm, "path": verify["path"]}, "response": {"status": after["status"]}})
            elif login:
                errors.append("authflow: login returned no token (field %s)" % (login.get("tokenField") or "token"))

        reset = flows.get("reset")
        if reset and reset.get("request") and reset.get("confirm"):
            req = reset["request"]
            rr = app.send((req.get("method") or "POST").upper(), req["path"], json_body=req.get("json"))
            token = rr["body"].get(req.get("tokenField") or "token") if isinstance(rr["body"], dict) else None
            if token:
                confirm = reset["confirm"]
                tmpl = json.loads(json.dumps(confirm.get("jsonTemplate") or {}).replace("{token}", str(token)))
                first = app.send((confirm.get("method") or "POST").upper(), confirm["path"], json_body=tmpl)
                second = app.send((confirm.get("method") or "POST").upper(), confirm["path"], json_body=tmpl)
                checks.append({"name": "reset token is single-use", "kind": "reset", "passed": (200 <= first["status"] < 300) and (400 <= second["status"] < 500), "detail": "first %s, second %s (expected 2xx then 4xx)" % (first["status"], second["status"]), "response": {"first": first["status"], "second": second["status"]}})
            else:
                errors.append("authflow: reset request returned no token (field %s)" % (req.get("tokenField") or "token"))
    return {"checks": checks, "errors": errors}


# --------------------------------------------------------------- input

PAYLOADS = {
    "sql": "' OR '1'='1' --",
    "path-traversal": "../../../../etc/passwd",
    "ssrf": "http://169.254.169.254/latest/meta-data/",
    "template": "${{7*7}}",
}
SQL_ERROR = ("sql", "syntax error", "sqlite", "operationalerror", "programmingerror", "near \"", "unrecognized token")


def input_flagged(kind, resp):
    status = resp["status"]
    body = resp["body"]
    text = body if isinstance(body, str) else json.dumps(body)
    low = text.lower()
    if kind == "sql":
        if status >= 500 and any(s in low for s in SQL_ERROR):
            return True, "500 with a SQL error in the response (the metacharacter reached the query)"
        return False, "status %s, no SQL error surfaced" % status
    if kind == "path-traversal":
        if "root:" in text or "/bin/" in text:
            return True, "the traversal target's content appears in the response"
        return False, "status %s, traversal target not returned" % status
    if kind == "ssrf":
        if 200 <= status < 300:
            return True, "the app accepted an internal/loopback URL without rejecting it (network stays closed; no fetch made)"
        return False, "status %s, the app rejected the internal URL" % status
    if kind == "template":
        if "49" in text:
            return True, "the template expression was evaluated (49 appears in the response)"
        return False, "status %s, the expression was not evaluated" % status
    return False, "status %s" % status


def run_input(app, config):
    inputs = config.get("inputs") or []
    probes = []
    errors = []
    with app.client:
        for spec in inputs:
            method, path = split_endpoint(spec["endpoint"])
            kind = spec.get("kind") or "sql"
            payload = PAYLOADS.get(kind, PAYLOADS["sql"])
            where = spec.get("in") or "query"
            url, query, body = app.baseline_request(method, path)
            if where == "query":
                query = {**(query or {}), spec["param"]: payload}
            elif where == "path":
                url = url.replace("{%s}" % spec["param"], payload)
                if ("{%s}" % spec["param"]) not in path:
                    import re
                    url = re.sub(r"\{[^}]+\}", payload, path, count=1)
            else:  # body
                body = {**(body or {}), spec["param"]: payload}
            headers = app.headers_for(spec.get("role")) if spec.get("role") else {}
            try:
                resp = app.send(method, url, headers=headers, query=query, json_body=body)
            except Exception as e:  # noqa: BLE001
                errors.append("%s %s: %s" % (spec["endpoint"], spec.get("param"), str(e)[:200]))
                continue
            flagged, evidence = input_flagged(kind, resp)
            probes.append({
                "endpoint": spec["endpoint"], "param": spec["param"], "in": where, "kind": kind,
                "payload": payload, "status": resp["status"], "flagged": bool(flagged), "evidence": evidence,
                "request": {"method": method, "path": url, "query": query, "json": body},
                "response": {"status": resp["status"], "body": resp["body"]},
            })
    return {"probes": probes, "errors": errors}


RUNNERS = {"matrix": run_matrix, "idor": run_idor, "authflow": run_authflow, "input": run_input}


def main(argv):
    if not argv or argv[0] not in RUNNERS:
        sys.stderr.write(__doc__)
        return 2
    sub = argv[0]
    args = {}
    i = 1
    while i < len(argv):
        args[argv[i]] = argv[i + 1] if i + 1 < len(argv) else ""
        i += 2
    sys.path.insert(0, os.getcwd())
    close_network()
    config = load_json(args.get("--config"), {}) or {}
    endpoints = load_json(args.get("--endpoints"))
    if endpoints is not None and "endpoints" not in config:
        config["endpoints"] = endpoints
    try:
        app = App(args["--app"], config)
        result = RUNNERS[sub](app, config)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        with open(args["--out"], "w", encoding="utf-8") as f:
            json.dump({"errors": ["%s" % traceback.format_exc().strip().splitlines()[-1]]}, f)
        return 1
    with open(args["--out"], "w", encoding="utf-8") as f:
        json.dump(jsonable(result), f, sort_keys=True, default=repr)
    counts = {k: len(v) for k, v in result.items() if isinstance(v, list)}
    sys.stdout.write("%s: %s\n" % (sub, ", ".join("%d %s" % (n, k) for k, n in counts.items())))
    for e in result.get("errors", []):
        sys.stdout.write("  note: %s\n" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
