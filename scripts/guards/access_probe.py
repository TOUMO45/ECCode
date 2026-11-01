#!/usr/bin/env python3
"""Access-control probe against the FastAPI app of ONE worktree (ECCode security guard).

  python access_probe.py <matrix|idor|authflow|input> --app <module:attr> --config <runspec.json> --out <result.json> [--endpoints <reached.json>]

This is the standard access-control test battery a CI suite runs against the
project's OWN app: an access matrix (role x endpoint x ownership, with a
field-leak oracle on every 2xx a non-owner receives), IDOR/BOLA probes (reads of
another principal's object, plus property-level mass-assignment writes), auth-flow
checks and targeted input probes (with a boolean differential for SQL). Every request goes to the
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

def example_for_schema(schema, variant, components, salt=""):
    """A deterministic example for a JSON schema (copied from the behavior probe runner). A `salt` is appended to
    plain string examples so two principals never send the same value to a unique column."""
    if not isinstance(schema, dict):
        return None
    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        return example_for_schema(components.get(name, {}), variant, components, salt)
    if "example" in schema:
        return schema["example"]
    if "default" in schema and variant == 0:
        return schema["default"]
    if "enum" in schema and schema["enum"]:
        return schema["enum"][variant % len(schema["enum"])]
    for key in ("anyOf", "oneOf"):
        if key in schema and schema[key]:
            options = [o for o in schema[key] if o.get("type") != "null"] or schema[key]
            return example_for_schema(options[variant % len(options)], variant, components, salt)
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
        base = ["alpha", "", "Zed zed", "a-1", "x" * 40][variant % 5]
        if salt and base:
            base = "%s-%s" % (base, salt)
        return base[: schema.get("maxLength", 40)] or "a"
    if t == "array":
        return [example_for_schema(schema.get("items", {}), variant, components, salt)]
    if t == "object" or "properties" in schema:
        out = {}
        required = set(schema.get("required", []))
        for name, sub in (schema.get("properties") or {}).items():
            if name in required:
                out[name] = example_for_schema(sub, variant, components, salt)
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

    def level_of(self, role_name):
        return (self.roles.get(role_name) or {}).get("level") or 0

    def op_for(self, method, path):
        return ((self.schema.get("paths") or {}).get(path) or {}).get(method.lower()) or {}

    def has_op(self, method, path):
        return bool(self.op_for(method, path))

    def resolve_schema(self, schema):
        while isinstance(schema, dict) and "$ref" in schema:
            schema = self.components.get(schema["$ref"].split("/")[-1], {})
        return schema if isinstance(schema, dict) else {}

    def request_fields(self, method, path):
        """The JSON request body's declared properties (name -> schema), required or not."""
        rb = self.op_for(method, path).get("requestBody") or {}
        for ctype, media in (rb.get("content") or {}).items():
            if "json" in ctype:
                return dict((self.resolve_schema(media.get("schema")).get("properties") or {}))
        return {}

    def response_fields(self, method, path):
        """The declared 2xx response object's property names (None when the operation declares no object schema)."""
        responses = self.op_for(method, path).get("responses") or {}
        for code in ("200", "201", "default"):
            media = ((responses.get(code) or {}).get("content") or {}).get("application/json") or {}
            schema = self.resolve_schema(media.get("schema"))
            if schema.get("type") == "array":
                schema = self.resolve_schema(schema.get("items"))
            props = schema.get("properties")
            if props:
                return sorted(props)
        return None

    def baseline_request(self, method, path, variant=0, salt=""):
        """Query/body filled from the OpenAPI schema so a request is otherwise valid.
        `path` is the TEMPLATE path (with {params}), which is what the schema is keyed by;
        `salt` keeps string body values distinct between principals (unique columns)."""
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
                body = example_for_schema(media.get("schema"), variant, self.components, salt)
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


def item_endpoint(obj):
    """The object's item read as (method, template path)."""
    item = obj.get("item") or {}
    base = (obj.get("list") or obj.get("create") or {}).get("path", "")
    method = (item.get("method") or "GET").upper()
    path = item.get("path") or (base.rstrip("/") + "/{%s}" % (obj.get("idParam") or "id"))
    return method, path


