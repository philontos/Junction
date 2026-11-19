import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import upload
from fastapi.testclient import TestClient

from junction.api import create_app
from junction.errors import Problem
from junction.store import DB_VERSION, Store, new_token


def test_service_credential_can_create_but_never_replace_identities(tmp_path, monkeypatch, claude_bytes):
    service_token = new_token()
    token_file = tmp_path / "provision.token"
    token_file.write_text(service_token)
    monkeypatch.setenv("JUNCTION_PROVISIONING_TOKEN_FILE", str(token_file))
    user, token, other_user, other_token = str(uuid.uuid4()), new_token(), str(uuid.uuid4()), new_token()
    route = "/internal/users/" + user
    payload = {"token": token, "display_name": "alice"}
    service_auth = {"Authorization": "Bearer " + service_token}
    auth = {"Authorization": "Bearer " + token}
    other_auth = {"Authorization": "Bearer " + other_token}
    with TestClient(create_app(tmp_path / "data")) as client:
        assert client.put(route, json=payload).status_code == 401
        assert client.put(route, json=payload, headers=auth).status_code == 401
        for _ in range(2):
            assert client.put(route, json=payload, headers=service_auth).json() == {"user_id": user}
        assert client.put(route, json={**payload, "token": new_token()}, headers=service_auth).status_code == 409
        assert client.put(route, json={**payload, "display_name": "mallory"}, headers=service_auth).status_code == 409
        assert client.put("/internal/users/" + other_user, json=payload, headers=service_auth).status_code == 409
        assert client.put("/internal/users/not-a-uuid", json=payload, headers=service_auth).status_code == 400
        assert client.put("/internal/users/" + other_user, json={"token": other_token, "display_name": "bob"},
                          headers=service_auth).status_code == 200
        assert client.get("/v1/me", headers=auth).json() == {"user_id": user}
        assert client.get("/v1/contexts", headers=service_auth).status_code == 401
        rev, path = upload(client, auth, claude_bytes)
        assert client.get(path, headers=other_auth).status_code == 404
        assert client.get("/v1/contexts", headers=other_auth).json()["items"] == []
        # Publishing does not change authorship or grant raw-source access.
        shared, shared_path = upload(client, auth, claude_bytes, context_id=rev["context_id"], shared=True)
        meta = client.get(shared_path, headers=other_auth).json()
        assert meta["owner_id"] == user and meta["owner_name"] == "alice"
        assert not meta["access"]["owner"] and not meta["access"]["raw"]
        assert client.get(shared_path + "/raw", headers=other_auth).status_code == 404
        listed = client.get("/v1/contexts", headers=other_auth).json()["items"][0]
        assert listed["owner_id"] == user and listed["owner_name"] == "alice"
        assert client.post(shared_path + "/publish", headers=other_auth).status_code in {404, 405}
    with TestClient(create_app(tmp_path / "data")) as client:
        assert client.put(route, json=payload, headers=service_auth).status_code == 200
        assert client.get("/v1/me", headers=auth).json()["user_id"] == user


def test_provisioning_disabled_without_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv("JUNCTION_PROVISIONING_TOKEN_FILE", raising=False)
    with TestClient(create_app(tmp_path)) as client:
        response = client.put("/internal/users/" + str(uuid.uuid4()),
                              json={"token": new_token(), "display_name": "alice"})
        assert response.status_code == 404


def test_concurrent_provisioning_has_one_identity_and_no_rotation(tmp_path):
    store = Store(tmp_path)
    user, token = str(uuid.uuid4()), new_token()
    with ThreadPoolExecutor(max_workers=6) as pool:
        result = list(pool.map(lambda _: store.provision_user(user, token, "alice"), range(12)))
    assert all(r == {"user_id": user} for r in result)
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    with pytest.raises(Problem):
        store.provision_user(user, new_token(), "alice")
    assert store.authenticate(token) == user


def test_schema_six_migration_preserves_owner_identity_and_archives(tmp_path, claude_bytes):
    store = Store(tmp_path)
    token = new_token()
    store.add_user("legacy", token)
    rev = store.import_bytes("legacy", claude_bytes, "claude")
    with store.connection(write=True) as db:
        db.execute("DROP TABLE user_profiles")
        db.execute("PRAGMA user_version=6")
    migrated = Store(tmp_path)
    assert migrated.authenticate(token) == "legacy"
    ctx = migrated.get_context("legacy", rev["context_id"])
    assert ctx["owner_id"] == "legacy" and ctx["owner_name"] == "legacy"
    assert ctx["revision"]["id"] == rev["id"]
    assert migrated.check()["ok"]
    with migrated.connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == DB_VERSION
