import json
import random

import jsonschema
import pytest

from junction.models import context_schema
from junction.parsers import normalize


def jsonl(*rows):
    return ("\n".join(json.dumps(r) for r in rows) + "\n").encode()


def codes(result):
    return {d.code for d in result.diagnostics}


@pytest.mark.parametrize("provider,fixture", [("claude", "claude_bytes"), ("codex", "codex_bytes")])
def test_supported_handoff(provider, fixture, request):
    data = request.getfixturevalue(fixture)
    result = normalize(data, provider)
    assert result.status == "ready"
    assert len([m for m in result.session.messages if m.role == "user"]) == 1
    blocks = [b for m in result.session.messages for b in m.content if b.kind.startswith("tool_")]
    assert len(blocks) == 2
    assert all(b.pair_status == "matched" and b.related_messages for b in blocks)
    assert result.session.effective_history == "not_reconstructed"
    jsonschema.Draft202012Validator(context_schema()).validate(result.model_dump())
    if provider == "codex":
        assert next(m for m in result.session.messages if m.role == "user").source.lines == [4, 5]
        assert next(m for m in result.session.messages if m.role == "assistant" and m.content[0].kind == "text").source.lines == [8, 9]


def test_claude_split_messages_and_duplicate_envelopes():
    base = {"type": "assistant", "sessionId": "s", "parentUuid": None}
    a = {**base, "uuid": "u1", "message": {"id": "api-id", "role": "assistant", "content": "one"}}
    b = {**base, "uuid": "u2", "message": {"id": "api-id", "role": "assistant", "content": "two"}}
    result = normalize(jsonl(a, a, b), "claude")
    assert [m.content[0].text for m in result.session.messages] == ["one", "two"]
    assert result.session.messages[0].source.lines == [1, 2]


def test_repeated_text_without_identity_is_not_deduplicated():
    message = {"type": "user", "message": {"role": "user", "content": "again"}}
    result = normalize(jsonl(message, message), "claude")
    assert len(result.session.messages) == len(result.session.turns) == 2


def test_claude_branch_and_sidechain():
    def row(uid, parent, **kw):
        return {
            "type": "user",
            "uuid": uid,
            "parentUuid": parent,
            "sessionId": "s",
            "message": {"role": "user", "content": uid},
            **kw,
        }

    result = normalize(
        jsonl(row("u1", None), row("u2", "u1"), row("u3", "u1", isSidechain=True), row("u4", "missing")),
        "claude",
    )
    assert {"branching_history", "sidechain_present", "missing_parent"} <= codes(result)
    assert result.session.messages[2].is_sidechain
    assert result.status == "partial"


def test_compaction_rollback_and_external_ancestor_are_explicit(codex_bytes):
    data = jsonl(
        {"type": "session_meta", "payload": {"id": "s", "history_base": {"path": "/private/other.jsonl"}}}
    )
    data += codex_bytes + jsonl(
        {"type": "compacted", "payload": {"message": "summary", "replacement_history": [{"role": "user"}]}},
        {"type": "event_msg", "payload": {"type": "thread_rolled_back", "num_turns": 1}},
    )
    result = normalize(data, "codex")
    assert {"external_history_base", "compaction_present", "rollback_present"} <= codes(result)
    assert result.session.messages[-1].content[0].name == "rollback"
    assert result.status == "partial"


def test_paginated_codex_only_event_message():
    result = normalize(
        jsonl(
            {
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "thread_id": "s",
                    "turn_id": "t",
                    "item": {
                        "type": "UserMessage",
                        "id": "i",
                        "content": [{"type": "text", "text": "canonical user"}],
                    },
                },
            }
        ),
        "codex",
    )
    message = result.session.messages[0]
    assert message.role == "user" and message.content[0].text == "canonical user"
    assert message.source.native_turn_id == "t"


def test_attachments_and_future_content_are_not_silently_lost():
    result = normalize(
        jsonl(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "NOT_A_REAL_IMAGE",
                            },
                        },
                        {"type": "local_image", "path": "/private/picture.png"},
                        {"type": "future_block", "secret": "unknown"},
                    ],
                },
            }
        ),
        "claude",
    )
    content = result.session.messages[0].content
    assert content[0].resource.availability == "raw_only"
    assert content[1].resource.reference == "/private/picture.png"
    assert content[2].kind == "unknown"
    assert {"attachment_not_materialized", "unknown_content_block"} <= codes(result)


