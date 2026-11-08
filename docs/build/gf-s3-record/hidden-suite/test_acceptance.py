"""Black-box acceptance tests for the shared task tracker (AC-1 .. AC-24).

Each test is named test_ac<NN>_<slug>; a criterion passes iff all tests carrying its
prefix pass. Tests assert only what the PRD states (status codes, JSON field names,
admin-bootstrap rule, BOLA rule = 404) and never error-message wording.

AC-21..AC-24 are `command` criteria in the PRD (repo unit tests); over HTTP only their
externally observable consequences can be probed, which is what the tests below do.
"""
import base64
import hashlib
import json
import os
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import httpx
import pytest

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL, TIMEOUT, USER_PASSWORD, bearer, unique_email

TASK_FIELDS = ("id", "title", "description", "status", "owner_id", "created_at")
STATUSES = ("todo", "in_progress", "done")


# ----------------------------------------------------------------------------- helpers
def mk(tag="v"):
    return f"{tag}-{uuid.uuid4().hex}"


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def err(resp, status):
    """Assert the status and a JSON error body shaped {"detail": ...}; return the body."""
    assert resp.status_code == status, f"expected {status}, got {resp.status_code}: {resp.text[:300]}"
    body = resp.json()
    assert isinstance(body, dict) and "detail" in body, f"error body is not {{'detail': ...}}: {body!r}"
    return body


def check_utc(ts):
    assert isinstance(ts, str), f"timestamp is not a string: {ts!r}"
    dt = datetime.fromisoformat(ts)
    assert dt.tzinfo is not None and dt.utcoffset() == timedelta(0), f"timestamp is not UTC ISO 8601: {ts!r}"


def check_task(t, owner_id=None):
    assert isinstance(t, dict)
    for f in TASK_FIELDS:
        assert f in t, f"task is missing field {f!r}: {t!r}"
    assert is_int(t["id"])
    assert isinstance(t["title"], str)
    assert isinstance(t["description"], str)
    assert t["status"] in STATUSES
    assert is_int(t["owner_id"])
    check_utc(t["created_at"])
    if owner_id is not None:
        assert t["owner_id"] == owner_id


def ok_json(resp, status=200):
    assert resp.status_code == status, f"expected {status}, got {resp.status_code}: {resp.text[:300]}"
    return resp.json()


def norm(resp, ident):
    """Error body with the (varying) numeric id masked, for 'identical to unknown id' checks."""
    return json.dumps(resp.json(), sort_keys=True).replace(str(ident), "<id>")


UNKNOWN_ID = 999999


# =============================================================================== AC-1
def test_ac01_register_returns_201_and_user_shape(api):
    email = unique_email()
    r = api.register(email)
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"id", "email", "role"}
    assert is_int(body["id"])
    assert body["email"] == email
    assert body["role"] == "user"


def test_ac01_register_email_is_lowercased(api):
    sent = f"MiXeD-{uuid.uuid4().hex}@Example.COM"
    r = api.register(sent)
    assert r.status_code == 201, r.text
    assert r.json()["email"] == sent.lower()


def test_ac01_register_body_has_no_password_hash_or_extra_field(api):
    pw = "Zz-" + uuid.uuid4().hex
    r = api.register(unique_email(), pw)
    assert r.status_code == 201, r.text
    assert pw not in r.text
    assert set(r.json()) == {"id", "email", "role"}


def test_ac01_register_response_is_json(api):
    r = api.register()
    assert r.status_code == 201
    assert r.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize("length", [8, 128])
def test_ac01_password_length_boundaries_accepted(api, length):
    r = api.register(unique_email(), "p" * length)
    assert r.status_code == 201, r.text


def test_ac01_each_registration_gets_a_distinct_integer_id(api):
    a = api.register().json()
    b = api.register().json()
    assert is_int(a["id"]) and is_int(b["id"])
    assert a["id"] != b["id"]


# =============================================================================== AC-2
def test_ac02_duplicate_email_returns_409(api):
    email = unique_email()
    assert api.register(email).status_code == 201
    err(api.register(email), 409)


def test_ac02_duplicate_is_case_insensitive_later_variant(api):
    local = "alice-" + uuid.uuid4().hex
    assert api.register(f"{local}@example.com").status_code == 201
    err(api.register(f"{local.capitalize()}@Example.com"), 409)


def test_ac02_duplicate_is_case_insensitive_earlier_variant(api):
    local = "bob-" + uuid.uuid4().hex
    assert api.register(f"{local.upper()}@EXAMPLE.COM").status_code == 201
    err(api.register(f"{local}@example.com"), 409)


def test_ac02_conflict_creates_no_second_user(api):
    email = unique_email()
    pw1, pw2 = "first-password-1", "second-password-2"
    assert api.register(email, pw1).status_code == 201
    assert api.register(email.upper().replace("@EXAMPLE.COM", "@Example.com"), pw2).status_code == 409
    assert api.login(email, pw1).status_code == 200
    assert api.login(email, pw2).status_code == 401


def test_ac02_conflict_with_other_password_still_409(api):
    email = unique_email()
    assert api.register(email, "first-password-1").status_code == 201
    assert api.register(email, "another-password-9").status_code == 409


# =============================================================================== AC-3
@pytest.mark.parametrize(
    "bad_email", ["not-an-email", "", "@example.com", "user@", "user.example.com", "a@@example.com"]
)
def test_ac03_malformed_email_returns_422(api, bad_email):
    err(api.raw_register({"email": bad_email, "password": USER_PASSWORD}), 422)


