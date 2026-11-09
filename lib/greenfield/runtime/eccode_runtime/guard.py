"""EccodeGuard: a pure ASGI middleware owned by the ECCode engine (stdlib only).

The engine vendors this package into a generated app tree by hash (MANIFEST.sha256) and writes its config.json from
the sealed contracts/openapi.json; the app mounts it with ``app.add_middleware(EccodeGuard)``. The engine's runtime
check (GF-RT-1) refuses the phase:build approval when the vendored files differ from the engine's copy or a canary
request shows the guard is not in the stack. Every response the guard itself produces carries ``x-eccode-rule``.

GF-VAL-1 (body filters), for every request that carries a body:
  * size: more than limits.max_body_bytes (default 1,048,576) is rejected, by Content-Length up front and by the
    streamed total (the body is buffered, then replayed to the app unchanged when accepted);
  * for a JSON body (application/json, application/*+json, or no Content-Type, which FastAPI also parses as JSON):
    strict UTF-8 (invalid bytes, encoded surrogates and UTF-16/32 bodies rejected); a lone UTF-16 surrogate written as
    a \\uXXXX escape (a high one not followed by a low one, or a low one alone) rejected; nesting deeper than
    limits.max_depth (64), found by an iterative scan (no recursion; 100,000-deep input is fine); a string token
    longer than limits.max_string_length (100,000 characters) rejected ("length");
  * "type": on POST/PUT/PATCH with a JSON Content-Type, a body that PARSES to a top-level value other than an object
    or array is rejected. Syntactically malformed JSON is never rejected for being malformed: it reaches the app
    unchanged (only the lexical filters above can stop it).
  A rejection is 422 {"detail":[{"type":"gf_val","rule":"GF-VAL-1","msg":<fixed reason>}]}; it never contains any
  request content.

GF-DOCS-1 (docs closed by default): /docs, /docs/oauth2-redirect, /redoc and /openapi.json answer 404
{"detail":"Not Found"} for every method, unless config.json has docs_enabled: true or the environment has exactly
ECCODE_DOCS_ENABLED=1 when the guard is constructed (the explicit switch).

GF-ID-1 (I7, canonical integer path ids): config.int_params lists, per operation, the path params the contract types
as integers. A request whose segment for such a param is not a canonical ASCII decimal integer ``^(0|-?[1-9][0-9]*)$``
(the form ``str(int(x))`` gives; a negative id is canonical, so the app keeps its own 404 for it) after
percent-decoding (``+1``, ``01``, ``1.0``, `` 1``, a fullwidth digit, ...) is not answered by the guard: the segment
(in ``path`` and ``raw_path``) is replaced by the fixed token ``not-canonical`` and the request passes on, so the app
gives exactly its own non-integer-id answer, in its own auth order. Canonical ids of any size are left alone.

Stage order (no credentials -> 401 first): config.secured lists the operations the contract secures (openapi
``security``, global or per operation; ``security: []`` is public). A GF-VAL-1 rejection of a request to a secured
operation that has NO Authorization header is answered 401 {"detail":"Not authenticated"} with
``WWW-Authenticate: Bearer`` instead of 422. Limit: the guard does not validate tokens, so a request with a present
but invalid token still gets the 422. A path that matches no contract operation is treated as public.
"""

from __future__ import annotations

import json
import os
import re
from urllib.parse import quote

RULE_VAL = "GF-VAL-1"
RULE_DOCS = "GF-DOCS-1"
DOCS_PATHS = frozenset({"/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"})
BODY_METHODS = {"POST", "PUT", "PATCH"}
DEFAULT_LIMITS = {"max_body_bytes": 1048576, "max_depth": 64, "max_string_length": 100000}

_OUTSIDE = re.compile(r'[\[\]{}"]')
_INSIDE = re.compile(r'["\\]')
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_CANONICAL = re.compile(r"(0|-?[1-9][0-9]*)", re.ASCII)
NOT_CANONICAL = "not-canonical"


class _Reject(Exception):
    def __init__(self, msg: str) -> None:
        super().__init__(msg)
        self.msg = msg


