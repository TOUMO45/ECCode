from concurrent.futures import ThreadPoolExecutor


def balances(client, headers):
    return {a["id"]: a["balance"] for a in client.get("/api/accounts", headers=headers).json()}


def test_transfer_moves_money(client, member):
    r = client.post("/api/transfers", json={"from_account": 1, "to_account": 2, "amount": 2500}, headers=member)
    assert r.status_code == 201
    body = r.json()
    assert body["from_account"] == 1 and body["to_account"] == 2 and body["amount"] == 2500
    assert "created_at" in body
    assert balances(client, member) == {1: 7500, 2: 7500}


def test_transfer_to_another_users_account(client, member, member2):
    assert client.post("/api/transfers", json={"from_account": 1, "to_account": 3, "amount": 100}, headers=member).status_code == 201
    assert balances(client, member2)[3] == 3100


def test_insufficient_funds_are_refused(client, member):
    r = client.post("/api/transfers", json={"from_account": 2, "to_account": 1, "amount": 5001}, headers=member)
    assert r.status_code == 400
    assert balances(client, member) == {1: 10000, 2: 5000}


def test_transfer_needs_a_positive_amount_and_two_accounts(client, member):
    assert client.post("/api/transfers", json={"from_account": 1, "to_account": 2, "amount": 0}, headers=member).status_code == 422
    assert client.post("/api/transfers", json={"from_account": 1, "to_account": 1, "amount": 1}, headers=member).status_code == 400
    assert client.post("/api/transfers", json={"from_account": 1, "to_account": 99, "amount": 1}, headers=member).status_code == 404


def test_only_the_owner_can_debit_an_account(client, member, viewer):
    assert client.post("/api/transfers", json={"from_account": 3, "to_account": 1, "amount": 1}, headers=member).status_code == 404
    assert client.post("/api/transfers", json={"from_account": 1, "to_account": 2, "amount": 1}, headers=viewer).status_code == 403


def test_concurrent_transfers_conserve_the_total(client, admin, member, member2):
    before = sum(balances(client, admin).values())

    def go(i):
        if i % 2 == 0:
            return client.post("/api/transfers", json={"from_account": 1, "to_account": 3, "amount": 300}, headers=member).status_code
        return client.post("/api/transfers", json={"from_account": 3, "to_account": 2, "amount": 200}, headers=member2).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(go, range(40)))
    assert all(s in (201, 400) for s in statuses), statuses
    assert statuses.count(201) >= 20
    assert sum(balances(client, admin).values()) == before
