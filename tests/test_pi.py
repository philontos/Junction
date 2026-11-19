import hashlib
import json
from pathlib import Path

import jsonschema
from conftest import upload

from junction.models import context_schema
from junction.parsers import normalize

RAW = (Path(__file__).parent / "fixtures/pi-handoff.jsonl").read_bytes()


def rows(*items):
    return ("\n".join(json.dumps(item) for item in items) + "\n").encode()


def test_pi_fidelity_and_tool_pairing():
    result = normalize(RAW, "pi")
    assert result.status == "ready"
    assert result.session.native_id == "pi-handoff-demo"
    assert result.session.source_version == "3"
    assert result.session.cwd == "/example/project"
    messages = result.session.messages
    user = next(m for m in messages if m.role == "user")
    assert user.source.native_id == "u1"
    assert user.source.native_parent_id == "sys1"
    assert user.source.lines == [3]
    blocks = [b for m in messages for b in m.content]
    tools = [b for b in blocks if b.kind in {"tool_call", "tool_result"}]
    assert len(tools) == 2 and all(b.pair_status == "matched" for b in tools)
    assert tools[0].arguments == {"path": "src/board.ts"}
    assert "return null" in tools[1].output
    image = next(b for b in blocks if b.kind == "attachment")
    assert image.resource.availability == "raw_only"
    assert image.resource.reference == "raw:line:3:content:1"
    assert "aW1hZ2UtZml4dHVyZQ==" not in result.model_dump_json()
    assert "synthetic-signature" in result.model_dump_json()
    assert any(b.output.get("fields", {}).get("sections") for b in blocks if b.kind == "marker")
    jsonschema.Draft202012Validator(context_schema()).validate(result.model_dump())


def test_pi_branch_edits_unknown_and_partial_records_are_explicit():
    data = RAW + rows(
        {"type": "compaction", "id": "compact", "parentId": "a2", "summary": "checkpoint", "firstKeptEntryId": "u1"},
        {"type": "branch_summary", "id": "branch", "parentId": "u1", "fromId": "a2", "summary": "alternate"},
        {"type": "context_edit", "id": "edit", "parentId": "branch", "targetId": "r1", "replacement": None},
        {"type": "future_record", "id": "future", "data": {"preserve": True}},
        {"type": "custom_message", "id": "custom", "parentId": "missing", "content": "historical extension"},
    ) + b'{"unfinished":'
    result = normalize(data, "pi")
    assert result.status == "partial"
    codes = {d.code for d in result.diagnostics}
    assert {"compaction_present", "branch_summary_present", "context_edit_present", "branching_history",
            "missing_parent", "unknown_record", "invalid_record"} <= codes
    assert result.session.effective_history == "not_reconstructed"
    original_result = next(b for m in result.session.messages for b in m.content if b.kind == "tool_result")
    assert "return null" in original_result.output  # Context edits never destroy recorded history.
    assert result.records[-1].status == "invalid"
    assert result.records[-3].status == "unmapped"


def test_pi_legacy_and_future_versions_remain_readable_with_diagnostics():
    for version in (1, 99):
        raw = rows({"type": "session", "version": version, "id": "legacy", "cwd": "/example"},
                   {"type": "message", "message": {"role": "user", "content": "hello"}})
        result = normalize(raw, "pi")
        assert result.session.messages[-1].content[0].text == "hello"
        code = "legacy_linear_history" if version == 1 else "unknown_source_version"
        assert code in {d.code for d in result.diagnostics}


def test_pi_import_publish_export_and_reimport_are_lossless(service):
    client, store, auth = service
    assert any(a["id"] == "pi" for a in client.get("/v1/providers").json()["items"])
    revision, url = upload(client, auth["alice"], RAW, "pi", source_key="pi:task-one", shared=True)
    again, _ = upload(client, auth["alice"], RAW, "pi", source_key="pi:task-one", shared=True)
    assert again["reused"] and again["id"] == revision["id"]
    assert client.get(url, headers=auth["bob"]).status_code == 200
    exported = store.export("bob", revision["context_id"], revision["id"])
    assert exported["provider"] == "pi"
    assert exported["source_sha256"] == hashlib.sha256(RAW).hexdigest()
    assert client.get(url + "/raw", headers=auth["alice"]).content == RAW
    assert store.check()["ok"]
