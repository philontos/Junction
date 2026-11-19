import base64
import hashlib
import json
from dataclasses import replace

import pytest
from conftest import upload

from junction.cli import Client, parser
from junction.models import Block, NormalizedContext
from junction.parsers import normalize
from junction_adapters.parsers.common import Candidate
from junction_adapters.parsers.registry import ADAPTERS, Adapter
from junction.store import DB_VERSION, Store, snapshot_digest


def jsonl(*rows):
    return b"".join((json.dumps(row, ensure_ascii=False) + "\n").encode() for row in rows)


def test_native_index_is_byte_exact_with_bom_crlf_blank_and_invalid_lines():
    first = b'\xef\xbb\xbf{"type":"user","message":{"role":"user","content":"hi"}}\r\n'
    unknown = b'{"type":"future","opaque":{"keep":123456789012345678901234567890}}\r\n'
    bad = b'\xff{"broken":'
    raw = first + b" \r\n" + unknown + bad
    context = normalize(raw, "claude")
    assert context.record_index.complete and context.record_count == 3
    assert [r.id for r in context.records] == ["r1", "r3", "r4"]
    assert [r.status for r in context.records] == ["projected", "unmapped", "invalid"]
    assert context.session.messages[0].source.record_ids == ["r1"]
    for record, exact in zip(context.records, [first, unknown, bad], strict=True):
        assert raw[record.byte_offset:record.byte_offset + record.byte_length] == exact
        assert record.sha256 == hashlib.sha256(exact).hexdigest()


def test_record_limit_reports_incomplete_index_without_dropping_archive_identity(monkeypatch):
    monkeypatch.setattr("junction_adapters.parsers.common.MAX_RECORDS", 1)
    raw = jsonl({"type": "future"}, {"type": "future2"})
    context = normalize(raw, "codex")
    assert not context.record_index.complete
    assert context.record_count == 2 and context.record_index.indexed_records == 1
    assert context.source_sha256 == hashlib.sha256(raw).hexdigest()


def test_claude_native_role_usage_and_metadata_survive_without_guessing_units():
    context = normalize(jsonl(
        {"type": "assistant", "uuid": "a", "message": {"role": "assistant", "model": "test-model",
         "usage": {"input_tokens": 0, "future_tokens": {"cached": 7}}, "stop_reason": None,
         "content": [{"type": "tool_use", "id": "call", "name": "Read", "input": {}}]}},
        {"type": "user", "uuid": "b", "parentUuid": "a", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "call", "content": "ok"}]}},
        {"type": "file-history-snapshot", "snapshot": {"trackedFileBackups": {"file": "ref"}}},
    ), "claude")
    call, result, snapshot = context.session.messages
    assert result.role == "tool" and result.source.native_role == "user"
    fields = call.content[-1].output["fields"]
    assert fields == {"model": "test-model", "usage": {"input_tokens": 0, "future_tokens": {"cached": 7}}, "stop_reason": None}
    assert snapshot.is_meta and snapshot.content[0].output["snapshot"]["trackedFileBackups"] == {"file": "ref"}


def test_same_visible_message_with_changed_native_fields_is_not_collapsed():
    row = {"type": "assistant", "uuid": "a", "message": {"role": "assistant", "content": "same", "model": "test-model"}}
    context = normalize(jsonl(row, {**row, "future_signature": "different"}, row), "claude")
    assert len(context.session.messages) == 2
    assert context.session.messages[0].source.record_ids == ["r1", "r3"]
    assert context.records[2].message_ids == context.records[0].message_ids


def test_codex_arguments_keep_lexical_form_and_lifecycle_data():
    args = '{ "n": 1.00, "label": "\\u4e2d" }'
    raw = jsonl(
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t"}},
        {"type": "response_item", "payload": {"type": "function_call", "name": "f", "call_id": "c", "arguments": args}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {"total": 17}}},
        {"type": "event_msg", "payload": {"type": "turn_aborted", "reason": "interrupted"}},
    )
    context = normalize(raw, "codex")
    call = next(b for m in context.session.messages for b in m.content if b.kind == "tool_call")
    assert call.arguments == {"n": 1.0, "label": "中"} and call.arguments_text == args
    markers = {b.name: b.output for m in context.session.messages for b in m.content if b.kind == "marker"}
    assert markers["token_count"]["info"] == {"total": 17}
    assert markers["turn_aborted"]["reason"] == "interrupted"
    assert all(r.status == "projected" for r in context.records)


