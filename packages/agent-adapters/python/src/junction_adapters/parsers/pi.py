"""Pi's recorded session tree. Never replay extensions or infer the active branch.

Format reference: earendil-works/pi, coding-agent/docs/session-format.md,
653f332b6fe22e2e927dd3d553d20234a3de27f0. Original bytes remain authoritative.
"""

from collections import defaultdict

from junction_adapters.models import Block, Resource

from .common import Candidate, ParseState, identifier, metadata_block, string

MARKERS = {
    "model_change", "thinking_level_change", "usage", "custom", "label", "session_info",
    "compaction", "branch_summary", "context_edit",
}


def pi_content(value, state: ParseState, line: int) -> list[Block]:
    if isinstance(value, str):
        return [Block(kind="text", text=value)] if value else []
    if value is None:
        return []
    if not isinstance(value, list):
        state.note("unknown_content", line, "Non-list Pi content retained without interpretation.")
        return [Block(kind="unknown", output=value)]
    blocks = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            state.note("unknown_content", line, "Unrecognized Pi content block retained.")
            blocks.append(Block(kind="unknown", output=raw))
            continue
        kind = string(raw.get("type")) or "unknown"
        handled = {"type"}
        if kind == "text" and isinstance(raw.get("text"), str):
            blocks.append(Block(kind="text", text=raw["text"], native_type=kind))
            handled.add("text")
        elif kind == "thinking" and isinstance(raw.get("thinking"), str):
            blocks.append(Block(kind="reasoning", text=raw["thinking"], native_type=kind))
            handled.add("thinking")
        elif kind == "toolCall":
            blocks.append(Block(kind="tool_call", name=identifier(raw.get("name")),
                                call_id=identifier(raw.get("id")), arguments=raw.get("arguments"),
                                native_type=kind))
            handled.update({"name", "id", "arguments"})
        elif kind == "image":
            embedded = isinstance(raw.get("data"), str)
            blocks.append(Block(kind="attachment", native_type=kind, resource=Resource(
                kind="embedded" if embedded else "unknown",
                reference=f"raw:line:{line}:content:{index}",
                media_type=string(raw.get("mimeType")),
                availability="raw_only" if embedded else "unknown",
            )))
            state.note("embedded_resource" if embedded else "missing_resource", line,
                       "Pi image is referenced in the original record; no external file is fetched.",
                       "info" if embedded else "warning")
            handled.update({"data", "mimeType"})
        else:
            state.note("unknown_content", line, "Unrecognized Pi content block retained.")
            blocks.append(Block(kind="unknown", native_type=kind, output=raw))
            continue
        extra = {key: item for key, item in raw.items() if key not in handled}
        if extra:
            blocks.append(Block(kind="marker", name="block_metadata", native_type=kind,
                                output={"block_index": index, "fields": extra}))
    return blocks


def parse_pi(records: list[tuple[int, dict]], state: ParseState):
    native_ids = {identifier(r.get("id")) for _, r in records if r.get("type") != "session"}
    children = defaultdict(set)
    sessions = set()
    header_seen = False
    for line, raw in records:
        kind = string(raw.get("type")) or "unknown"
        native_id, parent = identifier(raw.get("id")), identifier(raw.get("parentId"))
        role, native_role, is_meta = "system", None, True
        if kind == "session":
            header_seen = True
            if native_id:
                sessions.add(native_id)
                state.native_id = native_id
            state.cwd = string(raw.get("cwd")) or state.cwd
            version = raw.get("version")
            if isinstance(version, (str, int)):
                state.version = str(version)
            if version not in (1, 2, 3):
                state.note("unknown_source_version", line, "Unrecognized Pi session version; only known fields interpreted.")
            if version == 1:
                state.note("legacy_linear_history", line, "Legacy Pi history has no native tree links.", "info")
            if raw.get("parentSession"):
                state.note("external_parent_session", line, "Parent session is referenced but not fetched or merged.")
            content = [Block(kind="marker", name="session_header", output=raw, native_type=kind)]
            native_id, parent = None, None  # Header id is a session, not a tree entry.
        elif kind == "message" and isinstance(raw.get("message"), dict):
            message = raw["message"]
            native_role = identifier(message.get("role"))
            role = "tool" if native_role == "toolResult" else native_role or "unknown"
            is_meta = role not in {"user", "assistant", "tool"}
            content = pi_content(message.get("content"), state, line)
            if role == "tool":
                text = "\n".join(b.text for b in content if b.kind == "text" and b.text is not None)
                content = [Block(kind="tool_result", call_id=identifier(message.get("toolCallId")),
                                 name=identifier(message.get("toolName")), output=text,
                                 is_error=message.get("isError") if isinstance(message.get("isError"), bool) else None,
                                 native_type="toolResult"), *[b for b in content if b.kind != "text"]]
            if native_role in {"custom", "hookMessage", "bashExecution", "branchSummary", "compactionSummary"}:
                role, is_meta = "system", True
                state.note("extended_message", line, "Pi extension message retained as reference material.", "info")
            elif role not in {"user", "assistant", "tool", "system"}:
                state.note("unknown_role", line, "Unknown Pi message role retained without assigning authority.")
            content += metadata_block(message, tuple(key for key in message if key != "content"), line=line)
            content += metadata_block(raw, tuple(key for key in raw if key not in {
                "type", "id", "parentId", "timestamp", "message",
            }), line=line)
        elif kind == "custom_message":
            content = pi_content(raw.get("content"), state, line)
            content += metadata_block(raw, tuple(key for key in raw if key != "content"), line=line)
        elif kind in MARKERS:
            content = [Block(kind="marker", name=kind, text=string(raw.get("summary")),
                             output=raw, native_type=kind)]
            if kind in {"compaction", "branch_summary", "context_edit"}:
                state.note(f"{kind}_present", line,
                           "Recorded history retained; effective branch/context changes are not replayed.")
        else:
            state.note("unknown_record", line, "Unrecognized Pi record retained in the original and record index.")
            continue
        state.recognized += 1
        if not content:
            state.note("empty_message", line, "Pi entry contains no readable content.")
            continue
        if parent and parent not in native_ids:
            state.note("missing_parent", line, "Parent entry is not present in this input snapshot.")
        if kind != "session" and native_id and "parentId" in raw:
            children[parent].add(native_id)
        state.candidates.append(Candidate(
            line=line, role=role, content=content, record_type=kind,
            timestamp=identifier(raw.get("timestamp")), native_id=native_id,
            parent_id=parent, session_id=state.native_id, is_meta=is_meta, native_role=native_role,
        ))
    if not header_seen:
        state.note("missing_session_header", None, "Pi session header is missing; identity and cwd are unknown.")
    if len(sessions) > 1:
        state.note("multiple_native_sessions", None, "Multiple Pi sessions in one input remain labeled.")
    if any(len(ids) > 1 for ids in children.values()):
        state.note("branching_history", None, "Pi tree contains multiple branches; active branch was not inferred.")
