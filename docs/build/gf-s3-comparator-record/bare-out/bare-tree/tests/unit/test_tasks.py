import re
from datetime import datetime, timezone

import pytest

TASK_FIELDS = {"id", "title", "description", "status", "owner_id", "created_at"}


def create(client, user, **body):
    body.setdefault("title", "Write the report")
    r = client.post("/v1/tasks", json=body, headers=user["h"])
    assert r.status_code == 201, r.text
    return r.json()


def list_ids(client, user):
    r = client.get("/v1/tasks", headers=user["h"])
    assert r.status_code == 200
    return [t["id"] for t in r.json()]


def test_create_task(client, alice):
    r = client.post("/v1/tasks", json={"title": "  Write the report  ", "description": "Q4 numbers"}, headers=alice["h"])
    assert r.status_code == 201
    t = r.json()
    assert set(t) == TASK_FIELDS
    assert isinstance(t["id"], int)
    assert t["title"] == "Write the report"
    assert t["description"] == "Q4 numbers"
    assert t["status"] == "todo"
    assert t["owner_id"] == alice["id"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", t["created_at"])
    created = datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
    assert abs((datetime.now(timezone.utc) - created).total_seconds()) < 60


def test_create_default_description(client, alice):
    assert create(client, alice, title="x")["description"] == ""


def test_create_bounds(client, alice):
    assert create(client, alice, title="t" * 200, description="d" * 2000)["title"] == "t" * 200


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"description": "x"},
        {"title": ""},
        {"title": "   "},
        {"title": "t" * 201},
        {"title": 5},
        {"title": None},
        {"title": ["x"]},
        {"title": "ok", "description": "d" * 2001},
        {"title": "ok", "description": 7},
        {"title": "ok", "owner_id": 1},
        {"title": "ok", "id": 1},
        {"title": "ok", "status": "done"},
        {"title": "ok", "created_at": "2020-01-01T00:00:00Z"},
        {"title": "ok", "foo": "bar"},
    ],
)
def test_create_invalid(client, alice, body):
    r = client.post("/v1/tasks", json=body, headers=alice["h"])
    assert r.status_code == 422
    assert "detail" in r.json()
    assert list_ids(client, alice) == []


def test_create_body_not_object(client, alice):
    assert client.post("/v1/tasks", json=["x"], headers=alice["h"]).status_code == 422


def test_list_own_tasks_ordered(client, alice, bob):
    assert client.get("/v1/tasks", headers=alice["h"]).json() == []
    a1 = create(client, alice, title="a1")
    b1 = create(client, bob, title="b1")
    a2 = create(client, alice, title="a2")
    r = client.get("/v1/tasks", headers=alice["h"])
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert body == [a1, a2]
    assert all(set(t) == TASK_FIELDS for t in body)
    assert client.get("/v1/tasks", headers=bob["h"]).json() == [b1]


def test_read_own_task(client, alice):
    t = create(client, alice, title="mine", description="desc")
    r = client.get(f"/v1/tasks/{t['id']}", headers=alice["h"])
    assert r.status_code == 200
    assert r.json() == t


def test_bola_read_is_404_without_leak(client, alice, bob):
    t = create(client, alice, title="secret-title-xyz", description="secret-desc-xyz")
    foreign = client.get(f"/v1/tasks/{t['id']}", headers=bob["h"])
    unknown = client.get("/v1/tasks/999999", headers=bob["h"])
    assert foreign.status_code == 404
    assert foreign.json() == unknown.json()
    assert set(foreign.json()) == {"detail"}
    assert "secret" not in foreign.text
    assert str(alice["id"]) not in foreign.json()["detail"]


@pytest.mark.parametrize("body", [{"title": "hacked"}, {"status": "done"}, {"description": "x"}, {}])
def test_bola_write_is_404_and_changes_nothing(client, alice, bob, body):
    t = create(client, alice, title="orig", description="orig-desc")
    r = client.patch(f"/v1/tasks/{t['id']}", json=body, headers=bob["h"])
    assert r.status_code in (404, 422)
    if body:
        assert r.status_code == 404
        unknown = client.patch("/v1/tasks/999999", json=body, headers=bob["h"])
        assert r.json() == unknown.json()
        assert "orig" not in r.text
    assert client.get(f"/v1/tasks/{t['id']}", headers=alice["h"]).json() == t


