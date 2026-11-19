from collections import defaultdict

from junction_adapters.models import Block

from .blocks import content_blocks
from .common import Candidate, ParseState, identifier, json_text, metadata_block, strict_json, string

LIFECYCLE = {
    "task_started",
    "task_complete",
    "task_completed",
    "turn_aborted",
    "token_count",
    "thread_settings_applied",
    "agent_message_delta",
    "agent_reasoning_delta",
}
EXECUTION_ITEMS = {"CommandExecution", "FileChange", "McpToolCall", "WebSearch", "ImageView", "Extension"}


def response_content(payload: dict, state: ParseState, line: int) -> tuple[str, list[Block]] | None:
    kind = string(payload.get("type")) or "unknown"
    if kind == "message":
        return string(payload.get("role")) or "unknown", content_blocks(payload.get("content"), state, line)
    if kind in {"function_call", "custom_tool_call"}:
        arguments = payload.get("arguments") if kind == "function_call" else payload.get("input")
        arguments_text = arguments if isinstance(arguments, str) else None
        if isinstance(arguments, str) and kind == "function_call":
            try:
                arguments = strict_json(arguments)
            except (ValueError, UnicodeError, RecursionError):
                state.note(
                    "unparsed_tool_arguments", line, "Tool arguments retained as the original string.", "info"
                )
        return "assistant", [
            Block(
                kind="tool_call",
                name=identifier(payload.get("name")),
                call_id=identifier(payload.get("call_id")),
                arguments=arguments,
                arguments_text=arguments_text,
                native_type=kind,
            )
        ]
    if kind in {"function_call_output", "custom_tool_call_output"}:
        return "tool", [
            Block(
                kind="tool_result",
                call_id=identifier(payload.get("call_id")),
                output=payload.get("output"),
                native_type=kind,
            )
        ]
    if kind == "reasoning":
        content = content_blocks(payload.get("summary"), state, line)
        content += content_blocks(payload.get("content"), state, line)
        for block in content:
            if block.kind == "text":
                block.kind = "reasoning"
        if payload.get("encrypted_content"):
            content.append(Block(kind="reasoning", native_type="encrypted_reasoning"))
            state.note("opaque_reasoning", line, "Encrypted reasoning retained only in original.", "info")
        return "assistant", content
    if kind in {"additional_tools", "compaction"}:
        return "system", [Block(kind="marker", name=kind, output=payload)]
    return None


