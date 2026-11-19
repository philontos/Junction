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


def test_card_summary_uses_requests_and_ignores_scaffolding_and_greetings(service):
    client, store, auth = service
    texts = [
        "测试", "<environment_context><cwd>/private/worktree</cwd></environment_context>",
        "<system-reminder>SessionStart hook: very long instructions</system-reminder>",
        "hello who are you", "# AGENTS.md instructions for /work\nUse the tools",
        "我想做一个简单的五子棋游戏，然后先讨论方案再编码",
        "<system-reminder>Tools unavailable</system-reminder>我想做一个简单的五子棋游戏，然后先讨论方案再编码",
        "Base directory for this skill: /skills/design\n# Follow these instructions",
        "一个人和 AI 下棋，提升水平", "初学者，希望有提示和复盘", "浏览器网页，技术栈你来定",
    ]
    records = [{"type": "user", "uuid": f"u{i}", "message": {"role": "user", "content": text}}
               for i, text in enumerate(texts)]
    records.append({"type": "assistant", "message": {"role": "assistant", "content": "已上线，所有测试通过"}})
    raw = "\n".join(json.dumps(r, ensure_ascii=False) for r in records).encode()
    rev, _ = upload(client, auth["alice"], raw, title="测试", shared=True)
    overview = rev["normalized"]["extensions"][KEY]
    assert overview["title"] == "做一个简单的五子棋游戏"
    assert overview["title_source"] == "user_request"
    assert all(text in overview["summary"] for text in ["五子棋", "AI", "提示和复盘", "浏览器"])
    assert all(text not in overview["summary"] for text in ["private", "instructions", "skill", "已上线", "hello"])
    assert len(overview["summary"]) <= 160
    assert [e["lines"] for e in overview["summary_evidence"]] == [[6], [9], [10], [11]]
    exported = store.export("alice", rev["context_id"], rev["id"])
    assert len(exported["session"]["messages"]) == len(records)
    assert store.read_raw("alice", rev["context_id"], rev["id"])[0] == raw


def test_card_summary_preserves_meaningful_titles_and_extracts_handoff_request(service):
    client, _, auth = service
    text = ("<environment_context>hidden paths</environment_context>\n"
            "请接续 Junction 中的历史任务。先读取 .tdsp/context/SKILL.md 和 manifest.json。\n\n"
            "接手人的本次要求：\n完成 `None` 输入支持并运行测试。不要提交或推送。")
    raw = json.dumps({"type": "user", "message": {"role": "user", "content": text}}).encode()
    rev, _ = upload(client, auth["alice"], raw, title="输入边界处理")
    overview = rev["normalized"]["extensions"][KEY]
    assert overview["title"] == "输入边界处理"
    assert overview["summary"] == "完成 None 输入支持并运行测试。不要提交或推送"
    assert overview["summary_evidence"][0]["lines"] == [1]


def test_refresh_old_overviews_only_changes_derived_copy(service, claude_bytes, monkeypatch):
    from junction import cli

    client, store, auth = service
    rev, _ = upload(client, auth["alice"], claude_bytes, title="Original title")
    with store.connection(write=True) as db:
        old = {"generator": "extractive/1", "title": "Original title", "title_source": "provided"}
        db.execute("UPDATE revision_overviews SET data_json=? WHERE revision_id=?", (json.dumps(old), rev["id"]))
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                  if r[0] != "revision_overviews"]
        before = {t: [tuple(r) for r in db.execute(f'SELECT * FROM "{t}" ORDER BY rowid')] for t in tables}
    output = []
    monkeypatch.setattr(cli, "print_json", output.append)
    cli.run(cli.parser().parse_args(["refresh-overviews", "--data-dir", str(store.root)]))
    assert output[0]["updated"] == 1
    overview = store.get_context("alice", rev["context_id"])["revision"]["normalized"]["extensions"][KEY]
    assert overview["title"] == "Original title"
    assert overview["summary"].startswith("Add an empty-input guard")
    assert store.refresh_overviews()["updated"] == 0
    with store.connection() as db:
        after = {t: [tuple(r) for r in db.execute(f'SELECT * FROM "{t}" ORDER BY rowid')] for t in tables}
    assert after == before
    assert store.read_raw("alice", rev["context_id"], rev["id"])[0] == claude_bytes
    assert store.check()["ok"]


def test_summary_is_bounded_and_does_not_invent_a_goal(service):
    client, _, auth = service
    raw = json.dumps({"type": "user", "message": {"role": "user", "content": "测试"}}).encode()
    rev, _ = upload(client, auth["alice"], raw)
    overview = rev["normalized"]["extensions"][KEY]
    assert overview["summary"] == ""
    assert overview["summary_evidence"] == []
    long = json.dumps({"type": "user", "message": {"role": "user", "content": "改进测试覆盖率 " * 1000}}).encode()
    rev, _ = upload(client, auth["alice"], long)
    overview = rev["normalized"]["extensions"][KEY]
    assert len(overview["summary"]) <= 160
    assert len(overview["title"]) <= 48
