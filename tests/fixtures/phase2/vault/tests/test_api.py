ID1 = "00000000-0000-4000-8000-000000000001"


def test_item_exists(client):
    assert client.get(f"/api/items/{ID1}").json()["name"] == "bolt"


def test_unknown_item(client):
    assert client.get("/api/items/00000000-0000-4000-8000-0000000000ff").status_code == 404


def test_account(client):
    r = client.post("/api/accounts", json={"email": "A@B.test", "display_name": " Ann "})
    assert r.status_code == 201 and r.json()["display_name"]


def test_signup(client):
    assert client.post("/api/signup", json={"password": "longenough", "passwordConfirm": "longenough"}).json()["ok"]
    assert client.post("/api/signup", json={"password": "longenough", "passwordConfirm": "other"}).status_code == 422


def test_slot(client):
    assert client.get("/api/slots", params={"at": "13:00:00"}).json()["slot"] in (0, 1, 2, 3)


def test_link(client):
    assert client.post("/api/links", json={"link": "https://example.test/x"}).json()["host"] == "example.test"
