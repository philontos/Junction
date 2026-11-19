from collections import defaultdict

from junction_adapters.models import Block

from .blocks import content_blocks
from .common import Candidate, ParseState, identifier, metadata_block, string

METADATA = {
    "progress",
    "queue-operation",
    "file-history-snapshot",
    "summary",
    "custom-title",
    "ai-title",
    "last-prompt",
    "mode",
    "permission-mode",
    "bridge-session",
    "pr-link",
    "saved_hook_context",
}


def parse_claude(records: list[tuple[int, dict]], state: ParseState):
    native_ids = {identifier(r.get("uuid")) for _, r in records if identifier(r.get("uuid"))}
    user_children = defaultdict(set)
    session_ids = set()
    for line, raw in records:
        kind = string(raw.get("type")) or "unknown"
        session_id = identifier(raw.get("sessionId")) or identifier(raw.get("session_id"))
        if session_id:
            session_ids.add(session_id)
        state.native_id = state.native_id or session_id
        state.version = state.version or identifier(raw.get("version"))
        state.cwd = state.cwd or string(raw.get("cwd"))
        native_id = identifier(raw.get("uuid"))
        parent_id = identifier(raw.get("parentUuid"))
        message = raw.get("message")
        native_role = identifier(message.get("role")) if isinstance(message, dict) else None
        is_meta = raw.get("isMeta") is True
        sidechain = raw.get("isSidechain") is True
        if kind in METADATA:
            role, is_meta = "system", True
            content = [Block(kind="marker", name=kind, output=raw, native_type=kind)]
        elif kind == "system" and raw.get("subtype") == "compact_boundary":
            content = [
                Block(
                    kind="marker",
                    name="compaction",
                    output=raw.get("compactMetadata"),
                    native_type="compact_boundary",
                )
            ]
            role = "system"
            state.note(
                "compaction_present",
                line,
                "Recorded history includes compaction; effective history is not reconstructed.",
            )
        elif isinstance(message, dict):
            role = string(message.get("role")) or kind
            content = content_blocks(message.get("content"), state, line)
            native_id = native_id or identifier(message.get("id"))
            if content and all(b.kind == "tool_result" for b in content):
                role = "tool"
            content += metadata_block(message, ("model", "usage", "stop_reason", "stop_sequence"), line=line)
            content += metadata_block(raw, ("requestId", "agentId", "permissionMode"), line=line)
        elif kind == "attachment":
            role = "system"
            content = [Block(kind="marker", name="attachment_record", output=raw.get("attachment"))]
            is_meta = True
            state.note(
                "attachment_record",
                line,
                "Injected attachment metadata retained; external resources are not fetched.",
            )
        elif kind == "system":
            role = "system"
            content = [
                Block(
                    kind="marker",
                    name=identifier(raw.get("subtype")) or "system",
                    text=string(raw.get("content")),
                    output=raw.get("data"),
                )
            ]
            is_meta = True
        else:
            state.note("unknown_record", line, "Unrecognized Claude record retained in original.")
            continue
        state.recognized += 1
        if not content:
            state.note("empty_message", line, "Message contains no supported content.")
            continue
        if sidechain:
            state.note(
                "sidechain_present",
                line,
                "Sidechain content is labeled; no main-branch selection was inferred.",
            )
        if parent_id and parent_id not in native_ids:
            state.note("missing_parent", line, "Message parent is not present in this input snapshot.")
        if role == "user" and not is_meta and parent_id and native_id:
            user_children[parent_id].add(native_id)
        state.candidates.append(
            Candidate(
                line=line,
                role=role,
                content=content,
                record_type=kind,
                timestamp=identifier(raw.get("timestamp")),
                native_id=native_id,
                parent_id=parent_id,
                api_message_id=identifier(message.get("id")) if isinstance(message, dict) else None,
                logical_parent_id=identifier(raw.get("logicalParentUuid")),
                session_id=session_id or state.native_id,
                is_meta=is_meta,
                is_sidechain=sidechain,
                native_role=native_role,
            )
        )
    if any(len(children) > 1 for children in user_children.values()):
        state.note(
            "branching_history",
            None,
            "Multiple user successors share a parent; branch selection is not reconstructed.",
        )
    if len(session_ids) > 1:
        state.note(
            "multiple_native_sessions",
            None,
            "Input includes multiple native session identities; sources remain labeled.",
        )
