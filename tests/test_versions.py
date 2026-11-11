import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import upload

from junction.errors import Problem
from junction.store import DB_VERSION, Store, new_token


def test_source_versions_share_raw_but_preserve_distinct_metadata(service, claude_bytes):
    client, store, auth = service
    key = "switchyard:node:task:1"
    first, first_path = upload(client, auth["alice"], claude_bytes, source_key=key, shared=True,
                               extensions=json.dumps({"workspace/1": {"commit": "a", "dirty": True}}))
    second, second_path = upload(client, auth["alice"], claude_bytes, source_key=key, shared=True,
                                 extensions=json.dumps({"workspace/1": {"dirty": False, "commit": "b"}}))
    again, _ = upload(client, auth["alice"], claude_bytes, source_key=key,
                      extensions=json.dumps({"workspace/1": {"commit": "b", "dirty": False}}))
    assert first["context_id"] == second["context_id"]
    assert (first["number"], second["number"]) == (1, 2)
    assert again["reused"] and again["id"] == second["id"]
    assert first["source_sha256"] == second["source_sha256"]
    assert first["snapshot_sha256"] != second["snapshot_sha256"]
    assert client.get(first_path, headers=auth["bob"]).json()["revision"]["normalized"]["extensions"]["workspace/1"]["commit"] == "a"
    assert client.get(second_path, headers=auth["bob"]).json()["revision"]["normalized"]["extensions"]["workspace/1"]["commit"] == "b"
    assert len(list(store.raw_dir.rglob("*.jsonl"))) == 1
    listing = client.get("/v1/contexts?shared_only=true", headers=auth["bob"]).json()["items"]
    assert len(listing) == 1 and listing[0]["revision"]["id"] == second["id"]
    assert store.check()["ok"]


def test_appended_log_is_a_new_version_and_old_bytes_remain_exact(service, claude_bytes, codex_bytes):
    _, store, _ = service
    first = store.import_bytes("alice", claude_bytes, "claude", source_key="task:1", shared=True)
    # An adapter can change agent without changing task identity.
    second = store.import_bytes("alice", codex_bytes, "codex", source_key="task:1", shared=True)
    assert first["context_id"] == second["context_id"] and second["number"] == 2
    assert store.read_raw("alice", first["context_id"], first["id"])[0] == claude_bytes
    assert store.read_raw("alice", second["context_id"], second["id"])[0] == codex_bytes
    assert store.check()["archive_count"] == 2
    restored = Store(store.root)
    assert restored.import_bytes("alice", codex_bytes, "codex", source_key="task:1")["id"] == second["id"]


def test_source_identity_is_owner_scoped_and_different_tasks_never_merge(service, claude_bytes):
    _, store, _ = service
    unbound = store.import_bytes("alice", claude_bytes, "claude")
    a = store.import_bytes("alice", claude_bytes, "claude", source_key="task:1")
    b = store.import_bytes("bob", claude_bytes, "claude", source_key="task:1")
    c = store.import_bytes("alice", claude_bytes, "claude", source_key="task:2")
    assert len({r["context_id"] for r in [unbound, a, b, c]}) == 4
    assert store.check()["archive_count"] == 1
    with pytest.raises(Problem) as denied:
        store.import_bytes("bob", claude_bytes, "claude", context_id=a["context_id"], source_key="task:1")
    assert denied.value.status == 404
    with pytest.raises(Problem) as conflict:
        store.import_bytes("alice", claude_bytes, "claude", context_id=c["context_id"], source_key="task:1")
    assert conflict.value.code == "source_conflict"
    assert len(store.list_contexts("alice")["items"]) == 3