def base_path_of(obj):
    """The collection path the object's endpoints hang off: list/create, else the item path without its id."""
    base = (obj.get("list") or obj.get("create") or {}).get("path")
    if base:
        return base
    _, item = item_endpoint(obj)
    return re.sub(r"/\{[^}]+\}.*$", "", item)


def object_for(endpoint_path, objects):
    """The object whose endpoints this path addresses (by longest base-path prefix)."""
    best, best_len = None, -1
    for obj in objects:
        base = base_path_of(obj)
        if not base:
            continue
        if endpoint_path == base or endpoint_path.startswith(base.rstrip("/") + "/"):
            if len(base) > best_len:
                best, best_len = obj, len(base)
    return best


def substitute_id(path, obj, value):
    param = obj.get("idParam") if obj else None
    token = "{%s}" % param if param else None
    if token and token in path:
        return path.replace(token, str(value))
    # Fall back to the first path parameter.
    return re.sub(r"\{[^}]+\}", str(value), path, count=1)


def create_objects(app, objects):
    """One object per authenticated role: the ids `owned` declares (seeded, non-creatable objects), else one
    created through `create`. Returns {kind: {role_name: id}} and a nonexistent id."""
    owners = {}
    max_id = 0
    errors = []
    for obj in objects:
        kind = obj.get("kind") or "object"
        create = obj.get("create") or {}
        owned = obj.get("owned") or {}
        owners[kind] = {}
        for name, role in app.roles.items():
            if (role.get("level") or 0) <= 0:
                continue
            oid = None
            if name in owned:
                oid = owned[name]
            elif create.get("path"):
                method = (create.get("method") or "POST").upper()
                path = create["path"]
                body = create.get("json")
                if body is None:
                    _, _, body = app.baseline_request(method, path)
                resp = app.send(method, path, headers=app.headers_for(name), json_body=body)
                if 200 <= resp["status"] < 300 and isinstance(resp["body"], dict):
                    oid = resp["body"].get(create.get("idField") or "id")
                if oid is None:
                    errors.append("create %s as %s: status %s" % (kind, name, resp["status"]))
            if oid is not None:
                owners[kind][name] = oid
                try:
                    max_id = max(max_id, int(oid))
                except (TypeError, ValueError):
                    pass
    return owners, (max_id + 1000000), errors


def resolve_owner(ownership, role_name, obj, owners, nonexistent, app=None):
    """The id a cell addresses and the role that owns it: (id, owner role or None).
    `other` prefers a peer's object (same level), then any other role's."""
    if obj is None:
        return (nonexistent, None) if ownership == "none" else (1, None)
    kind = obj.get("kind") or "object"
    mine = owners.get(kind, {})
    if ownership == "own":
        if mine.get(role_name) is not None:
            return mine[role_name], role_name
        return ((next(iter(mine.values())), next(iter(mine))) if mine else (1, None))
    if ownership == "other":
        level = app.level_of(role_name) if app else 0
        others = [(n, i) for n, i in mine.items() if n != role_name]
        peers = [(n, i) for n, i in others if app and app.level_of(n) == level]
        for n, i in peers + others:
            return i, n
        return ((next(iter(mine.values())), next(iter(mine))) if mine else (1, None))
    return nonexistent, None  # none


def resolve_id(ownership, role_name, obj, owners, nonexistent):
    return resolve_owner(ownership, role_name, obj, owners, nonexistent)[0]


# ------------------------------------------------------ field policy

# Fields a non-owner must never see unless a reviewed field policy allows them by name.
SENSITIVE_FIELD = re.compile(r"password|passwd|pwd|secret|hash|token|api_?key|private|ssn|salt|credit|card|email", re.IGNORECASE)


def field_policy(config, endpoint, role_name):
    """The declared allow-list of fields `role_name` may see on `endpoint` as a non-owner, or None when none is declared."""
    for p in config.get("fields") or []:
        if p.get("endpoint") != endpoint:
            continue
        roles = p.get("roles")
        if roles and role_name not in roles:
            continue
        return [str(f) for f in (p.get("allow") or [])]
    return None