@pytest.mark.parametrize("pw", ["", "short", "1234567", "x" * 129, "x" * 500])
def test_ac03_password_length_out_of_range_returns_422_and_creates_nothing(api, pw):
    email = unique_email()
    err(api.raw_register({"email": email, "password": pw}), 422)
    # the failed attempt must not have created the user: a valid attempt still gets 201
    assert api.register(email).status_code == 201


@pytest.mark.parametrize(
    "body_factory",
    [
        lambda e: {"password": USER_PASSWORD},
        lambda e: {"email": e},
        lambda e: {},
        lambda e: {"email": None, "password": USER_PASSWORD},
        lambda e: {"email": e, "password": None},
    ],
    ids=["no_email", "no_password", "empty_object", "null_email", "null_password"],
)
def test_ac03_missing_or_null_field_returns_422(api, body_factory):
    err(api.raw_register(body_factory(unique_email())), 422)


@pytest.mark.parametrize(
    "extra",
    [{"role": "admin"}, {"role": "user"}, {"is_admin": True}, {"admin": True}, {"id": 5}, {"foo": "bar"}],
    ids=["role_admin", "role_user", "is_admin", "admin", "id", "foo"],
)
def test_ac03_unknown_field_returns_422_and_creates_nothing(api, extra):
    email = unique_email()
    body = {"email": email, "password": USER_PASSWORD, **extra}
    err(api.raw_register(body), 422)
    r = api.register(email)
    assert r.status_code == 201, "the rejected attempt must not have created the user"
    assert r.json()["role"] == "user"


# =============================================================================== AC-4
def test_ac04_regular_registrants_get_role_user(api):
    for _ in range(3):
        r = api.register()
        assert r.status_code == 201
        assert r.json()["role"] == "user"


def test_ac04_admin_email_registrant_gets_role_admin(api, admin_boot, admin):
    # Registration used an upper-cased variant of ADMIN_EMAIL (case-insensitive match).
    # On a persistent server the account may pre-exist (409); then admin power is
    # confirmed behaviourally: the account sees a foreign user's task.
    assert admin_boot["register_status"] in (201, 409)
    if admin_boot["register_status"] == 201:
        body = admin_boot["register_body"]
        assert body["role"] == "admin"
        assert body["email"] == ADMIN_EMAIL.lower()
    else:
        victim = api.new_user("victim")
        t = api.task(victim)
        ids = [x["id"] for x in ok_json(api.list_tasks(admin))]
        assert t["id"] in ids


def test_ac04_lookalike_emails_do_not_get_admin(api):
    local, _, domain = ADMIN_EMAIL.partition("@")
    tag = uuid.uuid4().hex[:10]
    candidates = [f"{local}-{tag}@{domain}", f"{tag}-{local}@{domain}", f"{local}@{tag}.{domain}"]
    for email in candidates:
        r = api.register(email)
        assert r.status_code == 201, (email, r.text)
        assert r.json()["role"] == "user", email


def test_ac04_no_request_field_grants_admin(api, user, other):
    victim_task = api.task(other)
    # register / login / create / patch all reject a role-ish field
    err(api.raw_register({"email": unique_email(), "password": USER_PASSWORD, "role": "admin"}), 422)
    err(api.raw_login({"email": user.email, "password": user.password, "role": "admin"}), 422)
    for field in ({"role": "admin"}, {"is_admin": True}):
        err(api.create_task(user, {"title": "x", **field}), 422)
    own = api.task(user)
    for field in ({"role": "admin"}, {"is_admin": True}):
        err(api.patch_task(user, own["id"], field), 422)
    # and the user still has no admin power (the exact status for foreign reads is AC-14's business)
    assert api.get_task(user, victim_task["id"]).status_code != 200
    assert victim_task["id"] not in [t["id"] for t in ok_json(api.list_tasks(user))]


# =============================================================================== AC-5
def test_ac05_login_returns_token_and_type(api):
    email = unique_email()
    assert api.register(email).status_code == 201
    r = api.login(email, USER_PASSWORD)
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["access_token"], str) and body["access_token"]
    assert body["token_type"] == "bearer"


def test_ac05_token_works_as_bearer_on_protected_endpoint(api):
    email = unique_email()
    assert api.register(email).status_code == 201
    token = api.login(email, USER_PASSWORD).json()["access_token"]
    r = api.list_tasks(token)
    assert r.status_code == 200
    assert r.json() == []


def test_ac05_two_logins_return_different_tokens_both_valid(api, user):
    t2 = api.new_token(user)
    assert t2 != user.token
    assert api.list_tasks(user.token).status_code == 200
    assert api.list_tasks(t2).status_code == 200


def test_ac05_login_response_is_json_without_password(api):
    email = unique_email()
    pw = "Qq-" + uuid.uuid4().hex
    assert api.register(email, pw).status_code == 201
    r = api.login(email, pw)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert pw not in r.text


def test_ac05_login_works_for_an_account_registered_with_mixed_case_email(api):
    local = "Case-" + uuid.uuid4().hex
    assert api.register(f"{local}@Example.com").status_code == 201
    r = api.login(f"{local}@Example.com".lower(), USER_PASSWORD)  # the stored (lower-cased) address
    assert r.status_code == 200, r.text


# =============================================================================== AC-6
def test_ac06_wrong_password_returns_401(api, user):
    err(api.login(user.email, "definitely-wrong-1"), 401)


def test_ac06_unknown_email_returns_401(api):
    err(api.login(unique_email("nobody"), "whatever-123"), 401)


def test_ac06_wrong_password_and_unknown_email_have_identical_body(api, user):
    wrong_pw = api.login(user.email, "definitely-wrong-1")
    unknown = api.login(unique_email("nobody"), "definitely-wrong-1")
    assert wrong_pw.status_code == unknown.status_code == 401
    assert wrong_pw.json() == unknown.json()