def test_missing_and_ambiguous_tool_ids():
    result = normalize(
        jsonl(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "reused", "name": "Read", "input": {}},
                        {"type": "tool_use", "id": "reused", "name": "Read", "input": {}},
                        {"type": "tool_use", "name": "Missing"},
                    ],
                },
            },
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "absent", "content": "output"}],
                },
            },
        ),
        "claude",
    )
    assert {"tool_ambiguous", "tool_id_missing", "tool_missing_call"} <= codes(result)


def test_malformed_lines_do_not_discard_valid_history(claude_bytes):
    result = normalize(claude_bytes + b'{"incomplete":\n\xff\nnull\n{"value":NaN}\n', "claude")
    assert result.status == "partial"
    assert len(result.session.messages) == 4
    assert len([d for d in result.diagnostics if d.code == "invalid_record"]) == 4


@pytest.mark.parametrize(
    "provider,data", [("claude", b"{bad"), ("codex", b'{"type":"session_meta","payload":{"id":"s"}}')]
)
def test_no_readable_history_is_failed(provider, data):
    result = normalize(data, provider)
    assert result.status == "failed" and "no_messages" in codes(result)


def test_unknown_shapes_never_crash_parser():
    rng = random.Random(243)
    values = [None, True, 3, [], {}, "unknown", [{"type": []}], {"role": {}, "content": [None]}]
    for provider in ("claude", "codex"):
        rows = []
        for _ in range(300):
            rows.append(
                {
                    key: rng.choice(values)
                    for key in (
                        "type",
                        "payload",
                        "message",
                        "uuid",
                        "parentUuid",
                        "sessionId",
                        "timestamp",
                        "cwd",
                    )
                }
            )
        result = normalize(jsonl(*rows), provider)
        jsonschema.Draft202012Validator(context_schema()).validate(result.model_dump())
    normalize(
        jsonl({"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": []}}}), "codex"
    )


def test_deep_json_is_reported_not_thrown():
    data = b'{"type":"session_meta","payload":{"value":' + b"[" * 80 + b"0" + b"]" * 80 + b"}}"
    result = normalize(data, "codex")
    assert "invalid_record" in codes(result)


def test_codex_completed_agent_message_accepts_native_pascal_case_text():
    result = normalize(
        jsonl(
            {"type": "session_meta", "payload": {"id": "s"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "native",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Completed step one"}],
                },
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "thread_id": "s",
                    "turn_id": "t",
                    "item": {
                        "type": "AgentMessage",
                        "id": "native",
                        "phase": "final_answer",
                        "content": [{"type": "Text", "text": "Completed step one"}],
                    },
                },
            },
        ),
        "codex",
    )
    messages = [m for m in result.session.messages if m.role == "assistant"]
    assert len(messages) == 1 and messages[0].content[0].text == "Completed step one"
    assert messages[0].source.lines == [3, 4]
    assert "unknown_content_block" not in codes(result)


def test_multiple_native_sessions_do_not_cross_pair_tool_calls():
    result = normalize(
        jsonl(
            {"type": "session_meta", "payload": {"id": "s1"}},
            {
                "type": "response_item",
                "payload": {"type": "function_call", "call_id": "same", "name": "Read", "arguments": "{}"},
            },
            {"type": "session_meta", "payload": {"id": "s2"}},
            {
                "type": "response_item",
                "payload": {"type": "function_call_output", "call_id": "same", "output": "different session"},
            },
        ),
        "codex",
    )
    assert {"multiple_native_sessions", "tool_missing_result", "tool_missing_call"} <= codes(result)
    assert result.session.messages[-1].source.native_session_id == "s2"


def test_record_limit_retains_count_and_reports_skipped_tail(monkeypatch):
    monkeypatch.setattr("junction.parsers.common.MAX_RECORDS", 2)
    row = {"type": "user", "message": {"role": "user", "content": "repeat"}}
    result = normalize(jsonl(row, row, row, row), "claude")
    assert result.record_count == 4 and len(result.session.messages) == 2
    assert result.status == "partial" and "record_limit" in codes(result)


def test_duplicate_json_keys_are_not_silently_overwritten():
    result = normalize(
        b'{"type":"user","type":"assistant","message":{"role":"user","content":"ambiguous"}}\n', "claude"
    )
    assert result.status == "failed" and "invalid_record" in codes(result)


def test_native_turn_identity_is_scoped_to_its_session():
    rows = []
    for sid in ("first", "second"):
        rows += [
            {"type": "session_meta", "payload": {"id": sid}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "reused-turn"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "same text"}],
                },
            },
        ]
    result = normalize(jsonl(*rows), "codex")
    user_messages = [m for m in result.session.messages if m.role == "user"]
    assert user_messages[0].turn_id != user_messages[1].turn_id
