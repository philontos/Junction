import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import upload
from fastapi.testclient import TestClient

from junction.api import create_app
from junction.cli import Client
from junction.errors import Problem
from junction.store import MAX_IMPORT_BYTES, Store, new_token


def test_import_is_idempotent_and_restart_preserves_everything(service, claude_bytes):
    client, store, auth = service
    first, path = upload(client, auth["alice"], claude_bytes, source_name="first.jsonl")
    again, _ = upload(client, auth["alice"], claude_bytes, source_name="renamed.jsonl")
    assert first["id"] == again["id"] and again["reused"]
    assert len(client.get("/v1/contexts", headers=auth["alice"]).json()["items"]) == 1
    with TestClient(create_app(store.root)) as restarted:
        assert restarted.get(path, headers=auth["alice"]).json()["revision"]["id"] == first["id"]
        assert restarted.get(path + "/raw", headers=auth["alice"]).content == claude_bytes
    assert store.check()["ok"]


def test_concurrent_imports_have_one_revision(service, claude_bytes):
    _, store, _ = service
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: store.import_bytes("alice", claude_bytes, "claude"), range(12)))
    assert len({r["id"] for r in results}) == 1
    assert sum(not r["reused"] for r in results) == 1
    assert store.check()["revision_count"] == 1


def test_same_native_session_owned_by_different_users_is_isolated(service, claude_bytes):
    client, _, auth = service
    alice, apath = upload(client, auth["alice"], claude_bytes)
    bob, _ = upload(client, auth["bob"], claude_bytes)
    assert alice["context_id"] != bob["context_id"]
    assert client.get(apath, headers=auth["bob"]).status_code == 404
    assert len(client.get("/v1/contexts", headers=auth["bob"]).json()["items"]) == 1


@pytest.mark.parametrize(
    "suffix", ["", "/messages", "/turns", "/diagnostics", "/raw", "/messages/m1/content", "/grants"]
)
def test_direct_endpoints_enforce_authorization(service, claude_bytes, suffix):
    client, _, auth = service
    _, path = upload(client, auth["alice"], claude_bytes)
    denied = client.get(path + suffix, headers=auth["eve"])
    assert denied.status_code == 404
    assert client.get(path + suffix).status_code == 401
    assert denied.headers["Cache-Control"] == "no-store"


def test_sharing_and_revocation_cover_all_read_routes(service, claude_bytes):
    client, _, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes)
    cpath = "/v1/contexts/" + rev["context_id"]
    assert client.get(cpath, headers=auth["bob"]).status_code == 404
    response = client.put(path + "/grants/bob", json={}, headers=auth["alice"])
    assert response.status_code == 200
    for suffix in ("", "/messages", "/turns", "/diagnostics", "/messages/m1/content"):
        assert client.get(path + suffix, headers=auth["bob"]).status_code == 200
    assert client.get(cpath, headers=auth["bob"]).status_code == 200
    assert len(client.get("/v1/contexts", headers=auth["bob"]).json()["items"]) == 1
    assert client.get(path + "/raw", headers=auth["bob"]).status_code == 404
    assert client.get(path + "/grants", headers=auth["bob"]).status_code == 404
    assert client.put(path + "/grants/eve", json={}, headers=auth["bob"]).status_code == 404
    client.put(path + "/grants/bob", json={"include_raw": True}, headers=auth["alice"])
    assert client.get(path + "/raw", headers=auth["bob"]).content == claude_bytes
    # Downgrading a grant removes original-file access without removing normalized access.
    client.put(path + "/grants/bob", json={}, headers=auth["alice"])
    assert client.get(path + "/raw", headers=auth["bob"]).status_code == 404
    client.delete(path + "/grants/bob", headers=auth["alice"])
    assert client.get(cpath, headers=auth["bob"]).status_code == 404
    assert client.get(path + "/messages/m1/content", headers=auth["bob"]).status_code == 404
    assert client.get("/v1/contexts", headers=auth["bob"]).json()["items"] == []
    assert client.delete(path + "/grants/bob", headers=auth["alice"]).status_code == 204