def _template_regex(template: str):
    parts = re.split(r"(\{[^/{}]+\})", template)
    return re.compile("^" + "".join("[^/]+" if p.startswith("{") and p.endswith("}") else re.escape(p) for p in parts) + "$")


def _int_template(template: str, params):
    """Segments of a path template: a literal string, or True for an integer param, or None for another param."""
    names = set(params)
    out = []
    for seg in template.split("/"):
        m = re.fullmatch(r"\{([^/{}:]+)\}", seg)
        if m:
            out.append(True if m.group(1) in names else None)
        elif "{" in seg or "}" in seg:
            return None  # a template the guard does not model (converters, partial segments): left alone
        else:
            out.append(seg)
    return out if any(x is True for x in out) else None


def _is_json_type(content_type: str | None) -> bool:
    if content_type is None or content_type.strip() == "":
        return True
    media = content_type.split(";", 1)[0].strip().lower()
    if not media.startswith("application/"):
        return False
    sub = media[len("application/"):]
    return sub == "json" or sub.endswith("+json")


def scan_json_text(text: str, max_depth: int, max_string: int) -> None:
    """Iterative lexical scan: depth, string lengths and escaped surrogates. Raises _Reject; never judges syntax."""
    i, n, depth = 0, len(text), 0
    while i < n:
        m = _OUTSIDE.search(text, i)
        if m is None:
            return
        ch = m.group()
        i = m.end()
        if ch in "[{":
            depth += 1
            if depth > max_depth:
                raise _Reject("nesting too deep")
            continue
        if ch in "]}":
            depth = depth - 1 if depth > 0 else 0
            continue
        # a string token
        length = 0
        pending_high = False
        while True:
            m = _INSIDE.search(text, i)
            if m is None:
                seg = text[i:]
                if pending_high and seg:
                    raise _Reject("lone surrogate")
                length += len(seg)
                if length > max_string:
                    raise _Reject("string too long")
                return  # unterminated string: malformed, left to the app
            seg = m.start() - i
            if seg:
                if pending_high:
                    raise _Reject("lone surrogate")
                length += seg
            i = m.end()
            if m.group() == '"':
                if pending_high:
                    raise _Reject("lone surrogate")
                if length > max_string:
                    raise _Reject("string too long")
                break
            # an escape
            if i >= n:
                return
            esc = text[i]
            i += 1
            length += 1
            if esc == "u" and _HEX4.match(text, i):
                cp = int(text[i:i + 4], 16)
                i += 4
                if 0xD800 <= cp <= 0xDBFF:
                    if pending_high:
                        raise _Reject("lone surrogate")
                    pending_high = True
                elif 0xDC00 <= cp <= 0xDFFF:
                    if not pending_high:
                        raise _Reject("lone surrogate")
                    pending_high = False
                    length -= 1  # a pair is one character
                elif pending_high:
                    raise _Reject("lone surrogate")
            elif pending_high:
                raise _Reject("lone surrogate")
            if length > max_string:
                raise _Reject("string too long")


def _decode_strict(body: bytes) -> str:
    if body[:3] == b"\xef\xbb\xbf":
        body = body[3:]
    elif body[:2] in (b"\xff\xfe", b"\xfe\xff") or (len(body) >= 2 and (body[0] == 0 or body[1] == 0)):
        raise _Reject("body is not UTF-8")
    try:
        text = body.decode("utf-8", "strict")
    except UnicodeDecodeError:
        raise _Reject("body is not UTF-8") from None
    return text