def field_leaks(policy, schema_fields, owner_body, other_body):
    """Diff the fields a non-owner sees against the field policy.
    Returns (leaked, unknown): `leaked` are the owner's fields (same key and value in the owner's own fetch) the
    policy does not allow, plus every sensitive field; `unknown` are fields no policy covers (reported, never
    silently allowed). With no declared policy, the response schema's declared properties are the default
    allow-list for a non-owner, minus the sensitive ones; a field outside that contract that belongs to the
    owner is a leak."""
    leaked, unknown = [], []
    owner_body = owner_body if isinstance(owner_body, dict) else {}
    allowed = set(policy if policy is not None else (schema_fields or []))
    for key, value in other_body.items():
        belongs = key in owner_body and owner_body[key] == value
        if SENSITIVE_FIELD.search(key):
            if policy is not None and key in allowed:
                continue
            leaked.append(key)
        elif key in allowed:
            continue
        elif policy is None and not schema_fields:
            unknown.append(key)
        elif belongs:
            leaked.append(key)
        else:
            unknown.append(key)
    return leaked, unknown


# -------------------------------------------------------------- matrix

METHOD_ORDER = {"GET": 0, "HEAD": 0, "OPTIONS": 0, "POST": 1, "PUT": 1, "PATCH": 1, "DELETE": 2}


def run_matrix(app, config):
    objects = config.get("objects") or []
    cells = config.get("cells") or []
    out = []
    # Reads first, then writes, deletes last: a destructive cell cannot hide what an earlier read would have shown.
    ordered = sorted(enumerate(cells), key=lambda ic: (METHOD_ORDER.get(split_endpoint(ic[1]["endpoint"])[0], 1), ic[0]))
    owner_bodies = {}
    with app.client:
        owners, nonexistent, errors = create_objects(app, objects)
        results = {}
        for index, cell in ordered:
            method, path = split_endpoint(cell["endpoint"])
            obj = object_for(path, objects)
            has_id = "{" in path
            owner_name = None
            # Query and body come from the schema of the TEMPLATE path; the id is substituted after.
            url, query, body = app.baseline_request(method, path, salt="%s-%s" % (cell["role"], cell["ownership"]))
            if has_id:
                oid, owner_name = resolve_owner(cell["ownership"], cell["role"], obj, owners, nonexistent, app)
                url = substitute_id(path, obj, oid)
            if method in ("POST", "PUT", "PATCH") and obj and (obj.get("create") or {}).get("json") is not None and ((obj.get("create") or {}).get("path") == path):
                body = (obj.get("create") or {}).get("json")
            resp = app.send(method, url, headers=app.headers_for(cell["role"]), query=query, json_body=body)
            row = {"role": cell["role"], "endpoint": cell["endpoint"], "ownership": cell["ownership"], "status": resp["status"], "observed": observed_of(resp["status"]),
                   "leaked": [], "unknownFields": [], "request": {"method": method, "path": url, "query": query, "json": body}, "response": {"status": resp["status"], "body": resp["body"]}}
            # Field-leak oracle: a 2xx object another principal owns, seen by a role at or below the owner's level.
            if (cell["ownership"] == "other" and owner_name and owner_name != cell["role"] and 200 <= resp["status"] < 300
                    and isinstance(resp["body"], dict) and app.level_of(cell["role"]) <= app.level_of(owner_name)):
                key = (owner_name, url)
                if key not in owner_bodies:
                    owner_bodies[key] = app.send("GET", url, headers=app.headers_for(owner_name))
                owner_resp = owner_bodies[key]
                policy = field_policy(config, cell["endpoint"], cell["role"])
                leaked, unknown = field_leaks(policy, app.response_fields(method, path), owner_resp["body"], resp["body"])
                row.update({"leaked": leaked, "unknownFields": unknown, "ownerRole": owner_name, "fieldPolicy": policy,
                            "ownerResponse": {"status": owner_resp["status"], "body": owner_resp["body"]}})
            results[index] = row
        out = [results[i] for i in sorted(results)]
    return {"cells": out, "errors": errors}


# ---------------------------------------------------------------- idor

# Privileged fields a write must never accept from the client, with the value the probe injects.
PRIVILEGED_FIELDS = {"role": "admin", "is_admin": True, "admin": True, "is_staff": True, "is_superuser": True, "superuser": True,
                     "verified": True, "is_verified": True, "owner_id": 1, "user_id": 1, "balance": 1000000}