@pytest.mark.parametrize("task_id", ["999999", "0", "-1", "99999999999999999999999"])
def test_unknown_ids_404_for_everyone(client, alice, admin, task_id):
    create(client, alice)
    for user in (alice, admin):
        assert client.get(f"/v1/tasks/{task_id}", headers=user["h"]).status_code == 404
        assert client.patch(f"/v1/tasks/{task_id}", json={"title": "x"}, headers=user["h"]).status_code == 404


@pytest.mark.parametrize("task_id", ["abc", "1.5"])
def test_non_integer_id_422(client, alice, task_id):
    assert client.get(f"/v1/tasks/{task_id}", headers=alice["h"]).status_code == 422
    assert client.patch(f"/v1/tasks/{task_id}", json={"title": "x"}, headers=alice["h"]).status_code == 422


@pytest.mark.parametrize(
    "patch",
    [
        {"title": "  new title "},
        {"description": "new desc"},
        {"description": ""},
        {"status": "in_progress"},
        {"status": "done"},
        {"status": "todo"},
        {"title": "n", "description": "d", "status": "done"},
    ],
)
def test_patch_by_owner(client, alice, patch):
    t = create(client, alice, title="orig", description="orig-desc")
    r = client.patch(f"/v1/tasks/{t['id']}", json=patch, headers=alice["h"])
    assert r.status_code == 200
    body = r.json()
    expected = dict(t)
    for k, v in patch.items():
        expected[k] = v.strip() if k == "title" else v
    assert body == expected
    assert client.get(f"/v1/tasks/{t['id']}", headers=alice["h"]).json() == expected


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"status": "archived"},
        {"status": "DONE"},
        {"title": ""},
        {"title": "   "},
        {"title": "t" * 201},
        {"description": "d" * 2001},
        {"title": None},
        {"description": None},
        {"status": None},
        {"title": 1},
        {"description": 2},
        {"status": 3},
        {"owner_id": 999},
        {"title": "ok", "owner_id": 999},
        {"id": 5},
        {"created_at": "2020-01-01T00:00:00Z"},
        {"title": "ok", "unknown": True},
    ],
)
def test_patch_invalid(client, alice, admin, patch):
    t = create(client, alice, title="orig", description="orig-desc")
    for user in (alice, admin):
        r = client.patch(f"/v1/tasks/{t['id']}", json=patch, headers=user["h"])
        assert r.status_code == 422, (patch, r.text)
        assert "detail" in r.json()
    assert client.get(f"/v1/tasks/{t['id']}", headers=alice["h"]).json() == t


def test_patch_non_object(client, alice):
    t = create(client, alice)
    assert client.patch(f"/v1/tasks/{t['id']}", json=["x"], headers=alice["h"]).status_code == 422
    assert client.patch(f"/v1/tasks/{t['id']}", json="x", headers=alice["h"]).status_code == 422


def test_admin_lists_all(client, alice, bob, admin):
    a = create(client, alice, title="a")
    b = create(client, bob, title="b")
    c = create(client, admin, title="c")
    r = client.get("/v1/tasks", headers=admin["h"])
    assert r.status_code == 200
    assert r.json() == [a, b, c]
    assert list_ids(client, alice) == [a["id"]]


def test_admin_reads_and_edits_any_task(client, alice, admin):
    t = create(client, alice, title="orig")
    r = client.get(f"/v1/tasks/{t['id']}", headers=admin["h"])
    assert r.status_code == 200 and r.json() == t
    r = client.patch(f"/v1/tasks/{t['id']}", json={"title": "by admin", "status": "done"}, headers=admin["h"])
    assert r.status_code == 200
    assert r.json()["owner_id"] == alice["id"]
    seen = client.get(f"/v1/tasks/{t['id']}", headers=alice["h"]).json()
    assert seen == {**t, "title": "by admin", "status": "done"}
    assert t["id"] in list_ids(client, alice)
    assert t["id"] not in [x["id"] for x in client.get("/v1/tasks", headers=admin["h"]).json() if x["owner_id"] == admin["id"]]


def test_unknown_route_json_error(client):
    r = client.get("/v1/nope")
    assert r.status_code == 404
    assert "detail" in r.json()