def test_ambiguous_codex_display_events_remain_distinct():
    rows = [{"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t"}}]
    for uid in ("a", "b"):
        rows.append({"type": "response_item", "payload": {"type": "message", "id": uid,
                     "role": "assistant", "content": [{"type": "output_text", "text": "same"}]}})
    rows.append({"type": "event_msg", "payload": {"type": "agent_message", "message": "same"}})
    context = normalize(jsonl(*rows), "codex")
    assert len([m for m in context.session.messages if m.role == "assistant"]) == 3
    assert "ambiguous_display_record" in {d.code for d in context.diagnostics}


def test_codex_equal_text_different_channels_is_not_merged():
    context = normalize(jsonl(
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t"}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant", "channel": "analysis",
         "content": [{"type": "output_text", "text": "same"}]}},
        {"type": "event_msg", "payload": {"type": "agent_message", "channel": "final", "message": "same"}},
    ), "codex")
    messages = [m for m in context.session.messages if m.role == "assistant"]
    assert len(messages) == 2 and all(len(m.source.record_ids) == 1 for m in messages)


def test_native_records_page_chunk_access_and_corruption(service):
    client, store, auth = service
    row = jsonl({"type": "user", "message": {"role": "user", "content": "visible"}})
    unknown = b'{"type":"future","private_field":"native-only"}\r\n'
    raw = row + unknown + b"\xff\n"
    revision, path = upload(client, auth["alice"], raw, shared=True)
    page = client.get(path + "/records?limit=1", headers=auth["bob"]).json()
    assert page["items"][0]["id"] == "r1" and page["next_cursor"]
    assert "native-only" not in json.dumps(store.export("bob", revision["context_id"], revision["id"]))
    assert client.get(path + "/records/r2/content", headers=auth["bob"]).status_code == 404
    assert client.get(path + "/records/r2/content").status_code == 401
    assert client.get(path + "/records", params={"cursor": page["next_cursor"], "limit": 1}, headers=auth["bob"]).json()["items"][0]["id"] == "r2"
    assert client.get(path + "/messages", params={"cursor": page["next_cursor"]}, headers=auth["alice"]).status_code == 400
    client.put(path + "/grants/bob", json={"include_raw": True}, headers=auth["alice"])
    for rid, expected in (("r2", unknown), ("r3", b"\xff\n")):
        offset, parts = 0, []
        while offset is not None:
            chunk = client.get(path + f"/records/{rid}/content", params={"offset": offset, "limit": 7}, headers=auth["bob"]).json()
            assert chunk["offset_unit"] == "byte" and chunk["encoding"] == "base64"
            parts.append(base64.b64decode(chunk["data"]))
            offset = chunk["next_offset"]
        assert b"".join(parts) == expected
        assert chunk["sha256"] == hashlib.sha256(expected).hexdigest()
    assert client.get(path + "/records/r2/content?offset=99999", headers=auth["bob"]).status_code == 400
    client.delete(path + "/grants/bob", headers=auth["alice"])
    assert client.get(path + "/records/r2/content", headers=auth["bob"]).status_code == 404
    assert store.check()["ok"]
    with store.connection(write=True) as db:
        data = json.loads(db.execute("SELECT data_json FROM records WHERE id='r2'").fetchone()[0])
        data["byte_offset"] += 1
        db.execute("UPDATE records SET data_json=? WHERE id='r2'", (json.dumps(data),))
    assert not store.check()["ok"]
    assert client.get(path + "/records/r2/content", headers=auth["alice"]).status_code == 503
    with store.connection(write=True) as db:
        db.execute("UPDATE records SET data_json='invalid' WHERE id='r2'")
    assert client.get(path + "/records/r2/content", headers=auth["alice"]).status_code == 503


