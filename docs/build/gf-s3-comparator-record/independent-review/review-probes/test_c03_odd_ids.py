"""Class 3: odd task ids."""
import pytest

NOT_FOUND = ["0", "-1", "999999", str(2**63 - 1), str(2**63), str(-(2**63) - 1), "-0",
             "9" * 19, "9" * 30, "9" * 4000, "-" + "9" * 4000]
NON_INT = ["abc", "1e0", "0x1", "1.5", "１", "%20", "1a", "true", "null", "1.0", "+1", "01", "%201", "1%20", "1_0"]


@pytest.fixture
def task1(client, alice):
    t = client.post("/v1/tasks", json={"title": "t"}, headers=alice["h"]).json()
    assert t["id"] == 1
    return t


@pytest.mark.parametrize("tid", NOT_FOUND, ids=lambda s: s[:22])
@pytest.mark.parametrize("who", ["alice", "admin"])
def test_nonexistent_integer_404(client, task1, alice, admin, tid, who):
    h = {"alice": alice, "admin": admin}[who]["h"]
    for r in (client.get(f"/v1/tasks/{tid}", headers=h),
              client.patch(f"/v1/tasks/{tid}", json={"title": "x"}, headers=h)):
        assert r.status_code == 404, (tid[:30], r.status_code, r.text[:160])
        assert r.json() == {"detail": "Task not found"}


@pytest.mark.parametrize("tid", NON_INT)
def test_non_canonical_or_non_integer_422(client, task1, alice, tid):
    r = client.get(f"/v1/tasks/{tid}", headers=alice["h"])
    assert r.status_code == 422, (tid, r.status_code, r.text[:160])


@pytest.mark.parametrize("tid", ["+1", "01", "%201", "1%20", "1.0", "1_0"])
def test_alias_does_not_cross_owner(client, task1, bob, tid):
    # whatever alias spellings resolve to, a foreign task is still 404
    assert client.get(f"/v1/tasks/{tid}", headers=bob["h"]).status_code in (404, 422)
    assert client.patch(f"/v1/tasks/{tid}", json={"title": "z"}, headers=bob["h"]).status_code in (404, 422)


def test_no_500_on_any_odd_id(client, task1, alice):
    for tid in NOT_FOUND + NON_INT + ["9" * 20000]:
        for m in ("get", "patch"):
            r = client.request(m, f"/v1/tasks/{tid}", json={"title": "x"}, headers=alice["h"])
            assert r.status_code < 500, (tid[:20], m, r.status_code)


@pytest.mark.parametrize("n", [4300, 4301, 5000, 20000])
def test_very_long_integer_is_404_not_422(client, task1, alice, n):
    r = client.get("/v1/tasks/" + "9" * n, headers=alice["h"])
    assert r.status_code == 404, (n, r.status_code, r.text[:120])
