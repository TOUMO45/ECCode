def test_login_returns_the_token(client):
    r = client.post("/api/auth/login", json={"username": "bob", "password": "bob-pass"})
    assert r.status_code == 200
    assert r.json() == {"token": "tok-member"}


def test_login_rejects_a_wrong_password(client):
    assert client.post("/api/auth/login", json={"username": "bob", "password": "nope"}).status_code == 401


def test_requests_without_a_token_are_rejected(client):
    assert client.get("/api/accounts").status_code == 401
    assert client.get("/api/accounts", headers={"Authorization": "Bearer tok-nobody"}).status_code == 401


def test_logout_invalidates_the_token_until_the_next_login(client, member2):
    assert client.get("/api/accounts", headers=member2).status_code == 200
    assert client.post("/api/auth/logout", headers=member2).status_code == 204
    assert client.get("/api/accounts", headers=member2).status_code == 401
    assert client.post("/api/auth/login", json={"username": "cam", "password": "cam-pass"}).status_code == 200
    assert client.get("/api/accounts", headers=member2).status_code == 200


def test_reset_request_returns_a_token(client):
    r = client.post("/api/auth/reset/request", json={"username": "cam"})
    assert r.status_code == 200
    assert r.json()["reset_token"].startswith("reset-")
    assert client.post("/api/auth/reset/request", json={"username": "nobody"}).status_code == 404


def test_reset_confirm_changes_the_password(client):
    token = client.post("/api/auth/reset/request", json={"username": "cam"}).json()["reset_token"]
    assert client.post("/api/auth/reset/confirm", json={"token": token, "password": "new-pass"}).status_code == 200
    assert client.post("/api/auth/login", json={"username": "cam", "password": "cam-pass"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "cam", "password": "new-pass"}).status_code == 200


def test_reset_confirm_rejects_an_unknown_token(client):
    assert client.post("/api/auth/reset/confirm", json={"token": "reset-unknown", "password": "x"}).status_code == 400
