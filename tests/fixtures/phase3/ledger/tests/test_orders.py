from ledger import db

# GET /orders/{id} is one query for the bearer token plus two for the order:
# the order row, then its items joined with their products.
ORDER_QUERIES = 3


def test_owner_reads_an_order_with_its_items(client, member):
    r = client.get("/api/orders/1", headers=member)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 5450
    assert body["items"] == [
        {"product_id": 1, "product_name": "lamp", "qty": 2, "price": 2500},
        {"product_id": 4, "product_name": "pen", "qty": 3, "price": 150},
    ]


def test_admin_reads_any_order(client, admin):
    assert client.get("/api/orders/2", headers=admin).json()["user_id"] == 4


def test_orders_of_others_are_hidden(client, member):
    assert client.get("/api/orders/2", headers=member).status_code == 404
    assert client.get("/api/orders/99", headers=member).status_code == 404


def test_get_order_makes_a_fixed_number_of_queries(client, member):
    with db.count_queries(db.engine) as counter:
        assert client.get("/api/orders/1", headers=member).status_code == 200
    assert counter.count == ORDER_QUERIES, counter.statements


def test_create_order_computes_the_total(client, member):
    r = client.post("/api/orders", json={"items": [{"product_id": 2, "qty": 1}, {"product_id": 5, "qty": 4}]}, headers=member)
    assert r.status_code == 201
    body = r.json()
    assert body["total"] == 12000 + 4 * 450
    assert [i["product_name"] for i in body["items"]] == ["desk", "notebook"]
    assert client.get(f"/api/orders/{body['id']}", headers=member).json()["total"] == body["total"]


def test_create_order_rejects_unknown_products(client, member):
    assert client.post("/api/orders", json={"items": [{"product_id": 42, "qty": 1}]}, headers=member).status_code == 400
    assert client.post("/api/orders", json={"items": []}, headers=member).status_code == 422