class EccodeGuard:
    """Pure ASGI guard; ``config_path`` defaults to config.json next to this package. A missing config fails closed."""

    def __init__(self, app, config_path: str | None = None) -> None:
        self.app = app
        path = config_path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        limits = dict(DEFAULT_LIMITS)
        limits.update(cfg.get("limits") or {})
        self.max_body = int(limits["max_body_bytes"])
        self.max_depth = int(limits["max_depth"])
        self.max_string = int(limits["max_string_length"])
        self.docs_enabled = cfg.get("docs_enabled") is True or os.environ.get("ECCODE_DOCS_ENABLED") == "1"
        self.secured = [(str(op["method"]).upper(), _template_regex(str(op["pathTemplate"]))) for op in cfg.get("secured") or []]
        self.int_params = []
        for op in cfg.get("int_params") or []:
            segs = _int_template(str(op["pathTemplate"]), [str(x) for x in op.get("params") or []])
            if segs is not None:
                self.int_params.append((str(op["method"]).upper(), segs))

    def _canonical_ids(self, scope):
        """I7: the scope with every non-canonical integer-param segment replaced by NOT_CANONICAL (or the same scope)."""
        if not self.int_params:
            return scope
        path = scope.get("path") or ""
        method = str(scope.get("method", "GET")).upper()
        method = "GET" if method == "HEAD" else method
        segs = path.split("/")
        bad = set()
        for m, tpl in self.int_params:
            if m != method or len(tpl) != len(segs):
                continue
            # literal segments equal; a param segment (True or None) matches any non-empty segment, as Starlette's str convertor
            if all((v != "") if (t is None or t is True) else (t == v) for t, v in zip(tpl, segs)):
                bad.update(i for i, (t, v) in enumerate(zip(tpl, segs)) if t is True and not _CANONICAL.fullmatch(v))
        if not bad:
            return scope
        new_segs = [NOT_CANONICAL if i in bad else v for i, v in enumerate(segs)]
        new = dict(scope)
        new["path"] = "/".join(new_segs)
        raw = scope.get("raw_path")
        if isinstance(raw, (bytes, bytearray)):
            rsegs = bytes(raw).split(b"/")
            if len(rsegs) == len(segs):
                new["raw_path"] = b"/".join(NOT_CANONICAL.encode() if i in bad else v for i, v in enumerate(rsegs))
            else:
                new["raw_path"] = quote(new["path"]).encode()
        return new

    # ---- responses -------------------------------------------------------------------------------------------------

    @staticmethod
    async def _send(send, status: int, payload, rule: str, extra=()) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                   (b"x-eccode-rule", rule.encode())] + list(extra)
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    def _is_secured(self, method: str, path: str) -> bool:
        return any(m == method and rx.match(path) for m, rx in self.secured)

    async def _reject_val(self, scope, send, headers: dict, msg: str) -> None:
        if b"authorization" not in headers and self._is_secured(scope["method"].upper(), scope["path"]):
            await self._send(send, 401, {"detail": "Not authenticated"}, RULE_VAL, [(b"www-authenticate", b"Bearer")])
            return
        await self._send(send, 422, {"detail": [{"type": "gf_val", "rule": RULE_VAL, "msg": msg}]}, RULE_VAL)

    # ---- the ASGI entry ------------------------------------------------------------------------------------------

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        if not self.docs_enabled and scope.get("path") in DOCS_PATHS:
            await self._send(send, 404, {"detail": "Not Found"}, RULE_DOCS)
            return
        scope = self._canonical_ids(scope)
        headers = {}
        for k, v in scope.get("headers") or []:
            headers.setdefault(k.lower(), v)
        method = str(scope.get("method", "GET")).upper()
        has_body = b"content-length" in headers or b"transfer-encoding" in headers or method in BODY_METHODS
        if not has_body:
            await self.app(scope, receive, send)
            return
        cl = headers.get(b"content-length")
        if cl is not None:
            try:
                if int(cl.decode("latin-1").strip()) > self.max_body:
                    await self._reject_val(scope, send, headers, "body too large")
                    return
            except ValueError:
                pass  # the server rejects a malformed Content-Length
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            part = message.get("body", b"")
            total += len(part)
            if total > self.max_body:
                await self._reject_val(scope, send, headers, "body too large")
                return
            chunks.append(part)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        ctype = headers.get(b"content-type")
        ctype_s = ctype.decode("latin-1") if ctype is not None else None
        if body and _is_json_type(ctype_s):
            try:
                text = _decode_strict(body)
                scan_json_text(text, self.max_depth, self.max_string)
                if method in BODY_METHODS and ctype_s is not None and ctype_s.strip():
                    try:
                        value = json.loads(text)
                    except (ValueError, RecursionError):
                        value = None
                        parsed = False
                    else:
                        parsed = True
                    if parsed and not isinstance(value, (dict, list)):
                        raise _Reject("top-level value must be an object or array")
            except _Reject as rej:
                await self._reject_val(scope, send, headers, rej.msg)
                return

        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
