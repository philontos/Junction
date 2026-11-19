import sqlite3

import pytest
from conftest import upload
from test_cli import cli

from junction.errors import Problem
from junction.store import DB_VERSION, Store, new_token


def bearer(token):
    return {"Authorization": "Bearer " + token}


def test_devices_share_user_ownership_but_rotate_and_revoke_independently(service, claude_bytes):
    client, store, users = service
    first, second, other = new_token(), new_token(), new_token()
    store.add_device("alice", "laptop", first, label="Alice laptop")
    store.add_device("alice", "desktop", second)
    store.add_device("bob", "laptop", other)
    assert client.get("/v1/me", headers=bearer(first)).json() == {"user_id": "alice", "device_id": "laptop"}
    assert client.get("/v1/me", headers=users["alice"]).json() == {"user_id": "alice"}
    snapshot, base = upload(client, bearer(first), claude_bytes)
    assert client.get(base, headers=bearer(second)).status_code == 200
    assert client.get(base, headers=bearer(other)).status_code == 404
    assert client.put(base + "/publication", headers=bearer(second)).status_code == 200
    assert client.get(base, headers=bearer(other)).status_code == 200
    assert client.get("/v1/contexts").status_code == 401
    replacement = new_token()
    store.add_device("alice", "laptop", replacement, rotate=True)
    assert client.get("/v1/me", headers=bearer(first)).status_code == 401
    assert client.get("/v1/me", headers=bearer(replacement)).status_code == 200
    store.revoke_device("alice", "laptop")
    store.revoke_device("alice", "laptop")  # idempotent
    assert client.get("/v1/me", headers=bearer(replacement)).status_code == 401
    assert client.get(base, headers=bearer(second)).status_code == 200
    assert client.get("/v1/me", headers=bearer(other)).status_code == 200
    rows = store.devices("alice")
    assert len(rows) == 2 and rows[0]["revoked_at"]
    assert rows[0]["label"] == "Alice laptop"
    assert all("token_hash" not in row for row in rows)
    assert client.get(base, headers=bearer(second)).json()["id"] == snapshot["context_id"]


def test_device_administration_is_explicit_and_private(tmp_path):
    cli(tmp_path, "user-add", "alice", "--output-token", "owner.token")
    output = cli(tmp_path, "device-add", "alice", "node-a", "--output-token", "a.token")
    assert output["device_id"] == "node-a"
    assert (tmp_path / "a.token").stat().st_mode & 0o777 == 0o600
    old = (tmp_path / "a.token").read_text()
    assert old.strip() not in str(output)
    error = cli(tmp_path, "device-add", "alice", "node-a", "--output-token", "failed.token", ok=False)
    assert error["error"]["code"] == "device_exists"
    assert not (tmp_path / "failed.token").exists()
    cli(tmp_path, "device-add", "alice", "node-a", "--output-token", "a.token", "--rotate", ok=False)
    assert (tmp_path / "a.token").read_text() == old
    cli(tmp_path, "device-add", "alice", "node-a", "--output-token", "rotated.token", "--rotate")
    cli(tmp_path, "device-revoke", "alice", "node-a")
    listed = cli(tmp_path, "device-list", "alice")
    assert listed["items"][0]["revoked_at"]
    assert "token" not in str(listed)
    with pytest.raises(Problem):
        Store(tmp_path / ".local/data").authenticate(old.strip())


def test_v5_upgrade_and_backup_keep_legacy_ownership_and_revocation(tmp_path, claude_bytes):
    root = tmp_path / "data"
    store = Store(root)
    original = new_token()
    store.add_user("alice", original)
    snapshot = store.import_bytes("alice", claude_bytes, "claude", shared=True)
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE device_credentials")
        db.execute("PRAGMA user_version=5")
    upgraded = Store(root)
    assert upgraded.authenticate(original) == "alice"
    active, revoked = new_token(), new_token()
    upgraded.add_device("alice", "active", active)
    upgraded.add_device("alice", "revoked", revoked)
    upgraded.revoke_device("alice", "revoked")
    destination = tmp_path / "backup"
    upgraded.backup(destination)
    restored = Store(destination)
    assert restored.check()["ok"]
    assert restored.authenticate_identity(active) == {"user_id": "alice", "device_id": "active"}
    with pytest.raises(Problem):
        restored.authenticate(revoked)
    with restored.connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == DB_VERSION
        assert db.execute("SELECT id FROM revisions").fetchone()[0] == snapshot["id"]
    assert restored.verified_raw(snapshot["source_sha256"]) == claude_bytes


@pytest.mark.parametrize("device,label", [("../bad", ""), ("a" * 65, ""), ("valid", "bad\nlabel")])
def test_device_metadata_validation(service, device, label):
    _, store, _ = service
    with pytest.raises(Problem) as error:
        store.add_device("alice", device, new_token(), label=label)
    assert error.value.status == 400
