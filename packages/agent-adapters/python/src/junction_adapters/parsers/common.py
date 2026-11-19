import hashlib
import io
import json
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from junction_adapters.models import (
    Block,
    Diagnostic,
    Message,
    NativeRecord,
    NormalizedContext,
    RecordIndex,
    Session,
    SourceLocation,
    Turn,
)

MAX_RECORDS = 100_000


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def identifier(value: Any) -> str | None:
    text = string(value)
    return text if text and len(text) <= 1024 else None


def metadata_block(value: dict, keys: tuple[str, ...], *, line: int) -> list[Block]:
    """Keep provider fields verbatim, in chunkable content, without inventing common units."""
    fields = {key: value[key] for key in keys if key in value}
    return [Block(kind="marker", name="message_metadata", output={"line": line, "fields": fields})] if fields else []


def strict_json(text: str) -> Any:
    def reject(value: str):
        raise ValueError(f"Non-JSON constant: {value}")

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON object key")
            result[key] = value
        return result

    value = json.loads(text, parse_constant=reject, object_pairs_hook=unique_keys)
    pending = [(value, 0)]
    while pending:
        node, depth = pending.pop()
        if depth > 64:
            raise ValueError("JSON nesting exceeds 64 levels")
        if isinstance(node, dict):
            pending.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            pending.extend((v, depth + 1) for v in node)
    # Reject unpaired surrogate escapes as well as malformed UTF-8 bytes.
    json_text(value).encode("utf-8")
    return value


@dataclass
class Candidate:
    line: int
    role: str
    content: list[Block]
    record_type: str
    timestamp: str | None = None
    native_id: str | None = None
    parent_id: str | None = None
    api_message_id: str | None = None
    logical_parent_id: str | None = None
    turn_id: str | None = None
    session_id: str | None = None
    is_meta: bool = False
    is_sidechain: bool = False
    duplicate_lines: list[int] = field(default_factory=list)
    channel: str = "primary"
    native_role: str | None = None


@dataclass
class ParseState:
    diagnostics: list[Diagnostic] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    native_id: str | None = None
    version: str | None = None
    cwd: str | None = None
    recognized: int = 0
    records: int = 0
    native_records: list[NativeRecord] = field(default_factory=list)
    record_values: dict[int, dict] = field(default_factory=dict)

    def note(self, code: str, line: int | None, detail: str, severity: str = "warning"):
        self.diagnostics.append(Diagnostic(code=code, line=line, detail=detail, severity=severity))


def read_records(raw: bytes, state: ParseState) -> list[tuple[int, dict]]:
    records = []
    offset = 0
    for line_no, data in enumerate(io.BytesIO(raw), 1):
        start = offset
        offset += len(data)
        if not data.strip():
            continue
        state.records += 1
        if state.records > MAX_RECORDS:
            if state.records == MAX_RECORDS + 1:
                state.note(
                    "record_limit", line_no, "Remaining records are archived but not interpreted.", "error"
                )
            continue
        native = NativeRecord(
            id=f"r{line_no}", sequence=len(state.native_records) + 1, line=line_no,
            byte_offset=start, byte_length=len(data), sha256=hashlib.sha256(data).hexdigest(),
            status="invalid",
        )
        state.native_records.append(native)
        try:
            text = data.decode("utf-8-sig" if line_no == 1 else "utf-8")
            obj = strict_json(text)
            if not isinstance(obj, dict):
                raise ValueError("JSONL records must be objects")
            records.append((line_no, obj))
            state.record_values[line_no] = obj
            native.status = "unmapped"
            native.native_type = identifier(obj.get("type")) or identifier(obj.get("role"))
        except (ValueError, UnicodeError, RecursionError):
            state.note(
                "invalid_record", line_no, "Invalid JSON object or UTF-8; original bytes retained.", "error"
            )
    return records