def test_new_adapter_needs_no_schema_store_api_or_cli_branch(service, monkeypatch):
    client, store, auth = service
    def parse_demo(records, state):
        for line, raw in records:
            state.candidates.append(Candidate(line, "user", [Block(kind="text", text=raw["text"])], "demo"))
            state.recognized += 1
    adapter = Adapter("demo-agent", "1", "demo.jsonl", parse_demo)
    monkeypatch.setitem(ADAPTERS, adapter.id, adapter)
    assert adapter.id in [p["id"] for p in client.get("/v1/providers").json()["items"]]
    assert parser().parse_args(["import", "test.jsonl", "--provider", adapter.id]).provider == adapter.id
    raw = jsonl({"text": "extension works"})
    first, _ = upload(client, auth["alice"], raw, adapter.id, source_key="demo:1")
    assert store.export("alice", first["context_id"], first["id"])["provider"] == adapter.id
    monkeypatch.setitem(ADAPTERS, adapter.id, replace(adapter, version="2"))
    second, _ = upload(client, auth["alice"], raw, adapter.id, source_key="demo:1")
    assert first["context_id"] == second["context_id"] and second["number"] == 2
    assert first["parser_version"] != second["parser_version"]
    assert store.check()["archive_count"] == 1
    with pytest.raises(ValueError, match="No installed adapter"):
        normalize(raw, "not-installed")


def test_future_additive_fields_round_trip_and_unknown_major_is_rejected(claude_bytes):
    value = normalize(claude_bytes, "claude").model_dump()
    value["provider"] = "pi"
    value["future_header"] = {"keep": True}
    value["session"]["messages"][0]["content"][0]["future_annotation"] = {"x": 1}
    assert NormalizedContext.model_validate(value).model_dump() == value
    value["schema_version"] = "junction.context/99"
    with pytest.raises(ValueError):
        NormalizedContext.model_validate(value)


def test_v4_upgrade_preserves_old_projection_and_new_parser_makes_new_revision(service, claude_bytes):
    _, store, _ = service
    first = store.import_bytes("alice", claude_bytes, "claude", source_key="legacy:1", shared=True)
    with store.connection(write=True) as db:
        header = json.loads(db.execute("SELECT header_json FROM revisions WHERE id=?", (first["id"],)).fetchone()[0])
        header.pop("record_index")
        header["parser_version"] = "0.1.0"
        fingerprint = snapshot_digest("claude", first["source_sha256"], "0.1.0", header["extensions"])
        db.execute("UPDATE revisions SET header_json=?,parser_version=?,snapshot_sha256=? WHERE id=?",
                   (json.dumps(header), "0.1.0", fingerprint, first["id"]))
        for row in db.execute("SELECT id,data_json,content_json FROM messages").fetchall():
            message, content = json.loads(row["data_json"]), json.loads(row["content_json"])
            message["source"].pop("native_role", None)
            message["source"].pop("record_ids", None)
            for block in content:
                block.pop("arguments_text", None)
            db.execute("UPDATE messages SET data_json=?,content_json=? WHERE id=?",
                       (json.dumps(message), json.dumps(content), row["id"]))
        db.execute("DROP TABLE records")
        db.execute("PRAGMA user_version=4")
        before = db.execute("SELECT header_json FROM revisions WHERE id=?", (first["id"],)).fetchone()[0]
    restored = Store(store.root)
    with restored.connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == DB_VERSION
        assert db.execute("SELECT header_json FROM revisions WHERE id=?", (first["id"],)).fetchone()[0] == before
    old = restored.export("bob", first["context_id"], first["id"])
    assert "record_index" not in old and "records" not in old
    assert all("record_ids" not in m["source"] for m in old["session"]["messages"])
    second = restored.import_bytes("alice", claude_bytes, "claude", source_key="legacy:1")
    assert second["number"] == 2 and first["source_sha256"] == second["source_sha256"]
    assert restored.export("alice", second["context_id"], second["id"])["records"]
    assert restored.check()["ok"]


def test_cli_export_keeps_new_index_and_future_fields(service, claude_bytes):
    client, store, auth = service
    revision, path = upload(client, auth["alice"], claude_bytes)
    class LocalClient(Client):
        def __init__(self):
            pass

        def request(self, route, *, params=None, **kwargs):
            response = client.get(route, params={k: v for k, v in (params or {}).items() if v is not None}, headers=auth["alice"])
            response.raise_for_status()
            return response.json()
    reader = LocalClient()
    exported = reader.export(client.get(path, headers=auth["alice"]).json(), path)
    assert exported == store.export("alice", revision["context_id"], revision["id"])
    assert len(exported["records"]) == exported["record_count"]