def injected_value(field, declared, before):
    """The value to inject for `field`: the declared one, else one that differs from the object's current value."""
    if declared is not None:
        return None if before == declared else declared
    base = PRIVILEGED_FIELDS.get(field)
    if isinstance(before, bool):
        return (not before) if before is not True or base is not True else None
    if isinstance(before, int) and not isinstance(before, bool):
        return before + (1000000 if field == "balance" else 1)
    if isinstance(before, str) and base is None:
        return None  # not a privileged shape we know how to escalate
    if base is None:
        return 1
    return None if before == base else base


def coerce_to_schema(app, value, schema):
    """`value` in the type the request schema declares for the field (a str owner_id gets "1", not 1), so the
    injected field reaches the handler instead of failing validation."""
    schema = app.resolve_schema(schema)
    for key in ("anyOf", "oneOf"):
        options = [o for o in (schema.get(key) or []) if o.get("type") != "null"]
        if options:
            schema = app.resolve_schema(options[0])
            break
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), None)
    if t == "string":
        return value if isinstance(value, str) else str(value).lower() if isinstance(value, bool) else str(value)
    if t == "integer":
        if isinstance(value, bool):
            return 1 if value else 0
        try:
            return int(value)
        except (TypeError, ValueError):
            return 1
    if t == "boolean":
        return bool(value) if not isinstance(value, str) else value.lower() not in ("", "0", "false")
    return value


def write_endpoints(app, obj):
    """The write endpoints to probe for mass assignment: `writes` as declared, else the create endpoint and every
    PUT/PATCH the OpenAPI schema declares on the item path."""
    declared = obj.get("writes")
    if declared:
        return [((w.get("method") or "PATCH").upper(), w["path"]) for w in declared if w.get("path")]
    out = []
    create = obj.get("create") or {}
    if create.get("path"):
        out.append(((create.get("method") or "POST").upper(), create["path"]))
    _, item = item_endpoint(obj)
    for method in ("PUT", "PATCH"):
        if app.has_op(method, item):
            out.append((method, item))
    return out


def run_mass_assignment(app, config, objects, owners):
    """Property-level writes: the legitimate body plus privileged fields, then a read-back of the object."""
    probes = []
    for obj in objects:
        kind = obj.get("kind") or "object"
        read_method, read_path = item_endpoint(obj)
        read_back = obj.get("readBack") or {}
        read_method, read_path = (read_back.get("method") or read_method).upper(), read_back.get("path") or read_path
        declared_inject = obj.get("inject") or {}
        for method, path in write_endpoints(app, obj):
            endpoint = "%s %s" % (method, path)
            is_create = "{" not in path
            for role_name, oid in owners.get(kind, {}).items():
                headers = app.headers_for(role_name)
                url, query, body = app.baseline_request(method, path, salt="ma-%s" % role_name)
                if not is_create:
                    url = substitute_id(path, obj, oid)
                if (obj.get("create") or {}).get("json") is not None and (obj.get("create") or {}).get("path") == path:
                    body = dict((obj.get("create") or {}).get("json"))
                if not isinstance(body, dict):
                    body = {}
                before = {} if is_create else app.send(read_method, substitute_id(read_path, obj, oid), headers=headers)["body"]
                before = before if isinstance(before, dict) else {}
                # Candidate fields: the fixed privileged list, every *_id the object exposes, the write schema's privileged/id properties, the declared ones.
                candidates = dict(PRIVILEGED_FIELDS)
                for k in list(before) + list(app.request_fields(method, path)):
                    if k.endswith("_id") or k in PRIVILEGED_FIELDS:
                        candidates.setdefault(k, None)
                for k, v in declared_inject.items():
                    candidates[k] = v
                injected = {}
                request_schema = app.request_fields(method, path)
                for field in candidates:
                    if field in body and declared_inject.get(field) is None:
                        continue  # part of the legitimate body
                    value = injected_value(field, declared_inject.get(field), before.get(field))
                    if value is not None and field in request_schema:
                        value = coerce_to_schema(app, value, request_schema[field])
                        if value == before.get(field):
                            value = None
                    if value is not None:
                        injected[field] = value
                if not injected:
                    continue
                sent = {**body, **injected}
                resp = app.send(method, url, headers=headers, query=query, json_body=sent)
                persisted = []
                after = None
                if 200 <= resp["status"] < 300:
                    target = oid
                    if is_create and isinstance(resp["body"], dict):
                        target = resp["body"].get((obj.get("create") or {}).get("idField") or "id")
                    got = resp["body"] if isinstance(resp["body"], dict) else {}
                    if target is not None:
                        after = app.send(read_method, substitute_id(read_path, obj, target), headers=headers)
                        # The read-back is the oracle; when it no longer answers the writer (an injected owner moved the
                        # object away from them), the write's own response body is what is left to judge.
                        if 200 <= after["status"] < 300 and isinstance(after["body"], dict):
                            got = after["body"]
                    for field, value in injected.items():
                        if field in got and got[field] == value and before.get(field) != value:
                            persisted.append(field)
                probes.append({
                    "kind": kind, "probe": "mass-assignment", "endpoint": endpoint, "as": role_name, "relationship": "owner", "ownerRole": role_name,
                    "status": resp["status"], "leaked": [], "injected": injected, "persisted": persisted, "fail": bool(persisted),
                    "request": {"method": method, "path": url, "query": query, "json": sent, "as": role_name},
                    "response": {"status": resp["status"], "body": resp["body"]},
                    "before": before, "readBack": {"status": after["status"], "body": after["body"]} if after else None,
                })
    return probes


