"""Class 4: mass assignment on register, create and patch."""
import pytest

from conftest import PW, uniq

EXTRA = {"owner_id": 999, "id": 777, "created_at": "2000-01-01T00:00:00Z", "role": "admin", "is_admin": True,
         "status": "done", "user": {"role": "admin"}, "owner": {"id": 1}, "password_hash": "x"}


@pytest.mark.parametrize("key", ["role", "is_admin", "id", "created_at", "password_hash", "user", "owner_id"])
def test_register_extra_field_rejected_and_nothing_created(client, key):
    email = uniq()
    r = client.post("/v1/register", json={"email": email, "password": PW, key: EXTRA.get(key, "admin")})
    assert r.status_code == 422
    assert client.post("/v1/login", json={"email": email, "password": PW}).status_code == 401
    # still registrable afterwards, as a plain user
    r = client.post("/v1/register", json={"email": email, "password": PW})
    assert r.status_code == 201 and r.json()["role"] == "user"


@pytest.mark.parametrize("bad", [{"email": ["a@example.com"]}, {"email": None}, {"password": 12345678},
                                 {"password": None}, {"email": {"x": 1}}])
def test_register_wrong_types(client, bad):
    body = {"email": uniq(), "password": PW, **bad}
    assert client.post("/v1/register", json=body).status_code == 422


@pytest.mark.parametrize("key", ["owner_id", "id", "created_at", "status", "is_admin", "owner", "user"])
def test_create_extra_field_rejected(client, alice, bob, key):
    before = client.get("/v1/tasks", headers=alice["h"]).json()
    r = client.post("/v1/tasks", json={"title": "t", key: EXTRA[key] if key != "owner_id" else bob["id"]}, headers=alice["h"])
    assert r.status_code == 422
    assert client.get("/v1/tasks", headers=alice["h"]).json() == before
    assert client.get("/v1/tasks", headers=bob["h"]).json() == []


@pytest.mark.parametrize("body", [{"title": None}, {"title": 5}, {"title": ["x"]}, {"title": {"a": 1}},
                                  {"description": None}, {"description": 5}, {"title": True}])
def test_create_wrong_types(client, alice, body):
    b = {"title": "ok", **body}
    assert client.post("/v1/tasks", json=b, headers=alice["h"]).status_code == 422
    assert client.get("/v1/tasks", headers=alice["h"]).json() == []


@pytest.fixture
def task(client, alice):
    return client.post("/v1/tasks", json={"title": "orig", "description": "d"}, headers=alice["h"]).json()


@pytest.mark.parametrize("extra", [{"owner_id": 2}, {"id": 99}, {"created_at": "2000-01-01T00:00:00Z"},
                                   {"role": "admin"}, {"owner": {"id": 2}}, {"is_admin": True}])
@pytest.mark.parametrize("who", ["alice", "admin"])
def test_patch_extra_field_rejected_nothing_changes(client, task, alice, bob, admin, extra, who):
    h = {"alice": alice, "admin": admin}[who]["h"]
    r = client.patch(f"/v1/tasks/{task['id']}", json={"title": "changed", **extra}, headers=h)
    assert r.status_code == 422
    assert client.get(f"/v1/tasks/{task['id']}", headers=alice["h"]).json() == task


@pytest.mark.parametrize("body", [{"status": None}, {"title": None}, {"description": None}, {"status": "DONE"},
                                  {"status": "Done "}, {"status": 1}, {"title": 1}, {"description": ["x"]},
                                  {"status": ["done"]}, {"title": "   "}, {"title": "x" * 201},
                                  {"description": "x" * 2001}, {}, {"status": {"v": "done"}}])
def test_patch_invalid_values(client, task, alice, body):
    r = client.patch(f"/v1/tasks/{task['id']}", json=body, headers=alice["h"])
    assert r.status_code == 422, (body, r.status_code)
    assert client.get(f"/v1/tasks/{task['id']}", headers=alice["h"]).json() == task


def test_patch_partial_semantics(client, task, alice):
    r = client.patch(f"/v1/tasks/{task['id']}", json={"status": "in_progress"}, headers=alice["h"])
    assert r.status_code == 200
    j = r.json()
    assert j == {**task, "status": "in_progress"}
    r = client.patch(f"/v1/tasks/{task['id']}", json={"title": "  new  "}, headers=alice["h"])
    assert r.json()["title"] == "new" and r.json()["description"] == "d"


def test_role_not_changeable_by_login_body(client):
    email = uniq()
    client.post("/v1/register", json={"email": email, "password": PW})
    assert client.post("/v1/login", json={"email": email, "password": PW, "role": "admin"}).status_code == 422
