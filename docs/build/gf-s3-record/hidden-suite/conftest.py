"""Fixtures and helpers for the black-box acceptance suite.

The suite drives a RUNNING service over HTTP. Configuration (environment):
  BASE_URL     e.g. http://127.0.0.1:18080          (required)
  ADMIN_EMAIL  the e-mail whose registrant becomes admin (required)

Every test registers its own uniquely named users (uuid in the e-mail), so tests
are independent of order and of whatever state a persistent server already holds.
"""
import os
import uuid

import httpx
import pytest

BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip()
USER_PASSWORD = "correct-horse-1"
ADMIN_PASSWORD = "Adm1n-Bootstrap-Pass-42"
TIMEOUT = 10.0


def unique_email(tag="u"):
    return f"{tag}-{uuid.uuid4().hex}@example.com"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


class User:
    def __init__(self, email, password, id, role, token):
        self.email = email
        self.password = password
        self.id = id
        self.role = role
        self.token = token

    @property
    def headers(self):
        return bearer(self.token)


def _h(who):
    """Accept a User, a raw token string, a header dict, or None (no auth)."""
    if who is None:
        return {}
    if isinstance(who, User):
        return who.headers
    if isinstance(who, str):
        return bearer(who)
    return dict(who)


class Api:
    """Thin wrapper over an httpx.Client; every method returns the raw Response
    unless documented otherwise."""

    def __init__(self, client):
        self.c = client

    # --- auth -------------------------------------------------------------
    def raw_register(self, body):
        return self.c.post("/v1/register", json=body)

    def register(self, email=None, password=USER_PASSWORD, **extra):
        body = {"email": email or unique_email(), "password": password}
        body.update(extra)
        return self.raw_register(body)

    def raw_login(self, body):
        return self.c.post("/v1/login", json=body)

    def login(self, email, password):
        return self.raw_login({"email": email, "password": password})

    def logout(self, who):
        return self.c.post("/v1/logout", headers=_h(who))

    def new_user(self, tag="u", password=USER_PASSWORD):
        """Register + log in a fresh user; returns a User (asserts on the way)."""
        email = unique_email(tag)
        r = self.register(email, password)
        assert r.status_code == 201, f"register failed: {r.status_code} {r.text}"
        body = r.json()
        lr = self.login(email, password)
        assert lr.status_code == 200, f"login failed: {lr.status_code} {lr.text}"
        return User(email, password, body["id"], body["role"], lr.json()["access_token"])

    def new_token(self, user):
        """A further, independent token for an existing user."""
        lr = self.login(user.email, user.password)
        assert lr.status_code == 200, f"login failed: {lr.status_code} {lr.text}"
        return lr.json()["access_token"]

    # --- tasks ------------------------------------------------------------
    def create_task(self, who, body):
        return self.c.post("/v1/tasks", json=body, headers=_h(who))

    def task(self, who, title=None, description=None):
        """Create a task, assert 201, return its JSON."""
        body = {"title": title or f"task-{uuid.uuid4().hex}"}
        if description is not None:
            body["description"] = description
        r = self.create_task(who, body)
        assert r.status_code == 201, f"create failed: {r.status_code} {r.text}"
        return r.json()

    def list_tasks(self, who):
        return self.c.get("/v1/tasks", headers=_h(who))

    def get_task(self, who, tid):
        return self.c.get(f"/v1/tasks/{tid}", headers=_h(who))

    def patch_task(self, who, tid, body):
        return self.c.patch(f"/v1/tasks/{tid}", json=body, headers=_h(who))


@pytest.fixture
def client():
    if not BASE_URL:
        pytest.fail("BASE_URL environment variable is required")
    with httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=False) as c:
        yield c


@pytest.fixture
def api(client):
    return Api(client)


@pytest.fixture
def user(api):
    return api.new_user("user")


@pytest.fixture
def other(api):
    return api.new_user("other")


@pytest.fixture(scope="session")
def admin_boot():
    """Registers the admin account once per session (tolerating that it already
    exists on a persistent server), logs in, and records what happened.

    The registration deliberately uses an UPPER-CASED variant of ADMIN_EMAIL, so
    that a first-time registration also exercises the case-insensitive match of
    the admin-bootstrap rule. Later logins use the lower-cased address, which is
    what the service stores.
    """
    if not BASE_URL:
        pytest.fail("BASE_URL environment variable is required")
    if not ADMIN_EMAIL:
        pytest.fail("ADMIN_EMAIL environment variable is required")
    variant = ADMIN_EMAIL.upper() if ADMIN_EMAIL.upper() != ADMIN_EMAIL else ADMIN_EMAIL.lower()
    with httpx.Client(base_url=BASE_URL, timeout=TIMEOUT, follow_redirects=False) as c:
        api = Api(c)
        reg = api.register(variant, ADMIN_PASSWORD)
        info = {
            "register_status": reg.status_code,
            "register_body": reg.json() if reg.headers.get("content-type", "").startswith("application/json") else None,
            "register_email_sent": variant,
        }
        if reg.status_code not in (201, 409):
            pytest.fail(f"admin registration answered {reg.status_code}: {reg.text[:300]}")
        lr = api.login(ADMIN_EMAIL.lower(), ADMIN_PASSWORD)
        if lr.status_code != 200:
            pytest.fail(
                "cannot log in as ADMIN_EMAIL with the suite's fixed admin password "
                f"(status {lr.status_code}); the account probably pre-exists with another password"
            )
        tok = lr.json()["access_token"]
        probe = api.create_task(tok, {"title": "admin-probe-" + uuid.uuid4().hex})
        if probe.status_code != 201:
            pytest.fail(f"admin could not create a task: {probe.status_code} {probe.text[:300]}")
        info["admin_id"] = probe.json()["owner_id"]
        return info


@pytest.fixture
def admin(api, admin_boot):
    """A User for the admin account with a FRESH token (so tests may log it out)."""
    token = api.new_token(User(ADMIN_EMAIL.lower(), ADMIN_PASSWORD, admin_boot["admin_id"], "admin", ""))
    return User(ADMIN_EMAIL.lower(), ADMIN_PASSWORD, admin_boot["admin_id"], "admin", token)