@pytest.mark.parametrize(
    "body",
    [{"password": USER_PASSWORD}, {"email": "someone@example.com"}, {}],
    ids=["no_email", "no_password", "empty_object"],
)
def test_ac06_missing_field_returns_422(api, body):
    err(api.raw_login(body), 422)


def test_ac06_unknown_field_returns_422_even_with_valid_credentials(api, user):
    for extra in ({"remember": True}, {"role": "admin"}):
        r = api.raw_login({"email": user.email, "password": user.password, **extra})
        err(r, 422)
        assert "access_token" not in r.text


# =============================================================================== AC-7
def test_ac07_logout_returns_204_with_empty_body(api, user):
    r = api.logout(user)
    assert r.status_code == 204
    assert r.content == b""


def test_ac07_token_is_rejected_on_every_protected_endpoint_after_logout(api, user):
    t = api.task(user)
    assert api.logout(user).status_code == 204
    err(api.list_tasks(user), 401)
    err(api.create_task(user, {"title": "after logout"}), 401)
    err(api.get_task(user, t["id"]), 401)
    err(api.patch_task(user, t["id"], {"title": "after logout"}), 401)


def test_ac07_second_logout_with_same_token_is_401(api, user):
    assert api.logout(user).status_code == 204
    err(api.logout(user), 401)


def test_ac07_logout_invalidates_only_that_token(api, user):
    t2 = api.new_token(user)
    assert api.logout(user).status_code == 204
    err(api.list_tasks(user), 401)
    assert api.list_tasks(t2).status_code == 200
    assert api.logout(t2).status_code == 204
    err(api.list_tasks(t2), 401)


def test_ac07_logout_does_not_affect_other_users_tokens(api, user, other):
    assert api.logout(user).status_code == 204
    assert api.list_tasks(other).status_code == 200


def test_ac07_user_can_log_in_again_after_logout_and_keeps_tasks(api, user):
    t = api.task(user)
    assert api.logout(user).status_code == 204
    fresh = api.new_token(user)
    assert fresh != user.token
    assert ok_json(api.get_task(fresh, t["id"])) == t


def test_ac07_logged_out_token_cannot_reach_a_foreign_task_either(api, user, other):
    foreign = api.task(other)
    assert api.logout(user).status_code == 204
    # 401 (token dead), never a leak of the foreign task
    r = api.get_task(user, foreign["id"])
    assert r.status_code == 401
    assert foreign["title"] not in r.text


# =============================================================================== AC-8
PROTECTED = [
    ("POST", "/v1/logout", None),
    ("GET", "/v1/tasks", None),
    ("POST", "/v1/tasks", {"title": "unauthenticated attempt"}),
    ("GET", "/v1/tasks/{tid}", None),
    ("PATCH", "/v1/tasks/{tid}", {"title": "unauthenticated attempt"}),
]
BAD_AUTH = [
    "no_header",
    "basic_scheme",
    "basic_scheme_with_valid_token",
    "token_scheme_with_valid_token",
    "unknown_token",
    "bearer_without_token",
    "invalidated_token",
]


def _bad_headers(kind, api, victim):
    if kind == "no_header":
        return {}
    if kind == "basic_scheme":
        return {"Authorization": "Basic " + base64.b64encode(b"user:pass").decode()}
    if kind == "basic_scheme_with_valid_token":
        return {"Authorization": f"Basic {victim.token}"}
    if kind == "token_scheme_with_valid_token":
        return {"Authorization": f"Token {victim.token}"}
    if kind == "unknown_token":
        return bearer(secrets.token_urlsafe(32))
    if kind == "bearer_without_token":
        return {"Authorization": "Bearer"}
    if kind == "invalidated_token":
        tok = api.new_token(victim)
        assert api.logout(tok).status_code == 204
        return bearer(tok)
    raise AssertionError(kind)


@pytest.mark.parametrize("kind", BAD_AUTH)
@pytest.mark.parametrize("method,path,body", PROTECTED, ids=[f"{m} {p}" for m, p, _ in PROTECTED])
def test_ac08_protected_endpoints_answer_401_with_detail(api, client, user, method, path, body, kind):
    t = api.task(user)
    headers = _bad_headers(kind, api, user)
    r = client.request(method, path.format(tid=t["id"]), json=body, headers=headers)
    err(r, 401)
    assert t["title"] not in r.text


def test_ac08_register_and_login_need_no_token(api):
    email = unique_email()
    assert api.register(email).status_code == 201  # plain client: no Authorization header
    assert api.login(email, USER_PASSWORD).status_code == 200


def test_ac08_valid_token_still_works_after_a_rejected_bad_request(api, client, user):
    client.get("/v1/tasks", headers={"Authorization": "Basic abc"})
    assert api.list_tasks(user).status_code == 200


# =============================================================================== AC-9
def test_ac09_create_returns_201_and_task_shape(api, user):
    title, desc = mk("title"), mk("desc")
    r = api.create_task(user, {"title": title, "description": desc})
    assert r.status_code == 201, r.text
    t = r.json()
    check_task(t, owner_id=user.id)
    assert t["title"] == title
    assert t["description"] == desc
    assert t["status"] == "todo"


def test_ac09_description_defaults_to_empty_string(api, user):
    t = api.task(user)
    assert t["description"] == ""


def test_ac09_title_is_trimmed(api, user):
    core = mk("padded")
    r = api.create_task(user, {"title": f"   {core}\t "})
    assert r.status_code == 201, r.text
    assert r.json()["title"] == core


def test_ac09_boundary_lengths_are_accepted(api, user):
    r = api.create_task(user, {"title": "t" * 200, "description": "d" * 2000})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["title"] == "t" * 200 and t["description"] == "d" * 2000