def test_new_revisions_are_not_implicitly_shared(service, claude_bytes, codex_bytes):
    client, _, auth = service
    first, path = upload(client, auth["alice"], claude_bytes)
    cid = first["context_id"]
    client.put(path + "/grants/bob", json={}, headers=auth["alice"])
    newer, npath = upload(client, auth["alice"], codex_bytes, "codex", context_id=cid)
    assert newer["number"] == 2
    assert client.get(npath, headers=auth["bob"]).status_code == 404
    listing = client.get("/v1/contexts", headers=auth["bob"]).json()["items"]
    assert listing[0]["revision"]["id"] == first["id"]
    visible = client.get("/v1/contexts/" + cid + "/revisions", headers=auth["bob"]).json()
    assert [r["id"] for r in visible["items"]] == [first["id"]]
    forbidden = client.post(
        "/v1/imports",
        params={"provider": "claude", "context_id": cid},
        content=claude_bytes,
        headers={**auth["bob"], "Content-Type": "application/x-ndjson"},
    )
    assert forbidden.status_code == 404


def test_pages_are_revision_scoped_and_filters_cannot_change(service, claude_bytes, codex_bytes):
    client, _, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes)
    first = client.get(path + "/messages", params={"limit": 1}, headers=auth["alice"]).json()
    upload(client, auth["alice"], codex_bytes, "codex", context_id=rev["context_id"])
    cursor = first["next_cursor"]
    second = client.get(
        path + "/messages", params={"limit": 2, "cursor": cursor}, headers=auth["alice"]
    ).json()
    assert [m["id"] for m in second["items"]] == ["m2", "m3"]
    assert client.get(path + "/turns", params={"cursor": cursor}, headers=auth["alice"]).status_code == 400
    assert (
        client.get(
            path + "/messages", params={"cursor": cursor, "view": "conversation"}, headers=auth["alice"]
        ).status_code
        == 400
    )
    assert client.get(path + "/messages", params={"cursor": "[bad"}, headers=auth["alice"]).status_code == 400
    assert client.get(path + "/messages", params={"limit": 0}, headers=auth["alice"]).status_code == 422
    assert client.get(path + "/messages", params={"limit": 51}, headers=auth["alice"]).status_code == 422


def test_tool_details_large_unicode_chunk_roundtrip_and_export(service):
    client, store, auth = service
    text = "这是工具结果🙂\n" * 7000
    raw = (
        json.dumps(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "absent", "content": text}],
                },
            },
            ensure_ascii=False,
        )
        + "\n"
    ).encode()
    rev, path = upload(client, auth["alice"], raw)
    message = client.get(path + "/messages", headers=auth["alice"]).json()["items"][0]
    assert message["content_truncated"] and message["content"] is None
    assert len(json.dumps(message)) < 5000
    parts, offset = [], 0
    while offset is not None:
        response = client.get(
            message["content_url"], params={"offset": offset, "limit": 1003}, headers=auth["alice"]
        )
        assert response.status_code == 200
        chunk = response.json()
        parts.append(chunk["text"])
        offset = chunk["next_offset"]
    assert json.loads("".join(parts))[0]["output"] == text
    # Use the same export assembler as the command-line client against the HTTP routes.
    thin = object.__new__(Client)
    thin.request = lambda p, params=None: client.get(
        p, params={k: v for k, v in (params or {}).items() if v is not None}, headers=auth["alice"]
    ).json()
    exported = thin.export(client.get(path, headers=auth["alice"]).json(), path)
    assert exported == store.export("alice", rev["context_id"], rev["id"])
    assert exported["session"]["messages"][0]["content"][0]["output"] == text


