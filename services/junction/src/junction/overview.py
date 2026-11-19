"""Small, reproducible reading aid. Excerpts are evidence, not inferred task state."""

import re
from collections import Counter

from .models import NormalizedContext

OVERVIEW_EXTENSION = "junction.overview/1"
OVERVIEW_GENERATOR = "extractive/2"

# Only the reading aid is cleaned. Messages, source lines and raw bytes stay intact.
_SCAFFOLD = re.compile(
    r"<(system-reminder|environment_context|local-command-caveat|local-command-stdout|turn_aborted)\b[^>]*>"
    r".*?</\1>", re.DOTALL | re.IGNORECASE,
)
_PLACEHOLDER = re.compile(
    r"(?:测试|测试任务|新任务|新建任务|未命名|继续|好的?|好呀|可以|没问题|你好|您好|你是谁|"
    r"test(?:\s*task)?|new\s*task|untitled|ok(?:ay)?|yes|continue|hello|hi|"
    r"(?:hello[, ]+)?who are you)[\s\d.!！?？。]*", re.IGNORECASE,
)


def _plain(text: str) -> str:
    text = re.sub(r"```.*?(?:```|$)", " ", text, flags=re.DOTALL)
    text = re.sub(r"!?\[([^\]]+)\]\([^\n)]*\)", r"\1", text)
    text = re.sub(r"^\s*(?:#{1,6}\s+|[-*+]\s+)", "", text, flags=re.MULTILINE)
    return " ".join(text.replace("**", "").replace("`", "").split()).strip()


def _request(text: str) -> str:
    text = _SCAFFOLD.sub("", text).strip()
    if text.startswith(("# AGENTS.md instructions", "Base directory for this skill:", "<command-name>")):
        return ""
    if text.startswith("请接续 Junction 中的历史任务。"):
        text = text.partition("接手人的本次要求：")[2]
    text = re.sub(r"Use this image as visual context:\s*\S+\s*", "", text)
    text = _plain(text)
    return "" if _PLACEHOLDER.fullmatch(text) else text


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    # Keep English words intact when possible; CJK and long identifiers can wrap.
    if cut[-1:].isascii() and text[limit - 1:limit].isalnum() and " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" ,，;；。.") + "…"


def _card_copy(users, title):
    requests, seen = [], set()
    for message, text in users:
        clean = _request(text)
        if clean and clean.casefold() not in seen:
            requests.append((message, clean))
            seen.add(clean.casefold())
    supplied = _plain(title or "")
    if supplied and not _PLACEHOLDER.fullmatch(supplied):
        generated_title, title_source = supplied, "provided"
    elif requests:
        first = re.split(r"[。！？\n，,；;]|[.!?]\s", requests[0][1], maxsplit=1)[0]
        first = re.sub(r"^(?:我想|我希望|请帮我|帮我)(?:要)?", "", first).strip()
        generated_title = _clip(first or requests[0][1], 48)
        title_source = "first_user_message" if requests[0][0] is users[0][0] else "user_request"
    else:
        generated_title, title_source = supplied, "provided" if supplied else "fallback"
    # A goal plus recent requirements, never the assistant's unverified completion claims.
    selected = requests[:1] + requests[max(1, len(requests) - 3):]
    summary = _clip("；".join(_clip(text, 80 if n == 0 else 48).rstrip("。.;；")
                              for n, (_, text) in enumerate(selected)), 160)
    return {
        "title": _clip(generated_title, 80), "title_source": title_source,
        "summary": summary,
        "summary_evidence": [{"message_id": m.id, "lines": m.source.lines} for m, _ in selected],
    }


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
    card = _card_copy(users, title)
    if not card["title"]:
        card["title"] = f"{context.provider} Context"
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
        "generator": OVERVIEW_GENERATOR, **card,
        "description": description, "evidence": evidence, "missing": missing,
        "diagnostic_counts": dict(Counter(d.code for d in context.diagnostics)),
        "resource_availability": dict(resources),
    }
