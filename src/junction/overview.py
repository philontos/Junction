"""Small, reproducible reading aid. Excerpts are evidence, not inferred task state."""

from collections import Counter

from .models import NormalizedContext

OVERVIEW_EXTENSION = "junction.overview/1"


def build_overview(context: NormalizedContext, title: str | None = None) -> dict:
    users, assistants = [], []
    for message in context.session.messages:
        if message.is_meta or message.is_sidechain:
            continue
        text = "\n".join(b.text for b in message.content if b.kind == "text" and b.text).strip()
        if not text:
            continue
        if message.role == "user":
            users.append((message, text))
        elif message.role == "assistant":
            assistants.append((message, text))
    title_source = "provided" if title else "first_user_message" if users else "fallback"
    generated_title = title or (" ".join(users[0][1].split())[:80] if users else f"{context.provider} Context")
    evidence = []
    for kind, pair in [
        ("first_user", users[0] if users else None),
        ("latest_user", users[-1] if len(users) > 1 else None),
        ("latest_assistant", assistants[-1] if assistants else None),
    ]:
        if pair:
            message, text = pair
            evidence.append({
                "kind": kind, "message_id": message.id, "lines": message.source.lines,
                "text": text[:360], "truncated": len(text) > 360,
            })
    labels = {"first_user": "首条用户记录", "latest_user": "最近用户记录", "latest_assistant": "最近助手记录"}
    description = "\n".join(
        f"{labels[e['kind']]}：{e['text']}{'…' if e['truncated'] else ''}" for e in evidence
    ) or "未找到可摘录的用户或助手文本，请查看原始记录与解析说明。"
    missing = []
    for key, absent in [
        ("user_text", not users), ("assistant_text", not assistants),
        ("native_session_id", not context.session.native_id), ("cwd", not context.session.cwd),
    ]:
        if absent:
            missing.append({"field": key})
    timestamps = sum(m.timestamp is None for m in context.session.messages)
    if timestamps:
        missing.append({"field": "message_timestamp", "count": timestamps})
    resources = Counter(
        b.resource.availability for m in context.session.messages for b in m.content if b.resource
    )
    return {
        "generator": "extractive/1", "title": generated_title, "title_source": title_source,
        "description": description, "evidence": evidence, "missing": missing,
        "diagnostic_counts": dict(Counter(d.code for d in context.diagnostics)),
        "resource_availability": dict(resources),
    }