def test_ac09_owner_is_the_caller_and_status_is_todo_for_any_caller(api, admin, user):
    for who in (user, admin):
        t = api.task(who)
        assert t["owner_id"] == who.id
        assert t["status"] == "todo"


def test_ac09_created_at_is_iso_8601_utc(api, user):
    t = api.task(user)
    check_utc(t["created_at"])
    now = datetime.now().astimezone()
    created = datetime.fromisoformat(t["created_at"])
    assert abs((now - created).total_seconds()) < 3600  # a plausible 'now', not a fixed or local-naive time


def test_ac09_ids_are_distinct_integers(api, user):
    a, b = api.task(user), api.task(user)
    assert is_int(a["id"]) and is_int(b["id"]) and a["id"] != b["id"]


# =============================================================================== AC-10
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"description": "no title"},
        {"title": ""},
        {"title": "   "},
        {"title": "\t\n "},
        {"title": "x" * 201},
        {"title": 123},
        {"title": None},
        {"title": ["a"]},
        {"title": True},
        {"title": "ok", "owner_id": 1},
        {"title": "ok", "id": 1},
        {"title": "ok", "status": "done"},
        {"title": "ok", "status": "todo"},
        {"title": "ok", "created_at": "2020-01-01T00:00:00Z"},
        {"title": "ok", "foo": "bar"},
        {"title": "ok", "description": "d" * 2001},
    ],
    ids=[
        "empty_object", "missing_title", "empty_title", "blank_title", "whitespace_title", "title_201",
        "title_int", "title_null", "title_list", "title_bool", "unknown_owner_id", "unknown_id",
        "unknown_status_done", "unknown_status_todo", "unknown_created_at", "unknown_foo", "description_2001",
    ],
)
def test_ac10_invalid_create_returns_422_and_creates_nothing(api, body):
    u = api.new_user("c10")
    err(api.create_task(u, body), 422)
    assert ok_json(api.list_tasks(u)) == []


def test_ac10_cannot_pick_the_owner_by_sending_owner_id(api, user, other):
    err(api.create_task(user, {"title": "mine", "owner_id": other.id}), 422)
    assert ok_json(api.list_tasks(other)) == []


# =============================================================================== AC-11
def test_ac11_fresh_user_gets_200_and_empty_array(api):
    u = api.new_user("empty")
    r = api.list_tasks(u)
    assert r.status_code == 200
    assert r.json() == []


def test_ac11_list_is_a_bare_array_of_exactly_own_tasks_in_creation_response_shape(api, user):
    created = [api.task(user) for _ in range(3)]
    body = ok_json(api.list_tasks(user))
    assert isinstance(body, list)
    assert body == created
    for t in body:
        check_task(t, owner_id=user.id)


def test_ac11_list_is_ordered_by_id_ascending_even_with_interleaved_creators(api, user, other):
    t1 = api.task(user)
    api.task(other)
    t2 = api.task(user)
    api.task(other)
    t3 = api.task(user)
    ids = [t["id"] for t in ok_json(api.list_tasks(user))]
    assert ids == [t1["id"], t2["id"], t3["id"]]
    assert ids == sorted(ids)


def test_ac11_list_contains_only_the_callers_tasks(api, user, other):
    mine = api.task(user)
    theirs = api.task(other)
    body = ok_json(api.list_tasks(user))
    assert [t["id"] for t in body] == [mine["id"]]
    assert all(t["owner_id"] == user.id for t in body)
    assert theirs["title"] not in json.dumps(body)


def test_ac11_list_reflects_patched_values(api, user):
    t = api.task(user)
    new_title = mk("renamed")
    assert api.patch_task(user, t["id"], {"title": new_title, "status": "done"}).status_code == 200
    body = ok_json(api.list_tasks(user))
    assert len(body) == 1 and body[0]["title"] == new_title and body[0]["status"] == "done"


def test_ac11_list_has_no_pagination_wrapper_and_returns_many(api, user):
    for _ in range(25):
        api.task(user)
    body = ok_json(api.list_tasks(user))
    assert isinstance(body, list) and len(body) == 25


# =============================================================================== AC-12
def test_ac12_other_users_list_excludes_my_task(api, user, other):
    t = api.task(user, title=mk("secret"))
    r = api.list_tasks(other)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert t["id"] not in [x["id"] for x in body]
    assert t["title"] not in r.text


def test_ac12_each_user_sees_only_their_own_tasks(api, user, other):
    a = api.task(user)
    b = api.task(other)
    assert [t["id"] for t in ok_json(api.list_tasks(user))] == [a["id"]]
    assert [t["id"] for t in ok_json(api.list_tasks(other))] == [b["id"]]


def test_ac12_admins_tasks_are_not_in_a_users_list(api, admin, user):
    t = api.task(admin, title=mk("admin-only"))
    body = ok_json(api.list_tasks(user))
    assert t["id"] not in [x["id"] for x in body]
    assert all(x["owner_id"] == user.id for x in body)


def test_ac12_user_without_tasks_gets_empty_list_while_others_have_tasks(api, user):
    api.task(user)
    api.task(user)
    newcomer = api.new_user("newcomer")
    assert ok_json(api.list_tasks(newcomer)) == []


# =============================================================================== AC-13
def test_ac13_owner_gets_200_and_same_task_as_at_creation(api, user):
    t = api.task(user, title=mk("t"), description=mk("d"))
    r = api.get_task(user, t["id"])
    assert r.status_code == 200
    assert r.json() == t


def test_ac13_default_description_round_trips_as_empty_string(api, user):
    t = api.task(user)
    assert ok_json(api.get_task(user, t["id"]))["description"] == ""