def test_raw_integrity_failure_is_explicit(service, claude_bytes):
    client, store, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes)
    store.raw_path(rev["source_sha256"]).write_bytes(b"corrupted")
    result = client.get(path + "/raw", headers=auth["alice"])
    assert result.status_code == 500 and result.json()["error"]["code"] == "archive_corrupt"
    assert not store.check()["ok"]


def test_backup_restore_preserves_permissions_and_raw(service, claude_bytes, tmp_path):
    client, store, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes)
    client.put(path + "/grants/bob", json={}, headers=auth["alice"])
    dest = tmp_path / "backup"
    assert store.backup(dest)["ok"]
    assert (dest / "BACKUP_COMPLETE.json").exists()
    with TestClient(create_app(dest)) as restored:
        assert restored.get(path + "/messages", headers=auth["bob"]).status_code == 200
        assert restored.get(path + "/raw", headers=auth["bob"]).status_code == 404
        assert restored.get(path + "/raw", headers=auth["alice"]).content == claude_bytes
    with pytest.raises(FileExistsError):
        store.backup(dest)


def test_backup_does_not_mark_incomplete_copy_complete(service, claude_bytes, tmp_path):
    client, store, auth = service
    rev, _ = upload(client, auth["alice"], claude_bytes)
    store.raw_path(rev["source_sha256"]).unlink()
    dest = tmp_path / "bad-backup"
    with pytest.raises(Problem):
        store.backup(dest)
    assert not (dest / "BACKUP_COMPLETE.json").exists()


@pytest.mark.parametrize("body,code", [(b"", 400), (b" \n", 400), (b"x" * (MAX_IMPORT_BYTES + 1), 413)])
def test_import_limits(service, body, code):
    client, _, auth = service
    response = client.post(
        "/v1/imports?provider=claude",
        content=body,
        headers={**auth["alice"], "Content-Type": "application/x-ndjson"},
    )
    assert response.status_code == code


def test_failed_parse_still_archives_original_and_diagnostics(service):
    client, _, auth = service
    original = b'{"broken":\xff\n'
    rev, path = upload(client, auth["alice"], original)
    assert rev["status"] == "failed"
    assert client.get(path + "/raw", headers=auth["alice"]).content == original
    assert (
        client.get(path + "/diagnostics", headers=auth["alice"]).json()["items"][0]["code"]
        == "invalid_record"
    )


def test_rotation_revokes_old_token_without_losing_context(service, claude_bytes):
    client, store, auth = service
    _, path = upload(client, auth["alice"], claude_bytes)
    token = new_token()
    store.add_user("alice", token, rotate=True)
    assert client.get(path, headers=auth["alice"]).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer " + token}).status_code == 200


def test_database_version_fails_closed(service):
    _, store, _ = service
    with store.connection(write=True) as db:
        db.execute("PRAGMA user_version=99")
    with pytest.raises(RuntimeError, match="Unsupported database version"):
        Store(store.root)


def test_sql_like_input_cannot_expand_access(service, claude_bytes):
    client, _, auth = service
    upload(client, auth["alice"], claude_bytes)
    assert client.get("/v1/contexts/' OR 1=1 --", headers=auth["eve"]).status_code == 404
    assert (
        client.get("/v1/contexts", headers={"Authorization": "Bearer " + "' OR 1=1 --" * 4}).status_code
        == 401
    )


def test_media_type_and_provider_validation(service):
    client, _, auth = service
    assert client.post("/v1/imports?provider=claude", json={}, headers=auth["alice"]).status_code == 415
    assert client.post("/v1/imports?provider=other", content=b"{}", headers=auth["alice"]).status_code == 422


