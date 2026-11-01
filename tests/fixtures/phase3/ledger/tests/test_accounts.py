def test_member_lists_own_accounts(client, member):
    r = client.get("/api/accounts", headers=member)
    assert r.status_code == 200
    assert [a["id"] for a in r.json()] == [1, 2]
    a = r.json()[0]
    assert (a["id"], a["owner_id"], a["name"], a["balance"]) == (1, 2, "checking", 10000)


def test_admin_lists_every_account(client, admin):
    assert [a["id"] for a in client.get("/api/accounts", headers=admin).json()] == [1, 2, 3, 4]


def test_viewer_has_no_accounts(client, viewer):
    assert client.get("/api/accounts", headers=viewer).json() == []


def test_owner_reads_an_account(client, member):
    r = client.get("/api/accounts/2", headers=member)
    assert r.status_code == 200
    assert r.json()["balance"] == 5000


def test_unknown_account_is_404(client, admin):
    assert client.get("/api/accounts/99", headers=admin).status_code == 404


def test_owner_renames_an_account(client, member):
    r = client.patch("/api/accounts/1", json={"name": "main"}, headers=member)
    assert r.status_code == 200
    assert r.json()["name"] == "main"
    assert client.get("/api/accounts/1", headers=member).json()["name"] == "main"


def test_viewer_cannot_rename(client, viewer):
    assert client.patch("/api/accounts/1", json={"name": "x"}, headers=viewer).status_code == 403


def test_owner_deletes_an_account(client, member2):
    assert client.delete("/api/accounts/4", headers=member2).status_code == 204
    assert client.get("/api/accounts/4", headers=member2).status_code == 404
    assert [a["id"] for a in client.get("/api/accounts", headers=member2).json()] == [3]


def test_admin_deletes_any_account(client, admin):
    assert client.delete("/api/accounts/3", headers=admin).status_code == 204
    assert client.get("/api/accounts/3", headers=admin).status_code == 404
