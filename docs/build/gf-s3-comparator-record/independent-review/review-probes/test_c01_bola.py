"""Class 1: BOLA/IDOR."""
import statistics
import time

import pytest

UNKNOWN = 999999
VOLATILE = {"date"}


def comparable(r):
    return r.status_code, r.content, {k: v for k, v in r.headers.items() if k.lower() not in VOLATILE}


def new_task(c, u, title="secret-title-A", desc="secret-desc-A"):
    r = c.post("/v1/tasks", json={"title": title, "description": desc}, headers=u["h"])
    assert r.status_code == 201
    return r.json()


@pytest.mark.parametrize("direction", ["a_to_b", "b_to_a"])
def test_foreign_get_identical_to_unknown(client, alice, bob, direction):
    owner, intruder = (alice, bob) if direction == "a_to_b" else (bob, alice)
    t = new_task(client, owner)
    foreign = client.get(f"/v1/tasks/{t['id']}", headers=intruder["h"])
    unknown = client.get(f"/v1/tasks/{UNKNOWN}", headers=intruder["h"])
    assert foreign.status_code == 404
    assert comparable(foreign) == comparable(unknown)
    for v in (t["title"], t["description"], str(owner["id"]), t["created_at"]):
        assert v not in foreign.text


@pytest.mark.parametrize("direction", ["a_to_b", "b_to_a"])
@pytest.mark.parametrize("body", [
    {"title": "pwned"}, {"description": "pwned"}, {"status": "done"},
    {"title": "pwned", "description": "x", "status": "in_progress"},
])
def test_foreign_patch_identical_to_unknown_and_no_change(client, alice, bob, direction, body):
    owner, intruder = (alice, bob) if direction == "a_to_b" else (bob, alice)
    t = new_task(client, owner)
    foreign = client.patch(f"/v1/tasks/{t['id']}", json=body, headers=intruder["h"])
    unknown = client.patch(f"/v1/tasks/{UNKNOWN}", json=body, headers=intruder["h"])
    assert foreign.status_code == 404
    assert comparable(foreign) == comparable(unknown)
    assert client.get(f"/v1/tasks/{t['id']}", headers=owner["h"]).json() == t


@pytest.mark.parametrize("body", [{}, {"title": ""}, {"status": "bad"}, {"owner_id": 1}, [], None])
def test_foreign_patch_invalid_body_no_oracle(client, alice, bob, body):
    t = new_task(client, alice)
    foreign = client.patch(f"/v1/tasks/{t['id']}", json=body, headers=bob["h"])
    unknown = client.patch(f"/v1/tasks/{UNKNOWN}", json=body, headers=bob["h"])
    assert foreign.status_code == unknown.status_code
    assert comparable(foreign) == comparable(unknown)
    assert client.get(f"/v1/tasks/{t['id']}", headers=alice["h"]).json() == t


def test_list_never_leaks(client, alice, bob):
    ta = [new_task(client, alice, f"a{i}", "da") for i in range(3)]
    tb = [new_task(client, bob, f"b{i}", "db") for i in range(2)]
    la = client.get("/v1/tasks", headers=alice["h"]).json()
    lb = client.get("/v1/tasks", headers=bob["h"]).json()
    assert la == ta and lb == tb
    assert all(x["owner_id"] == alice["id"] for x in la)
    assert "a0" not in str(lb)


def test_new_user_empty_list(client, alice, mk):
    new_task(client, alice)
    assert client.get("/v1/tasks", headers=mk()["h"]).json() == []


def test_admin_sees_and_edits_all(client, alice, bob, admin):
    ta = new_task(client, alice)
    tb = new_task(client, bob)
    tadm = new_task(client, admin)
    lst = client.get("/v1/tasks", headers=admin["h"]).json()
    assert [x["id"] for x in lst] == sorted([ta["id"], tb["id"], tadm["id"]])
    for t, owner in ((ta, alice), (tb, bob)):
        assert client.get(f"/v1/tasks/{t['id']}", headers=admin["h"]).json() == t
        r = client.patch(f"/v1/tasks/{t['id']}", json={"title": "by admin", "status": "done"}, headers=admin["h"])
        assert r.status_code == 200
        assert r.json()["owner_id"] == owner["id"]
        got = client.get(f"/v1/tasks/{t['id']}", headers=owner["h"]).json()
        assert got["title"] == "by admin" and got["status"] == "done" and got["owner_id"] == owner["id"]
    # admin's own task invisible to users
    assert client.get(f"/v1/tasks/{tadm['id']}", headers=alice["h"]).status_code == 404


@pytest.mark.parametrize("tid", [0, -1, 999999])
def test_admin_unknown_404(client, admin, tid):
    assert client.get(f"/v1/tasks/{tid}", headers=admin["h"]).status_code == 404
    assert client.patch(f"/v1/tasks/{tid}", json={"title": "x"}, headers=admin["h"]).status_code == 404


def test_timing_foreign_vs_unknown(client, alice, bob):
    t = new_task(client, alice)
    def med(path, n=200):
        xs = []
        for _ in range(n):
            s = time.perf_counter()
            client.get(path, headers=bob["h"])
            xs.append(time.perf_counter() - s)
        return statistics.median(xs)
    med(f"/v1/tasks/{t['id']}", 20)
    f = med(f"/v1/tasks/{t['id']}")
    u = med(f"/v1/tasks/{UNKNOWN}")
    print(f"median foreign={f*1e3:.3f}ms unknown={u*1e3:.3f}ms ratio={f/u:.3f}")
    assert 0.75 < f / u < 1.33