def build_messages(state: ParseState) -> tuple[list[Message], list[Turn]]:
    messages: list[Message] = []
    turns: list[Turn] = []
    seen: dict[tuple, Candidate] = {}
    kept = []
    for item in sorted(state.candidates, key=lambda c: c.line):
        # Equal text alone is never a duplicate. Preserve split blocks sharing a native message id.
        identity_blocks = []
        for block in item.content:
            value = block.model_dump()
            if block.kind == "marker" and block.name == "message_metadata":
                value["output"] = {"fields": block.output["fields"]}
            identity_blocks.append(value)
        key = (
            item.session_id,
            item.native_id,
            item.parent_id,
            item.turn_id,
            item.role,
            item.is_meta,
            item.is_sidechain,
            json_text(identity_blocks),
            # Equal visible text does not prove that usage, signatures or future fields agree.
            json_text(state.record_values.get(item.line)),
        )
        if item.native_id and key in seen:
            seen[key].duplicate_lines.extend([item.line, *item.duplicate_lines])
            continue
        if item.native_id:
            seen[key] = item
        kept.append(item)

    current: Turn | None = None
    current_native: tuple | None = None
    native_turns: dict[tuple, Turn] = {}
    for item in kept:
        user_boundary = (
            item.role == "user"
            and not item.is_meta
            and any(b.kind in {"text", "attachment"} for b in item.content)
        )
        native_key = (item.session_id, item.turn_id)
        if item.turn_id and native_key in native_turns:
            current = native_turns[native_key]
            current_native = native_key
        elif (
            current is None
            or (item.turn_id and native_key != current_native)
            or (not item.turn_id and user_boundary)
        ):
            n = len(turns) + 1
            boundary = "native" if item.turn_id else ("inferred" if user_boundary else "preamble")
            current = Turn(
                id=f"t{n}",
                sequence=n,
                boundary=boundary,
                native_id=item.turn_id,
                first_message_id=f"m{len(messages) + 1}",
                message_count=0,
                preview="",
            )
            turns.append(current)
            current_native = native_key if item.turn_id else None
            if item.turn_id:
                native_turns[native_key] = current
        current.message_count += 1
        text = next((b.text for b in item.content if b.kind == "text" and b.text), "")
        if not current.preview and text:
            current.preview = text[:240]
        messages.append(
            Message(
                id=f"m{len(messages) + 1}",
                sequence=len(messages) + 1,
                turn_id=current.id,
                role=item.role
                if item.role in {"user", "assistant", "tool", "system", "developer"}
                else "unknown",
                timestamp=item.timestamp,
                content=item.content,
                is_meta=item.is_meta,
                is_sidechain=item.is_sidechain,
                source=SourceLocation(
                    lines=sorted(set([item.line, *item.duplicate_lines])),
                    native_id=item.native_id,
                    native_parent_id=item.parent_id,
                    native_message_id=item.api_message_id,
                    native_logical_parent_id=item.logical_parent_id,
                    native_turn_id=item.turn_id,
                    native_session_id=item.session_id,
                    native_role=item.native_role,
                    record_ids=[f"r{line}" for line in sorted(set([item.line, *item.duplicate_lines]))],
                    record_type=item.record_type,
                ),
            )
        )

    calls = defaultdict(list)
    results = defaultdict(list)
    for message in messages:
        for block in message.content:
            if block.kind not in {"tool_call", "tool_result"}:
                continue
            if not block.call_id:
                block.pair_status = "missing_id"
                state.note("tool_id_missing", message.source.lines[0], "Tool record has no native call id.")
                continue
            key = (message.source.native_session_id, block.call_id)
            (calls if block.kind == "tool_call" else results)[key].append((message, block))
    for key in calls.keys() | results.keys():
        left, right = calls[key], results[key]
        status = (
            "matched"
            if len(left) == len(right) == 1
            else ("missing_call" if not left else "missing_result" if not right else "ambiguous")
        )
        if len(left) > 1 or len(right) > 1:
            status = "ambiguous"
        for message, block in left + right:
            block.pair_status = status
            # Ambiguous IDs do not establish links; avoid a quadratic cross-product of candidate IDs.
            opposite = right if block.kind == "tool_call" else left
            block.related_messages = [opposite[0][0].id] if status == "matched" else []
        if status != "matched":
            state.note(
                f"tool_{status}",
                (left or right)[0][0].source.lines[0],
                "Tool relationship is incomplete or ambiguous; no execution state inferred.",
            )
    return messages, turns


def normalize(raw: bytes, provider: str) -> NormalizedContext:
    from .registry import get_adapter

    adapter = get_adapter(provider)
    state = ParseState()
    records = read_records(raw, state)
    adapter.parse(records, state)
    if state.cwd and len(state.cwd) > 4096:
        state.cwd = None
        state.note("invalid_cwd", None, "Oversized working directory retained only in original.")
    messages, turns = build_messages(state)
    indexed = {r.id: r for r in state.native_records}
    for message in messages:
        for rid in message.source.record_ids:
            record = indexed[rid]
            record.status = "projected"
            record.message_ids.append(message.id)
    readable = any(
        m.role in {"user", "assistant", "tool"}
        and any(b.kind not in {"unknown", "marker"} for b in m.content)
        for m in messages
    )
    if not readable:
        state.note("no_messages", None, "No readable conversation messages were recognized.", "error")
    status = (
        "failed"
        if not readable
        else ("partial" if any(d.severity != "info" for d in state.diagnostics) else "ready")
    )
    return NormalizedContext(
        provider=provider,
        parser_version=adapter.parser_version,
        status=status,
        source_sha256=hashlib.sha256(raw).hexdigest(),
        source_bytes=len(raw),
        record_count=state.records,
        recognized_record_count=state.recognized,
        record_index=RecordIndex(indexed_records=len(indexed), complete=len(indexed) == state.records),
        records=state.native_records,
        session=Session(
            native_id=state.native_id,
            source_version=state.version,
            cwd=state.cwd,
            turns=turns,
            messages=messages,
        ),
        diagnostics=state.diagnostics,
    )
