def test_list_first_page(client):
    r = client.get("/items")
    assert r.status_code == 200
    assert [i["name"] for i in r.json()["items"]][:3] == ["apple", "banana", "carrot"]
    assert r.json()["total"] == 7


def test_get_item(client):
    assert client.get("/items/1").json()["name"] == "apple"


def test_missing_item(client):
    assert client.get("/items/999").status_code in (400, 404)


def test_create_item_needs_admin(client):
    assert client.post("/items", json={"name": "kiwi", "price_cents": 90}).status_code == 403
    r = client.post("/items", json={"name": " Kiwi  Fruit", "price_cents": 90}, headers={"X-Role": "admin"})
    assert r.status_code == 201
    assert r.json()["name"] == "kiwi fruit"


def test_user_view_hides_email(client):
    r = client.get("/users/2", headers={"X-Role": "user"})
    assert r.status_code == 200
    assert r.json()["name"] == "bob"


def test_admin_sees_email(client):
    assert client.get("/users/2", headers={"X-Role": "admin"}).json()["email"] == "bob@example.test"


def test_order_total(client):
    r = client.get("/orders/1/total")
    assert r.status_code == 200
    body = r.json()
    assert body["subtotal_cents"] == 300 + 450  # 3 apples, 10 bananas at 10% off
    assert body["total_cents"] == body["subtotal_cents"] + body["tax_cents"]