def test_ac13_repeated_reads_are_identical(api, user):
    t = api.task(user)
    assert ok_json(api.get_task(user, t["id"])) == ok_json(api.get_task(user, t["id"])) == t


def test_ac13_each_of_my_tasks_reads_back_with_its_own_values(api, user):
    a, b = api.task(user, title=mk("a")), api.task(user, title=mk("b"))
    assert ok_json(api.get_task(user, a["id"])) == a
    assert ok_json(api.get_task(user, b["id"])) == b


# =============================================================================== AC-14
def test_ac14_foreign_get_returns_404_not_200_not_403(api, user, other):
    t = api.task(user)
    r = api.get_task(other, t["id"])
    assert r.status_code not in (200, 403)
    err(r, 404)


def test_ac14_foreign_get_body_leaks_no_task_field_or_value(api, user, other):
    t = api.task(user, title=mk("TOPSECRET-title"), description=mk("TOPSECRET-desc"))
    r = api.get_task(other, t["id"])
    body = err(r, 404)
    for f in TASK_FIELDS:
        assert f not in body, f"error body carries task field {f!r}"
    assert t["title"] not in r.text
    assert t["description"] not in r.text
    assert t["created_at"] not in r.text


def test_ac14_foreign_id_is_indistinguishable_from_unknown_id(api, user, other):
    t = api.task(user)
    foreign = api.get_task(other, t["id"])
    unknown = api.get_task(other, UNKNOWN_ID)
    assert foreign.status_code == unknown.status_code == 404
    assert norm(foreign, t["id"]) == norm(unknown, UNKNOWN_ID)


def test_ac14_idor_sweep_every_foreign_task_id_gives_404(api, user, other):
    tasks = [api.task(user, title=mk("sweep")) for _ in range(4)]
    for t in tasks:
        r = api.get_task(other, t["id"])
        err(r, 404)
        assert t["title"] not in r.text


def test_ac14_foreign_get_is_404_in_both_directions_and_for_any_status(api, user, other):
    a, b = api.task(user), api.task(other)
    assert api.patch_task(user, a["id"], {"status": "done"}).status_code == 200
    err(api.get_task(other, a["id"]), 404)
    err(api.get_task(user, b["id"]), 404)


def test_ac14_owner_still_reads_own_task_after_foreign_probe(api, user, other):
    t = api.task(user)
    err(api.get_task(other, t["id"]), 404)
    assert ok_json(api.get_task(user, t["id"])) == t


# =============================================================================== AC-15
@pytest.mark.parametrize(
    "payload",
    [
        {"title": "HACKED"},
        {"description": "HACKED"},
        {"status": "done"},
        {"title": "HACKED", "description": "HACKED", "status": "in_progress"},
    ],
    ids=["title", "description", "status", "all_fields"],
)
def test_ac15_foreign_patch_returns_404_and_changes_nothing(api, user, other, payload):
    t = api.task(user, title=mk("orig-title"), description=mk("orig-desc"))
    r = api.patch_task(other, t["id"], payload)
    assert r.status_code not in (200, 403)
    err(r, 404)
    assert ok_json(api.get_task(user, t["id"])) == t  # title, description, status, owner untouched


def test_ac15_foreign_patch_body_leaks_no_task_field_or_value(api, user, other):
    t = api.task(user, title=mk("TOPSECRET-title"), description=mk("TOPSECRET-desc"))
    r = api.patch_task(other, t["id"], {"title": "x"})
    body = err(r, 404)
    for f in TASK_FIELDS:
        assert f not in body
    assert t["title"] not in r.text and t["description"] not in r.text


def test_ac15_foreign_patch_is_indistinguishable_from_unknown_id(api, user, other):
    t = api.task(user)
    foreign = api.patch_task(other, t["id"], {"title": "x"})
    unknown = api.patch_task(other, UNKNOWN_ID, {"title": "x"})
    assert foreign.status_code == unknown.status_code == 404
    assert norm(foreign, t["id"]) == norm(unknown, UNKNOWN_ID)


def test_ac15_patch_cannot_transfer_ownership_to_the_caller(api, user, other):
    t = api.task(user)
    for payload in ({"owner_id": other.id}, {"title": "mine now", "owner_id": other.id}):
        r = api.patch_task(other, t["id"], payload)
        assert r.status_code in (404, 422), r.text  # never 200, never 403
    assert ok_json(api.get_task(user, t["id"])) == t
    assert t["id"] not in [x["id"] for x in ok_json(api.list_tasks(other))]
    err(api.get_task(other, t["id"]), 404)


def test_ac15_foreign_patch_is_404_in_both_directions(api, user, other):
    a, b = api.task(user), api.task(other)
    err(api.patch_task(other, a["id"], {"title": "x"}), 404)
    err(api.patch_task(user, b["id"], {"title": "x"}), 404)
    assert ok_json(api.get_task(user, a["id"])) == a
    assert ok_json(api.get_task(other, b["id"])) == b


def test_ac15_owner_can_still_patch_after_foreign_attempt(api, user, other):
    t = api.task(user)
    err(api.patch_task(other, t["id"], {"title": "x"}), 404)
    r = api.patch_task(user, t["id"], {"status": "done"})
    assert r.status_code == 200 and r.json()["status"] == "done"


# =============================================================================== AC-16
@pytest.mark.parametrize("tid", [999999, 0, -1])
def test_ac16_get_nonexistent_integer_id_returns_404_for_user(api, user, tid):
    err(api.get_task(user, tid), 404)


@pytest.mark.parametrize("tid", [999999, 0, -1])
def test_ac16_get_nonexistent_integer_id_returns_404_for_admin(api, admin, tid):
    err(api.get_task(admin, tid), 404)