def test_context_pagination_does_not_leak_or_repeat(service, claude_bytes):
    client, _, auth = service
    for n in range(5):
        upload(client, auth["alice"], claude_bytes + ("\n" * n).encode())
    first = client.get("/v1/contexts", params={"limit": 2}, headers=auth["alice"]).json()
    # Concurrent insertion is newer than the cursor and will appear on the next fresh listing.
    upload(client, auth["alice"], claude_bytes + b"\n" * 7)
    second = client.get(
        "/v1/contexts", params={"limit": 10, "cursor": first["next_cursor"]}, headers=auth["alice"]
    ).json()
    ids = [v["id"] for v in first["items"] + second["items"]]
    assert len(ids) == len(set(ids)) == 5
    assert (
        client.get("/v1/contexts", params={"cursor": first["next_cursor"]}, headers=auth["eve"]).status_code
        == 400
    )


def test_failed_catalog_commit_leaves_no_half_import(service, claude_bytes):
    _, store, _ = service
    with store.connection(write=True) as db:
        db.execute(
            "CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        store.import_bytes("alice", claude_bytes, "claude")
    assert store.list_contexts("alice")["items"] == []
    assert store.check()["revision_count"] == 0
    with store.connection(write=True) as db:
        db.execute("DROP TRIGGER reject_message")
    retried = store.import_bytes("alice", claude_bytes, "claude")
    assert not retried["reused"] and store.check()["ok"]


def test_integrity_check_detects_mismatched_normalized_counts(service, claude_bytes):
    _, store, _ = service
    store.import_bytes("alice", claude_bytes, "claude")
    with store.connection(write=True) as db:
        db.execute("UPDATE revisions SET message_count=message_count+1")
    check = store.check()
    assert not check["ok"] and check["errors"][0]["code"] == "normalized_invalid"


def test_reimport_restores_a_missing_original_but_rejects_a_corrupt_one(service, claude_bytes):
    _, store, _ = service
    first = store.import_bytes("alice", claude_bytes, "claude")
    path = store.raw_path(first["source_sha256"])
    path.unlink()
    assert store.import_bytes("alice", claude_bytes, "claude")["id"] == first["id"]
    assert path.read_bytes() == claude_bytes
    path.write_bytes(b"damaged")
    with pytest.raises(Problem, match="checksum"):
        store.import_bytes("alice", claude_bytes, "claude")


def test_workspace_extensions_are_immutable_and_survive_export(service, claude_bytes):
    client, store, auth = service
    metadata = {"switchyard.workspace/1": {"commit": "a" * 40, "dirty": True}}
    result, path = upload(client, auth["alice"], claude_bytes, extensions=json.dumps(metadata))
    assert result["normalized"]["extensions"]["switchyard.workspace/1"] == metadata["switchyard.workspace/1"]
    assert client.get(path + "/raw", headers=auth["alice"]).content == claude_bytes
    same, _ = upload(client, auth["alice"], claude_bytes, extensions=json.dumps(metadata))
    assert same["id"] == result["id"] and same["reused"]
    # Omitted extensions preserve the already recorded metadata.
    omitted, _ = upload(client, auth["alice"], claude_bytes)
    assert omitted["normalized"]["extensions"] == result["normalized"]["extensions"]
    conflict = client.post("/v1/imports", params={"provider": "claude", "extensions": "{}"},
                           content=claude_bytes, headers={**auth["alice"], "Content-Type": "application/x-ndjson"})
    assert conflict.status_code == 409
    client.put(path + "/grants/bob", json={}, headers=auth["alice"])
    assert store.export("bob", result["context_id"], result["id"])["extensions"] == result["normalized"]["extensions"]
    assert store.check()["ok"]


@pytest.mark.parametrize("metadata", ['null', '[]', '{"x": NaN}', '{"x":1,"x":2}', '{broken'])
def test_invalid_extensions_are_rejected(service, claude_bytes, metadata):
    client, _, auth = service
    response = client.post("/v1/imports", params={"provider": "claude", "extensions": metadata},
                           content=claude_bytes, headers={**auth["alice"], "Content-Type": "application/x-ndjson"})
    assert response.status_code == 400
    assert client.get("/v1/contexts", headers=auth["alice"]).json()["items"] == []