def reached(endpoint, focus):
    """Whether the change reached `endpoint` ("METHOD /path"): an exact match, or the same method on a path the
    endpoint ends with (the change's route is declared without its router's mount prefix)."""
    if not focus:
        return True
    method, path = split_endpoint(endpoint)
    for f in focus:
        fm, fp = split_endpoint(f)
        if f == path or ((fm == method or fm == "ANY") and (fp == path or path.endswith(fp))):
            return True
    return False


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
            method, item_path = item_endpoint(obj)
            endpoint = "%s %s" % (method, item_path)
            if not reached(endpoint, focus):
                continue
            schema_fields = app.response_fields(method, item_path)
            mine = owners.get(kind, {})
            # Each owner A's objects, fetched by A, then by every non-owner at or below A's level.
            for owner_name, oid in mine.items():
                owner_level = app.level_of(owner_name)
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
                    policy = field_policy(config, endpoint, other_name)
                    leaked, unknown = [], []
                    ok = 200 <= resp["status"] < 300
                    if ok and isinstance(resp["body"], dict):
                        if policy is None:
                            # No field policy: the object is private; everything of the owner's that comes back leaked.
                            leaked = [k for k, v in resp["body"].items() if k in owner_body and owner_body[k] == v]
                        else:
                            leaked, unknown = field_leaks(policy, schema_fields, owner_body, resp["body"])
                    # A declared field policy makes a 2xx legitimate as long as only the allowed fields come back.
                    fail = ok and (policy is None or bool(leaked))
                    probes.append({
                        "endpoint": endpoint, "kind": kind, "probe": "read", "as": other_name, "relationship": relationship,
                        "ownerRole": owner_name, "status": resp["status"], "leaked": leaked, "unknownFields": unknown, "fieldPolicy": policy, "fail": bool(fail),
                        "request": {"method": method, "path": owner_url, "as": other_name},
                        "response": {"status": resp["status"], "body": resp["body"]},
                        "ownerResponse": {"status": owner_resp["status"], "body": owner_resp["body"]},
                    })
        # Property-level writes last: an injected privilege that sticks must not colour the reads above.
        probes += run_mass_assignment(app, config, objects, owners)
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
# Boolean differential pairs for the sql probe: a value no row matches, made true or false by the condition that
# follows the quote. A parameterized query treats both literally (same result); an injected one tells them apart.
SQL_CONTROL = "eccodeprobe"
SQL_PAIRS = [
    (SQL_CONTROL + "' OR '1'='1", SQL_CONTROL + "' AND '1'='2"),
    (SQL_CONTROL + "' OR '1'='1' --", SQL_CONTROL + "' AND '1'='2' --"),
]


def result_size(body):
    """How many rows a response carries: the length of a list body, else of its largest list value; None when unknown."""
    if isinstance(body, list):
        return len(body)
    if isinstance(body, dict):
        sizes = [len(v) for v in body.values() if isinstance(v, list)]
        return max(sizes) if sizes else None
    return None