@pytest.mark.parametrize("tid", [999999, 0, -1])
def test_ac16_patch_nonexistent_integer_id_returns_404_for_user_and_admin(api, user, admin, tid):
    err(api.patch_task(user, tid, {"title": "x"}), 404)
    err(api.patch_task(admin, tid, {"title": "x"}), 404)


def test_ac16_non_integer_id_returns_422_on_get(api, user, admin):
    err(api.get_task(user, "abc"), 422)
    err(api.get_task(admin, "abc"), 422)


def test_ac16_non_integer_id_returns_422_on_patch(api, user, admin):
    err(api.patch_task(user, "abc", {"title": "x"}), 422)
    err(api.patch_task(admin, "abc", {"title": "x"}), 422)


# =============================================================================== AC-17
def test_ac17_patch_title_only_returns_200_full_task_and_keeps_other_fields(api, user):
    t = api.task(user, title=mk("old"), description=mk("keep"))
    new = mk("new")
    r = api.patch_task(user, t["id"], {"title": new})
    assert r.status_code == 200, r.text
    u = r.json()
    check_task(u, owner_id=user.id)
    assert u["title"] == new
    assert u["description"] == t["description"] and u["status"] == t["status"]
    assert u["id"] == t["id"] and u["created_at"] == t["created_at"]


def test_ac17_patch_description_only(api, user):
    t = api.task(user, title=mk("keep"), description="old")
    r = api.patch_task(user, t["id"], {"description": "new"})
    assert r.status_code == 200
    u = r.json()
    assert u["description"] == "new" and u["title"] == t["title"] and u["status"] == "todo"


@pytest.mark.parametrize("status", STATUSES)
def test_ac17_patch_status_only_accepts_each_allowed_value(api, user, status):
    t = api.task(user)
    r = api.patch_task(user, t["id"], {"status": status})
    assert r.status_code == 200
    u = r.json()
    assert u["status"] == status and u["title"] == t["title"] and u["description"] == t["description"]


def test_ac17_patch_all_three_fields_at_once(api, user):
    t = api.task(user)
    r = api.patch_task(user, t["id"], {"title": "T2", "description": "D2", "status": "in_progress"})
    assert r.status_code == 200
    u = r.json()
    assert (u["title"], u["description"], u["status"]) == ("T2", "D2", "in_progress")


def test_ac17_id_owner_and_created_at_never_change(api, user):
    t = api.task(user)
    for body in ({"title": "a"}, {"description": "b"}, {"status": "done"}, {"status": "todo", "title": "c"}):
        u = ok_json(api.patch_task(user, t["id"], body))
        assert u["id"] == t["id"] and u["owner_id"] == t["owner_id"] and u["created_at"] == t["created_at"]


def test_ac17_subsequent_get_equals_patch_response(api, user):
    t = api.task(user)
    u = ok_json(api.patch_task(user, t["id"], {"title": "after", "status": "done"}))
    assert ok_json(api.get_task(user, t["id"])) == u


def test_ac17_status_can_move_back_and_forth(api, user):
    t = api.task(user)
    for s in ("in_progress", "done", "todo"):
        assert ok_json(api.patch_task(user, t["id"], {"status": s}))["status"] == s


def test_ac17_boundary_values_title_200_description_2000_and_empty_description(api, user):
    t = api.task(user, description="something")
    u = ok_json(api.patch_task(user, t["id"], {"title": "t" * 200, "description": "d" * 2000}))
    assert u["title"] == "t" * 200 and u["description"] == "d" * 2000
    u = ok_json(api.patch_task(user, t["id"], {"description": ""}))
    assert u["description"] == ""


def test_ac17_patch_touches_only_the_addressed_task(api, user):
    a, b = api.task(user), api.task(user)
    ok_json(api.patch_task(user, a["id"], {"title": "only-a"}))
    assert ok_json(api.get_task(user, b["id"])) == b


# =============================================================================== AC-18
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"status": "finished"},
        {"status": ""},
        {"status": "DONE"},
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 201},
        {"title": None},
        {"description": None},
        {"status": None},
        {"title": 123},
        {"description": 123},
        {"status": 1},
        {"status": ["done"]},
        {"title": ["a"]},
        {"owner_id": 1},
        {"id": 999},
        {"created_at": "2020-01-01T00:00:00Z"},
        {"foo": "bar"},
        {"title": "ok", "owner_id": 1},
        {"title": "ok", "status": "bogus"},
        {"title": "ok", "foo": 1},
        {"status": "done", "title": ""},
    ],
    ids=[
        "empty_object", "status_finished", "status_empty", "status_DONE", "title_empty", "title_blank",
        "title_201", "title_null", "description_null", "status_null", "title_int", "description_int",
        "status_int", "status_list", "title_list", "unknown_owner_id", "unknown_id", "unknown_created_at",
        "unknown_foo", "valid_plus_owner_id", "valid_plus_bad_status", "valid_plus_foo", "status_ok_title_bad",
    ],
)
def test_ac18_invalid_patch_returns_422_and_changes_nothing(api, body):
    u = api.new_user("p18")
    t = api.task(u, title=mk("orig"), description=mk("orig-d"))
    err(api.patch_task(u, t["id"], body), 422)
    assert ok_json(api.get_task(u, t["id"])) == t


def test_ac18_owner_can_never_be_changed_by_the_owner(api, user, other):
    t = api.task(user)
    err(api.patch_task(user, t["id"], {"owner_id": other.id}), 422)
    got = ok_json(api.get_task(user, t["id"]))
    assert got["owner_id"] == user.id
    assert t["id"] not in [x["id"] for x in ok_json(api.list_tasks(other))]


