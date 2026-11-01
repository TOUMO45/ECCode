def test_summary_report(client, viewer):
    r = client.get("/api/reports/summary", headers=viewer)
    assert r.status_code == 200
    assert r.json() == {"name": "summary", "text": "Ledger: 4 users, 4 accounts, 6 products."}


def test_balances_report_and_unknown_report(client, member):
    assert client.get("/api/reports/balances", headers=member).json()["text"] == "Total balance across all accounts: 19500."
    assert client.get("/api/reports/secret", headers=member).status_code == 404


def test_static_file_is_served(client, member):
    r = client.get("/api/files/readme.txt", headers=member)
    assert r.status_code == 200
    assert r.text.startswith("ledger fixture")


def test_path_traversal_is_rejected(client, member):
    assert client.get("/api/files/../pyproject.toml", headers=member).status_code == 404
    assert client.get("/api/files/..%2F..%2Fpyproject.toml", headers=member).status_code == 404
    assert client.get("/api/files/missing.txt", headers=member).status_code == 404


def test_fetch_allows_public_hosts(client, member):
    assert client.post("/api/fetch", json={"url": "https://example.com/data.json"}, headers=member).json() == {"allowed": True}


def test_fetch_blocks_private_and_loopback_hosts(client, member):
    for url in ("http://127.0.0.1/", "http://localhost:8000/", "http://10.0.0.5/x", "http://169.254.169.254/latest", "http://[::1]/", "http://192.168.1.1/"):
        assert client.post("/api/fetch", json={"url": url}, headers=member).json() == {"allowed": False}, url


def test_fetch_blocks_other_schemes(client, member):
    assert client.post("/api/fetch", json={"url": "file:///etc/passwd"}, headers=member).json() == {"allowed": False}
