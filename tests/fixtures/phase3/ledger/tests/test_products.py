def test_list_products_sorted_by_name(client, viewer):
    r = client.get("/api/products", headers=viewer)
    assert r.status_code == 200
    assert [p["name"] for p in r.json()] == ["chair", "desk", "lamp", "lamp shade", "notebook", "pen"]
    assert r.json()[2] == {"id": 1, "name": "lamp", "sku": "LAMP-01", "price": 2500}


def test_search_products_by_name(client, member):
    assert [p["sku"] for p in client.get("/api/products", params={"q": "lamp"}, headers=member).json()] == ["LAMP-01", "LAMP-02"]
    assert client.get("/api/products", params={"q": "zzz"}, headers=member).json() == []


def test_admin_creates_a_product(client, admin):
    r = client.post("/api/products", json={"name": "mug", "sku": "MUG-01", "price": 700}, headers=admin)
    assert r.status_code == 201
    assert r.json()["sku"] == "MUG-01"
    assert "MUG-01" in [p["sku"] for p in client.get("/api/products", headers=admin).json()]


def test_members_cannot_create_products(client, member):
    assert client.post("/api/products", json={"name": "mug", "sku": "MUG-02", "price": 700}, headers=member).status_code == 403


def test_duplicate_sku_is_a_conflict(client, admin):
    assert client.post("/api/products", json={"name": "lamp copy", "sku": "LAMP-01", "price": 1}, headers=admin).status_code == 409
    assert len(client.get("/api/products", headers=admin).json()) == 6