# =============================================================================== AC-19
def test_ac19_admin_list_contains_tasks_of_all_users(api, admin, user, other):
    t1, t2, t3 = api.task(user), api.task(other), api.task(admin)
    r = api.list_tasks(admin)
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    by_id = {t["id"]: t for t in body}
    for t in (t1, t2, t3):
        assert by_id.get(t["id"]) == t
    assert {user.id, other.id, admin.id} <= {t["owner_id"] for t in body}


def test_ac19_admin_list_is_ordered_by_id_ascending(api, admin, user, other):
    api.task(user)
    api.task(other)
    api.task(admin)
    api.task(user)
    ids = [t["id"] for t in ok_json(api.list_tasks(admin))]
    assert ids == sorted(ids)
    assert len(ids) == len(set(ids))


def test_ac19_admin_list_elements_have_the_task_fields(api, admin, user):
    api.task(user)
    body = ok_json(api.list_tasks(admin))
    assert body
    for t in body:
        check_task(t)


def test_ac19_admin_sees_newly_created_foreign_task_but_users_still_do_not(api, admin, user, other):
    t = api.task(user)
    assert t["id"] in [x["id"] for x in ok_json(api.list_tasks(admin))]
    assert t["id"] not in [x["id"] for x in ok_json(api.list_tasks(other))]


# =============================================================================== AC-20
def test_ac20_admin_can_get_any_users_task(api, admin, user):
    t = api.task(user, title=mk("t"), description=mk("d"))
    r = api.get_task(admin, t["id"])
    assert r.status_code == 200
    assert r.json() == t


def test_ac20_admin_patch_is_applied_and_owner_stays_original(api, admin, user):
    t = api.task(user, title=mk("t"), description=mk("d"))
    new_title = mk("by-admin")
    r = api.patch_task(admin, t["id"], {"title": new_title, "status": "done"})
    assert r.status_code == 200, r.text
    u = r.json()
    check_task(u, owner_id=user.id)
    assert u["owner_id"] != admin.id
    assert u["title"] == new_title and u["status"] == "done" and u["description"] == t["description"]
    assert u["id"] == t["id"] and u["created_at"] == t["created_at"]


def test_ac20_owner_sees_the_admins_change_and_still_owns_the_task(api, admin, user):
    t = api.task(user)
    ok_json(api.patch_task(admin, t["id"], {"description": "edited by admin"}))
    got = ok_json(api.get_task(user, t["id"]))
    assert got["description"] == "edited by admin"
    assert got["owner_id"] == user.id
    assert t["id"] in [x["id"] for x in ok_json(api.list_tasks(user))]


def test_ac20_admin_cannot_take_ownership_via_owner_id(api, admin, user):
    t = api.task(user)
    err(api.patch_task(admin, t["id"], {"owner_id": admin.id}), 422)
    assert ok_json(api.get_task(user, t["id"]))["owner_id"] == user.id


def test_ac20_admin_edit_does_not_make_the_task_the_admins_in_admin_list(api, admin, user):
    t = api.task(user)
    ok_json(api.patch_task(admin, t["id"], {"title": mk("x")}))
    by_id = {x["id"]: x for x in ok_json(api.list_tasks(admin))}
    assert by_id[t["id"]]["owner_id"] == user.id


def test_ac20_admin_gets_and_patches_every_users_task(api, admin, user, other):
    ts = [api.task(user), api.task(other)]
    for t in ts:
        assert api.get_task(admin, t["id"]).status_code == 200
        r = api.patch_task(admin, t["id"], {"status": "in_progress"})
        assert r.status_code == 200 and r.json()["owner_id"] == t["owner_id"]


# =============================================================================== AC-21
# `command` criterion in the PRD (repo unit test). Over HTTP: the service answers
# requests at once with its tables in place, under /v1, with no setup step.
def test_ac21_service_serves_first_requests_with_tables_in_place(api):
    u = api.new_user("boot")  # needs the users table (+ token storage)
    t = api.task(u)  # needs the tasks table
    assert ok_json(api.list_tasks(u)) == [t]


def test_ac21_endpoints_live_under_v1(client):
    assert client.get("/v1/tasks").status_code == 401  # route exists and is protected
    assert client.post("/v1/login", json={}).status_code == 422
    assert client.post("/v1/register", json={}).status_code == 422
    assert client.post("/v1/logout").status_code == 401


# =============================================================================== AC-22
# `command` criterion (scrypt verifier / salt / constant time are not visible over HTTP);
# the externally observable consequences are probed.
def test_ac22_no_response_ever_contains_the_plaintext_password(api):
    pw = "Plain-" + uuid.uuid4().hex
    email = unique_email()
    texts = []
    r = api.register(email, pw)
    texts.append(r.text)
    lr = api.login(email, pw)
    texts.append(lr.text)
    tok = lr.json()["access_token"]
    t = api.create_task(tok, {"title": "x"})
    texts.append(t.text)
    tid = t.json()["id"]
    texts.append(api.list_tasks(tok).text)
    texts.append(api.get_task(tok, tid).text)
    texts.append(api.patch_task(tok, tid, {"status": "done"}).text)
    texts.append(api.register(email, pw).text)  # 409 body
    texts.append(api.login(email, pw + "x").text)  # 401 body
    for txt in texts:
        assert pw not in txt


def test_ac22_same_password_for_two_users_both_authenticate_and_stay_separate(api):
    pw = "shared-password-" + uuid.uuid4().hex[:8]
    a, b = api.new_user("sa", pw), api.new_user("sb", pw)
    assert a.token != b.token
    ta, tb = api.task(a), api.task(b)
    assert ta["owner_id"] == a.id and tb["owner_id"] == b.id and a.id != b.id
    assert api.login(a.email, pw).status_code == 200 and api.login(b.email, pw).status_code == 200
    assert [t["id"] for t in ok_json(api.list_tasks(a))] == [ta["id"]]
    assert [t["id"] for t in ok_json(api.list_tasks(b))] == [tb["id"]]