def test_concurrent_first_shares_and_changed_metadata_are_idempotent(service, claude_bytes):
    _, store, _ = service
    def share(commit):
        return store.import_bytes("alice", claude_bytes, "claude", source_key="task:concurrent",
                                  extensions={"workspace/1": {"commit": commit}}, shared=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        first = list(pool.map(lambda _: share("a"), range(12)))
        second = list(pool.map(lambda _: share("b"), range(12)))
    assert len({r["context_id"] for r in first + second}) == 1
    assert len({r["id"] for r in first + second}) == 2
    assert sum(not r["reused"] for r in first + second) == 2
    assert store.check()["revision_count"] == 2 and store.check()["archive_count"] == 1


def test_shared_version_pagination_never_exposes_private_versions(service, claude_bytes):
    client, _, auth = service
    versions = [upload(client, auth["alice"], claude_bytes, source_key="task:pages", shared=n != 2,
                       extensions=json.dumps({"step/1": n}))[0] for n in range(1, 4)]
    path = f"/v1/contexts/{versions[0]['context_id']}/revisions"
    for user in ["alice", "bob"]:
        first = client.get(path, params={"shared_only": True, "limit": 1}, headers=auth[user]).json()
        assert first["items"][0]["number"] == 3
        second = client.get(path, params={"shared_only": True, "limit": 1, "cursor": first["next_cursor"]}, headers=auth[user]).json()
        assert [r["number"] for r in second["items"]] == [1]
        assert second["next_cursor"] is None
        assert client.get(path, params={"cursor": first["next_cursor"]}, headers=auth[user]).status_code == 400


def test_backup_preserves_source_bindings_and_shared_raw(service, claude_bytes, tmp_path):
    _, store, _ = service
    first = store.import_bytes("alice", claude_bytes, "claude", source_key="task:backup", extensions={"x/1": 1})
    second = store.import_bytes("alice", claude_bytes, "claude", source_key="task:backup", extensions={"x/1": 2})
    backup = store.backup(tmp_path / "backup")
    assert backup["revision_count"] == 2 and backup["archive_count"] == 1
    restored = Store(backup["path"])
    assert restored.import_bytes("alice", claude_bytes, "claude", source_key="task:backup", extensions={"x/1": 2})["id"] == second["id"]
    assert restored.export("alice", first["context_id"], first["id"])["extensions"]["x/1"] == 1


LEGACY_REVISIONS = """CREATE TABLE revisions_v3 (
 id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id), number INTEGER NOT NULL,
 provider TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_bytes INTEGER NOT NULL,
 source_name TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, header_json TEXT NOT NULL, message_count INTEGER NOT NULL,
 turn_count INTEGER NOT NULL, diagnostic_count INTEGER NOT NULL,
 UNIQUE(context_id, number), UNIQUE(context_id, provider, source_sha256, parser_version))"""


def legacy_store(tmp_path, raw):
    store = Store(tmp_path / "legacy")
    for user in ["alice", "bob"]:
        store.add_user(user, new_token())
    metadata = {"switchyard.workspace/1": {"source": {"node_id": "legacy", "task_id": 7}, "commit": "a"}}
    revision = store.import_bytes("alice", raw, "claude", extensions=metadata, shared=True)
    store.set_grant("alice", revision["context_id"], revision["id"], "bob", True)
    with sqlite3.connect(store.db_path) as db:
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute(LEGACY_REVISIONS)
        columns = [r[1] for r in db.execute("PRAGMA table_info(revisions_v3)")]
        db.execute(f"INSERT INTO revisions_v3 SELECT {','.join(columns)} FROM revisions")
        db.execute("DROP TABLE revisions")
        db.execute("ALTER TABLE revisions_v3 RENAME TO revisions")
        db.execute("DROP TABLE context_sources")
        db.execute("PRAGMA user_version=3")
    return store, revision, metadata


def test_real_v3_migration_preserves_links_grants_and_binds_existing_task(tmp_path, claude_bytes, codex_bytes):
    old, first, metadata = legacy_store(tmp_path, claude_bytes)
    migrated = Store(old.root)
    assert migrated.get_context("bob", first["context_id"], first["id"])["access"]["shared"]
    assert migrated.read_raw("bob", first["context_id"], first["id"])[0] == claude_bytes
    second = migrated.import_bytes("alice", codex_bytes, "codex", source_key="switchyard:legacy:task:7",
                                    extensions=metadata, shared=True)
    assert second["context_id"] == first["context_id"] and second["number"] == 2
    third = migrated.import_bytes("alice", codex_bytes, "codex", source_key="switchyard:legacy:task:7",
                                   extensions={"workspace/1": {"commit": "b"}}, shared=True)
    assert third["number"] == 3 and third["source_sha256"] == second["source_sha256"]
    assert migrated.check()["ok"]
    with migrated.connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == DB_VERSION


def test_failed_migration_rolls_back_catalog(tmp_path, claude_bytes):
    store, _, _ = legacy_store(tmp_path, claude_bytes)
    with sqlite3.connect(store.db_path) as db:
        db.execute("UPDATE revisions SET header_json='invalid json'")
    with pytest.raises(ValueError):
        Store(store.root)
    with sqlite3.connect(store.db_path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert "snapshot_sha256" not in [r[1] for r in db.execute("PRAGMA table_info(revisions)")]
        assert db.execute("SELECT count(*) FROM revisions").fetchone()[0] == 1


@pytest.mark.parametrize("key", ["", "has spaces", "\n", "x" * 257])
def test_invalid_source_keys_do_not_create_contexts(service, claude_bytes, key):
    _, store, _ = service
    with pytest.raises(Problem) as error:
        store.import_bytes("alice", claude_bytes, "claude", source_key=key)
    assert error.value.code == "invalid_source_key"
    assert store.list_contexts("alice")["items"] == []
