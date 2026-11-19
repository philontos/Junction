import json
import sqlite3

from conftest import upload

from junction.store import DB_VERSION, Store, new_token


def test_shared_import_is_readable_without_grants_including_future_users(service, claude_bytes):
    client, store, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes, shared=True)
    token = new_token()
    store.add_user("newcomer", token)
    for headers in [auth["bob"], auth["eve"], {"Authorization": "Bearer " + token}]:
        for suffix in ["", "/messages", "/turns", "/diagnostics", "/messages/m1/content"]:
            assert client.get(path + suffix, headers=headers).status_code == 200
        assert client.get(path, headers=headers).json()["access"] == {
            "owner": False, "raw": False, "shared": True,
        }
        assert client.get(path + "/raw", headers=headers).status_code == 404
        assert client.get(path + "/grants", headers=headers).status_code == 404
        assert client.get("/v1/contexts", headers=headers).json()["items"][0]["id"] == rev["context_id"]
    assert client.get(path).status_code == 401
    assert client.get(path + "/grants", headers=auth["alice"]).json()["items"] == []
    assert client.get(path + "/raw", headers=auth["alice"]).content == claude_bytes
    assert store.export("bob", rev["context_id"], rev["id"])["session"]["messages"]
    backup = store.root.parent / "backup"
    assert store.backup(backup)["ok"]
    restored = Store(backup)
    assert restored.get_context("newcomer", rev["context_id"])["access"]["shared"]


def test_publication_is_owner_controlled_idempotent_and_does_not_remove_grants(service, claude_bytes):
    client, _, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes)
    assert client.put(path + "/publication", headers=auth["bob"]).status_code == 404
    for _ in range(2):
        assert client.put(path + "/publication", headers=auth["alice"]).json()["shared"]
    assert client.delete(path + "/publication", headers=auth["bob"]).status_code == 404
    assert client.put(path + "/publication").status_code == 401
    client.put(path + "/grants/bob", headers=auth["alice"], json={"include_raw": True})
    for _ in range(2):
        assert client.delete(path + "/publication", headers=auth["alice"]).status_code == 204
    assert client.get(path, headers=auth["eve"]).status_code == 404
    assert client.get(path + "/raw", headers=auth["bob"]).content == claude_bytes
    assert client.get(path, headers=auth["alice"]).json()["access"]["shared"] is False
    assert client.get("/v1/contexts?shared_only=true", headers=auth["bob"]).json()["items"] == []
    assert client.get("/v1/contexts", headers=auth["bob"]).json()["items"][0]["id"] == rev["context_id"]


def test_reimport_can_publish_but_never_unpublishes_or_duplicates(service, claude_bytes):
    client, store, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes, extensions=json.dumps({"test/1": {}}))
    assert client.get(path, headers=auth["bob"]).status_code == 404
    same, _ = upload(client, auth["alice"], claude_bytes, shared=True)
    assert same["id"] == rev["id"] and same["reused"]
    upload(client, auth["alice"], claude_bytes)
    assert client.get(path, headers=auth["bob"]).status_code == 200
    assert store.check()["revision_count"] == 1


def test_shared_list_pins_published_revision_even_for_owner(service, claude_bytes, codex_bytes):
    client, _, auth = service
    first, path = upload(client, auth["alice"], claude_bytes, shared=True)
    private, private_path = upload(client, auth["alice"], codex_bytes, "codex", context_id=first["context_id"])
    for user in ["alice", "bob"]:
        listing = client.get("/v1/contexts?shared_only=true", headers=auth[user]).json()["items"]
        assert listing[0]["revision"]["id"] == first["id"]
    assert client.get(private_path, headers=auth["bob"]).status_code == 404
    revisions = client.get(f"/v1/contexts/{first['context_id']}/revisions", headers=auth["bob"]).json()
    assert [r["id"] for r in revisions["items"]] == [first["id"]]
    assert client.get("/v1/contexts", headers=auth["alice"]).json()["items"][0]["revision"]["id"] == private["id"]
    client.put(private_path + "/publication", headers=auth["alice"])
    assert client.get("/v1/contexts?shared_only=true", headers=auth["bob"]).json()["items"][0]["revision"]["id"] == private["id"]
    client.delete(private_path + "/publication", headers=auth["alice"])
    assert client.get(path, headers=auth["bob"]).status_code == 200


def test_shared_list_pagination_excludes_private_and_scopes_cursors(service, claude_bytes, codex_bytes):
    client, _, auth = service
    upload(client, auth["alice"], claude_bytes, shared=True)
    upload(client, auth["alice"], codex_bytes, "codex", shared=True)
    private, _ = upload(client, auth["bob"], claude_bytes)
    first = client.get("/v1/contexts?shared_only=true&limit=1", headers=auth["bob"]).json()
    second = client.get("/v1/contexts", params={"shared_only": True, "limit": 1, "cursor": first["next_cursor"]}, headers=auth["bob"]).json()
    assert len({first["items"][0]["id"], second["items"][0]["id"], private["context_id"]}) == 3
    assert second["next_cursor"] is None
    assert client.get("/v1/contexts", params={"cursor": first["next_cursor"]}, headers=auth["bob"]).status_code == 400


def test_v1_migration_preserves_private_archives_and_grants(tmp_path, claude_bytes):
    store = Store(tmp_path / "data")
    for user in ["alice", "bob", "eve"]:
        store.add_user(user, new_token())
    rev = store.import_bytes("alice", claude_bytes, "claude")
    store.set_grant("alice", rev["context_id"], rev["id"], "bob")
    with sqlite3.connect(store.db_path) as db:
        db.execute("DROP TABLE publications")
        db.execute("PRAGMA user_version=1")
    restored = Store(store.root)
    assert restored.list_contexts("eve")["items"] == []
    assert restored.list_contexts("alice", shared_only=True)["items"] == []
    assert restored.get_context("bob", rev["context_id"])["revision"]["id"] == rev["id"]
    assert restored.read_raw("alice", rev["context_id"], rev["id"])[0] == claude_bytes
    with restored.connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == DB_VERSION
    assert restored.check()["ok"]