def test_ac22_all_128_characters_of_the_password_count(api):
    pw = "a" * 127 + "b"
    email = unique_email()
    assert api.register(email, pw).status_code == 201
    assert api.login(email, pw).status_code == 200
    err(api.login(email, "a" * 127 + "c"), 401)
    err(api.login(email, "a" * 64), 401)
    err(api.login(email, "a" * 127), 401)


def test_ac22_characters_beyond_position_72_count(api):
    pw = "a" * 72 + "b"
    email = unique_email()
    assert api.register(email, pw).status_code == 201
    assert api.login(email, pw).status_code == 200
    err(api.login(email, "a" * 72 + "c"), 401)


def test_ac22_near_miss_passwords_are_rejected(api):
    email = unique_email()
    pw = "Correct-Horse-9"
    assert api.register(email, pw).status_code == 201
    for bad in (pw.lower(), pw.upper(), pw + " ", " " + pw, pw[:-1], pw + "x"):
        err(api.login(email, bad), 401)
    assert api.login(email, pw).status_code == 200


# =============================================================================== AC-23
def _logins(api, user, n):
    return [api.new_token(user) for _ in range(n)]


def test_ac23_tokens_are_long_opaque_strings(api, user):
    tokens = [user.token] + _logins(api, user, 5)
    for tok in tokens:
        assert isinstance(tok, str)
        assert len(tok) >= 43  # >= 32 bytes of entropy needs >= 43 base64url chars (64 hex chars)
        assert tok.isascii() and tok.isprintable() and not any(c.isspace() for c in tok)
        assert len(set(tok)) >= 10
        local = user.email.split("@")[0]
        assert local not in tok and user.password not in tok and user.email not in tok


def test_ac23_every_login_yields_a_new_token_across_users(api, user, other):
    tokens = [user.token, other.token] + _logins(api, user, 8) + _logins(api, other, 8)
    assert len(set(tokens)) == len(tokens)


def test_ac23_tokens_look_random_no_long_shared_prefix(api, user, other):
    tokens = [user.token, other.token] + _logins(api, user, 8)
    for i, a in enumerate(tokens):
        for b in tokens[i + 1:]:
            common = 0
            for x, y in zip(a, b):
                if x != y:
                    break
                common += 1
            assert common < 8, "tokens share a long prefix (sequential or time-based?)"


def test_ac23_stored_digest_of_a_token_is_not_a_usable_token(api, user):
    digest = hashlib.sha256(user.token.encode()).digest()
    for forged in (digest.hex(), base64.urlsafe_b64encode(digest).decode(), base64.urlsafe_b64encode(digest).decode().rstrip("=")):
        err(api.list_tasks(forged), 401)
    assert api.list_tasks(user.token).status_code == 200


def test_ac23_tampered_or_truncated_tokens_are_rejected(api, user):
    tok = user.token
    flipped = tok[:-1] + ("A" if tok[-1] != "A" else "B")
    for forged in (tok[: len(tok) // 2], tok + "x", flipped, tok.swapcase() if tok.swapcase() != tok else tok + "0"):
        err(api.list_tasks(forged), 401)
    assert api.list_tasks(tok).status_code == 200


def test_ac23_logout_makes_the_token_useless_everywhere(api, user):
    t = api.task(user)
    assert api.logout(user).status_code == 204
    for resp in (
        api.list_tasks(user),
        api.get_task(user, t["id"]),
        api.patch_task(user, t["id"], {"title": "x"}),
        api.create_task(user, {"title": "x"}),
        api.logout(user),
    ):
        err(resp, 401)


def test_x_optional_token_expiry_when_ttl_env_is_small(api):
    """Not mapped to a criterion in criteria-map.json: runs only if the harness started
    the service with a small TOKEN_TTL_SECONDS and exported the same value for the suite."""
    ttl = os.environ.get("TOKEN_TTL_SECONDS", "")
    if not ttl.isdigit() or not (1 <= int(ttl) <= 30):
        pytest.skip("TOKEN_TTL_SECONDS (1..30) not exported to the suite")
    u = api.new_user("ttl")
    assert api.list_tasks(u).status_code == 200
    time.sleep(int(ttl) + 2)
    err(api.list_tasks(u), 401)


# =============================================================================== AC-24
# `command` criterion (Alembic migration vs contracts/db-schema.json) - not observable over
# HTTP. The observable effect of the unique e-mail constraint is probed: concurrent
# duplicate registrations produce exactly one user and clean 409s, never a 5xx.
def _register_once(email, password):
    with httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=False) as c:
        return c.post("/v1/register", json={"email": email, "password": password}).status_code


def test_ac24_unique_email_holds_under_concurrent_duplicate_registration():
    email = unique_email("race")
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(lambda _: _register_once(email, USER_PASSWORD), range(6)))
    assert codes.count(201) == 1, codes
    assert all(c in (201, 409) for c in codes), codes


def test_ac24_unique_email_holds_across_case_variants_concurrently():
    local = "race-" + uuid.uuid4().hex
    variants = [f"{local}@example.com", f"{local.upper()}@EXAMPLE.COM", f"{local.capitalize()}@Example.com"] * 2
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(lambda e: _register_once(e, USER_PASSWORD), variants))
    assert codes.count(201) == 1, codes
    assert all(c in (201, 409) for c in codes), codes


def test_ac24_integer_ids_are_unique_across_many_tasks(api, user):
    ids = [api.task(user)["id"] for _ in range(10)]
    assert all(is_int(i) for i in ids) and len(set(ids)) == 10
