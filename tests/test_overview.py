import json
import sqlite3

from conftest import upload

from junction.overview import OVERVIEW_EXTENSION as KEY
from junction.store import Store, new_token


def test_overview_is_persisted_with_evidence_and_full_history(service, claude_bytes):
    client, store, auth = service
    rev, path = upload(client, auth["alice"], claude_bytes, shared=True)
    overview = rev["normalized"]["extensions"][KEY]
    assert overview["title"].startswith("Add an empty-input guard")
    assert overview["title_source"] == "first_user_message"
    assert "No edits yet" in overview["description"]
    assert [e["message_id"] for e in overview["evidence"]] == ["m1", "m4"]
    assert overview["evidence"][0]["lines"] == [1]
    assert overview["missing"] == []
    again, _ = upload(client, auth["alice"], claude_bytes, title="a later title")
    assert again["id"] == rev["id"] and again["normalized"]["extensions"][KEY] == overview
    assert client.get(path, headers=auth["bob"]).json()["revision"]["normalized"]["extensions"][KEY] == overview
    exported = store.export("bob", rev["context_id"], rev["id"])
    assert exported["extensions"][KEY] == overview
    assert len(exported["session"]["messages"]) == 4
    assert store.read_raw("alice", rev["context_id"], rev["id"])[0] == claude_bytes
    backup = store.root.parent / "backup"
    assert store.backup(backup)["ok"]
    assert Store(backup).export("bob", rev["context_id"], rev["id"]) == exported


def test_missing_fields_and_truncated_excerpts_do_not_invent_or_remove_history(service):
    client, store, auth = service
    text = "待确认的原始要求 " * 100
    raw = (json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n").encode()
    rev, _ = upload(client, auth["alice"], raw)
    overview = rev["normalized"]["extensions"][KEY]
    assert {"assistant_text", "native_session_id", "cwd", "message_timestamp"} <= {m["field"] for m in overview["missing"]}
    assert overview["evidence"][0]["truncated"]
    assert len(overview["evidence"][0]["text"]) == 360
    full = store.export("alice", rev["context_id"], rev["id"])
    assert full["session"]["messages"][0]["content"][0]["text"] == text
    failed, _ = upload(client, auth["alice"], b"not-json\n")
    assert failed["status"] == "failed"
    assert failed["normalized"]["extensions"][KEY]["evidence"] == []
    assert failed["normalized"]["extensions"][KEY]["diagnostic_counts"]["invalid_record"] == 1


def test_overview_cannot_be_spoofed_by_import_metadata(service, claude_bytes):
    client, _, auth = service
    response = client.post("/v1/imports", params={
        "provider": "claude", "extensions": json.dumps({KEY: {"description": "fabricated"}}),
    }, content=claude_bytes, headers={**auth["alice"], "Content-Type": "application/x-ndjson"})
    assert response.status_code == 400


def test_v2_archive_gains_overview_on_reimport_without_rewriting_original(tmp_path, claude_bytes):
    store = Store(tmp_path / "data")
    store.add_user("alice", new_token())
    rev = store.import_bytes("alice", claude_bytes, "claude", title="original title")
    with sqlite3.connect(store.db_path) as db:
        original_header = db.execute("SELECT header_json FROM revisions WHERE id=?", (rev["id"],)).fetchone()[0]
        db.execute("DROP TABLE revision_overviews")
        db.execute("PRAGMA user_version=2")
    restored = Store(store.root)
    before = restored.get_context("alice", rev["context_id"])["revision"]["normalized"]
    assert KEY not in before["extensions"]
    again = restored.import_bytes("alice", claude_bytes, "claude", title="not used", shared=True)
    assert again["id"] == rev["id"]
    assert again["normalized"]["extensions"][KEY]["title"] == "original title"
    with restored.connection() as db:
        assert db.execute("SELECT header_json FROM revisions WHERE id=?", (rev["id"],)).fetchone()[0] == original_header
    assert restored.read_raw("alice", rev["context_id"], rev["id"])[0] == claude_bytes
    assert restored.check()["ok"]
