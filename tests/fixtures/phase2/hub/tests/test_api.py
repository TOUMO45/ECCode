def test_orders_list(client):
    body = client.get("/api/orders").json()
    assert [o["id"] for o in body["orders"]] == [1, 2, 3]


def test_order_total_includes_tax(client):
    assert client.get("/api/orders/2").json()["total_cents"] == 1199


def test_unknown_order(client):
    assert client.get("/api/orders/99").status_code == 404


def test_health(client):
    assert client.get("/api/health/ping").json()["status"] == "ok"
    assert client.get("/api/health/version").json()["version"] == "1.0"


def test_tree_depth(client):
    body = {"name": "leaf", "parent": {"name": "mid", "parent": {"name": "root", "parent": None}}}
    assert client.post("/api/trees", json=body).json()["depth"] == 3
