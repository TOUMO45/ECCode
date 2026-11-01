def test_user_sees_own_profile_with_email(client, member):
    r = client.get("/api/users/2", headers=member)
    assert r.status_code == 200
    body = r.json()
    assert (body["id"], body["username"], body["role"], body["email"]) == (2, "bob", "member", "bob@example.test")


def test_admin_sees_any_users_email(client, admin):
    assert client.get("/api/users/3", headers=admin).json()["email"] == "vic@example.test"
    assert client.get("/api/users/99", headers=admin).status_code == 404


def test_user_renames_themselves(client, member):
    r = client.patch("/api/users/2", json={"username": "robert"}, headers=member)
    assert r.status_code == 200
    assert r.json()["username"] == "robert"
    assert client.get("/api/users/2", headers=member).json()["username"] == "robert"


def test_user_cannot_rename_someone_else(client, member):
    assert client.patch("/api/users/4", json={"username": "x"}, headers=member).status_code == 403


def test_admin_lists_users(client, admin):
    r = client.get("/api/admin/users", headers=admin)
    assert r.status_code == 200
    assert [u["username"] for u in r.json()] == ["ann", "bob", "vic", "cam"]
    assert all("email" in u for u in r.json())