def parse_codex(records: list[tuple[int, dict]], state: ParseState):
    current_turn = None
    current_session = None
    events = []
    session_ids = set()
    for line, raw in records:
        kind = string(raw.get("type")) or "unknown"
        payload = raw.get("payload")
        if not isinstance(payload, dict):
            state.note("invalid_payload", line, "Codex record has no object payload; retained in original.")
            continue
        payload_type = string(payload.get("type")) or "unknown"
        content = []
        role = "system"
        native_id = identifier(payload.get("id"))
        turn_id = identifier(payload.get("turn_id")) or current_turn
        if kind == "session_meta":
            sid = identifier(payload.get("id"))
            current_session = sid
            current_turn = None
            turn_id = None
            if sid:
                session_ids.add(sid)
            state.native_id = state.native_id or sid
            state.version = state.version or identifier(payload.get("cli_version"))
            state.cwd = state.cwd or string(payload.get("cwd"))
            if payload.get("history_base"):
                state.note(
                    "external_history_base",
                    line,
                    "Ancestor history is referenced but was not provided; no files were followed.",
                )
            content = [Block(kind="marker", name="session_metadata", output=payload)]
        elif kind == "turn_context":
            current_turn = identifier(payload.get("turn_id")) or current_turn
            turn_id = current_turn
            state.cwd = state.cwd or string(payload.get("cwd"))
            content = [Block(kind="marker", name="turn_context", output=payload)]
        elif kind == "response_item":
            parsed = response_content(payload, state, line)
            if parsed is None:
                state.note("unknown_response_item", line, "Unrecognized response item retained in original.")
                continue
            role, content = parsed
            content += metadata_block(payload, ("model", "usage", "status", "channel", "phase", "end_turn"), line=line)
            if payload_type == "compaction":
                state.note(
                    "compaction_present", line, "Compaction retained; effective history is not reconstructed."
                )
        elif kind == "compacted":
            content = [Block(kind="marker", name="compaction", output=payload)]
            state.note(
                "compaction_present",
                line,
                "Compaction and replacement history retained as a checkpoint, not replayed.",
            )
        elif kind in {"world_state", "token_usage_record"}:
            content = [Block(kind="marker", name=kind, output=payload)]
        elif kind == "event_msg":
            if payload_type == "task_started":
                current_turn = identifier(payload.get("turn_id")) or current_turn
                turn_id = current_turn
            if payload_type in LIFECYCLE:
                content = [Block(kind="marker", name=payload_type, output=payload)]
            elif payload_type == "thread_rolled_back":
                content = [Block(kind="marker", name="rollback", output=payload)]
                state.note(
                    "rollback_present",
                    line,
                    "Rollback retained; recorded messages may include superseded work.",
                )
            elif payload_type in {"user_message", "agent_message"}:
                role = "user" if payload_type == "user_message" else "assistant"
                content = content_blocks(payload.get("message"), state, line)
                content += metadata_block(payload, ("phase", "channel"), line=line)
                events.append(
                    Candidate(
                        line,
                        role,
                        content,
                        f"event_msg/{payload_type}",
                        timestamp=identifier(raw.get("timestamp")),
                        turn_id=turn_id,
                        session_id=current_session,
                        channel="event",
                    )
                )
                state.recognized += 1
                continue
            elif payload_type == "item_completed" and isinstance(payload.get("item"), dict):
                item = payload["item"]
                item_type = string(item.get("type")) or "unknown"
                if item_type in {"UserMessage", "AgentMessage"}:
                    role = "user" if item_type == "UserMessage" else "assistant"
                    content = content_blocks(
                        item.get("content") if "content" in item else item.get("text"), state, line
                    )
                    content += metadata_block(item, ("phase", "channel", "model", "usage", "status"), line=line)
                    events.append(
                        Candidate(
                            line,
                            role,
                            content,
                            f"event_msg/item_completed/{item_type}",
                            timestamp=identifier(raw.get("timestamp")),
                            native_id=identifier(item.get("id")),
                            turn_id=turn_id,
                            session_id=identifier(payload.get("thread_id")) or current_session,
                            channel="event",
                        )
                    )
                    state.recognized += 1
                    continue
                if item_type in EXECUTION_ITEMS or item_type in {"Reasoning", "ContextCompaction"}:
                    content = [
                        Block(kind="marker", name="execution_detail", native_type=item_type, output=item)
                    ]
                    if item_type == "ContextCompaction":
                        state.note(
                            "compaction_present",
                            line,
                            "Compaction event retained; effective history is not reconstructed.",
                        )
                    elif item_type in EXECUTION_ITEMS:
                        state.note(
                            "execution_event_unpaired",
                            line,
                            "Execution event retained as detail; no API tool-call relationship inferred.",
                        )
                else:
                    state.note(
                        "unknown_completed_item", line, "Unrecognized completed item retained in original."
                    )
                    continue
            else:
                state.note("unknown_event", line, "Unrecognized event retained in original.")
                continue
        else:
            state.note("unknown_record", line, "Unrecognized Codex record retained in original.")
            continue
        state.recognized += 1
        if content:
            state.candidates.append(
                Candidate(
                    line,
                    role,
                    content,
                    kind + "/" + payload_type,
                    timestamp=identifier(raw.get("timestamp")),
                    native_id=native_id,
                    turn_id=turn_id,
                    session_id=current_session,
                    is_meta=role == "system",
                    native_role=identifier(payload.get("role")),
                )
            )
    # Deduplicate only matching representations within an explicitly identified turn.
    # A repeated prompt in a different turn remains a separate message.
    primaries = defaultdict(list)
    for candidate in state.candidates:
        if candidate.role in {"user", "assistant"} and candidate.turn_id:
            primaries[_display_key(candidate)].append(candidate)
    consumed = set()
    for event in events:
        if not event.content:
            state.note("empty_event_message", event.line, "Event message contains no readable content.")
            continue
        possible = [c for c in primaries[_display_key(event)] if c.line not in consumed
                    and not (c.native_id and event.native_id and c.native_id != event.native_id)
                    and _metadata_agrees(c, event)] if event.turn_id else []
        match = possible[0] if len(possible) == 1 else None
        if match:
            match.duplicate_lines.append(event.line)
            match.content.extend(b for b in event.content if b.kind == "marker" and b.name == "message_metadata")
            consumed.add(match.line)
        else:
            if len(possible) > 1:
                state.note("ambiguous_display_record", event.line,
                           "Multiple primary records match this display event; all representations retained.")
            if not event.turn_id and any(c.role == event.role for c in state.candidates):
                state.note(
                    "event_identity_unresolved",
                    event.line,
                    "No native turn identity to safely correlate this display record; both representations retained.",
                )
            state.candidates.append(event)
    if len(session_ids) > 1:
        state.note("multiple_native_sessions", None, "Input contains multiple native session identities.")


def _display_key(candidate: Candidate):
    # Native content block names differ between response_item and item_completed.
    visible = [
        (b.kind, b.text) if b.kind == "text" else (b.kind, json_text(b.model_dump()))
        for b in candidate.content if not (b.kind == "marker" and b.name == "message_metadata")
    ]
    return candidate.session_id, candidate.turn_id, candidate.role, json_text(visible)


def _metadata_agrees(left: Candidate, right: Candidate) -> bool:
    def fields(candidate):
        return {key: value for b in candidate.content
                if b.kind == "marker" and b.name == "message_metadata"
                for key, value in b.output["fields"].items()}
    a, b = fields(left), fields(right)
    return all(a[key] == b[key] for key in a.keys() & b.keys())