def normalized_text(body, payloads):
    text = body if isinstance(body, str) else json.dumps(body, sort_keys=True)
    for p in payloads:
        text = text.replace(p, "<q>")
    return text


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


def sql_differential(true_resp, false_resp, pair):
    """Whether a tautology and a contradiction were told apart: by status, by row count, or by body (payload echoes removed)."""
    ts, fs = true_resp["status"], false_resp["status"]
    if ts != fs:
        return (200 <= ts < 300), "the tautology answered HTTP %s but the false condition HTTP %s" % (ts, fs)
    t_size, f_size = result_size(true_resp["body"]), result_size(false_resp["body"])
    if t_size is not None and f_size is not None:
        if t_size > f_size:
            return True, "the tautology returned %d row(s) where the false condition returned %d (the quote broke out of the literal)" % (t_size, f_size)
        return False, "both conditions returned %d row(s)" % t_size
    if normalized_text(true_resp["body"], pair) != normalized_text(false_resp["body"], pair):
        return True, "the tautology and the false condition produced different responses"
    return False, "both conditions produced the same response"


def place_payload(app, spec, payload):
    method, path = split_endpoint(spec["endpoint"])
    where = spec.get("in") or "query"
    url, query, body = app.baseline_request(method, path)
    if where == "query":
        query = {**(query or {}), spec["param"]: payload}
    elif where == "path":
        url = url.replace("{%s}" % spec["param"], payload)
        if ("{%s}" % spec["param"]) not in path:
            url = re.sub(r"\{[^}]+\}", payload, path, count=1)
    else:  # body
        body = {**(body or {}), spec["param"]: payload}
    return method, url, query, body


def run_input(app, config):
    inputs = config.get("inputs") or []
    probes = []
    errors = []
    with app.client:
        for spec in inputs:
            kind = spec.get("kind") or "sql"
            payload = PAYLOADS.get(kind, PAYLOADS["sql"])
            where = spec.get("in") or "query"
            headers = app.headers_for(spec.get("role")) if spec.get("role") else {}
            try:
                method, url, query, body = place_payload(app, spec, payload)
                resp = app.send(method, url, headers=headers, query=query, json_body=body)
            except Exception as e:  # noqa: BLE001
                errors.append("%s %s: %s" % (spec["endpoint"], spec.get("param"), str(e)[:200]))
                continue
            flagged, evidence = input_flagged(kind, resp)
            probe = {
                "endpoint": spec["endpoint"], "param": spec["param"], "in": where, "kind": kind,
                "payload": payload, "status": resp["status"], "flagged": bool(flagged), "evidence": evidence,
                "request": {"method": method, "path": url, "query": query, "json": body},
                "response": {"status": resp["status"], "body": resp["body"]},
            }
            if kind == "sql" and not flagged:
                # Boolean differential: a true and a false condition behind the same quote must be indistinguishable.
                differential = []
                for true_payload, false_payload in SQL_PAIRS:
                    try:
                        tm, tu, tq, tb = place_payload(app, spec, true_payload)
                        t_resp = app.send(tm, tu, headers=headers, query=tq, json_body=tb)
                        fm, fu, fq, fb = place_payload(app, spec, false_payload)
                        f_resp = app.send(fm, fu, headers=headers, query=fq, json_body=fb)
                    except Exception as e:  # noqa: BLE001
                        errors.append("%s %s differential: %s" % (spec["endpoint"], spec.get("param"), str(e)[:200]))
                        continue
                    hit, detail = sql_differential(t_resp, f_resp, (true_payload, false_payload))
                    differential.append({"true": {"payload": true_payload, "request": {"method": tm, "path": tu, "query": tq, "json": tb}, "response": t_resp},
                                         "false": {"payload": false_payload, "request": {"method": fm, "path": fu, "query": fq, "json": fb}, "response": f_resp},
                                         "flagged": bool(hit), "detail": detail})
                    if hit and not probe["flagged"]:
                        probe["flagged"] = True
                        probe["payload"] = true_payload
                        probe["status"] = t_resp["status"]
                        probe["evidence"] = "boolean differential: %s" % detail
                probe["differential"] = differential
                if not probe["flagged"] and differential:
                    probe["evidence"] = "%s; boolean differential: %s" % (evidence, differential[-1]["detail"])
            probes.append(probe)
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
