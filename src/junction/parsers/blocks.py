from typing import Any

from junction.models import Block, Resource

from .common import ParseState, identifier, string


def content_blocks(value: Any, state: ParseState, line: int) -> list[Block]:
    if isinstance(value, str):
        return [Block(kind="text", text=value)]
    if value is None:
        return []
    if not isinstance(value, list):
        state.note("invalid_content", line, "Message content has an unsupported shape; retained in original.")
        return [Block(kind="unknown", native_type=type(value).__name__)]
    result = []
    for item in value:
        if not isinstance(item, dict):
            state.note("invalid_content_block", line, "Non-object content block retained in original.")
            result.append(Block(kind="unknown"))
            continue
        kind = string(item.get("type")) or "unknown"
        if kind in {"text", "Text", "input_text", "output_text", "summary_text", "reasoning_text"}:
            text = item.get("text")
            if isinstance(text, str):
                result.append(Block(kind="text", text=text, native_type=kind))
            else:
                state.note("invalid_text", line, "Text block has no string text; retained in original.")
                result.append(Block(kind="unknown", native_type=kind))
        elif kind == "tool_use":
            result.append(
                Block(
                    kind="tool_call",
                    call_id=identifier(item.get("id")),
                    name=identifier(item.get("name")),
                    arguments=item.get("input"),
                    native_type=kind,
                )
            )
        elif kind == "tool_result":
            error = item.get("is_error")
            result.append(
                Block(
                    kind="tool_result",
                    call_id=identifier(item.get("tool_use_id")),
                    output=item.get("content"),
                    is_error=error if isinstance(error, bool) else None,
                    native_type=kind,
                )
            )
        elif kind in {"thinking", "redacted_thinking"}:
            result.append(Block(kind="reasoning", text=string(item.get("thinking")), native_type=kind))
            if kind == "redacted_thinking":
                state.note(
                    "opaque_reasoning", line, "Provider-opaque reasoning retained only in original.", "info"
                )
        elif kind in {"image", "input_image", "local_image", "document", "file", "input_file"}:
            source = item.get("source") if isinstance(item.get("source"), dict) else {}
            ref = string(item.get("image_url")) or string(item.get("path")) or string(source.get("url"))
            ref = ref or string(source.get("path")) or string(item.get("file_url"))
            embedded = source.get("type") == "base64" or bool(ref and ref.startswith("data:"))
            resource = Resource(
                kind="embedded"
                if embedded
                else "url"
                if ref and "://" in ref
                else "path"
                if ref
                else "unknown",
                reference=None if embedded else ref,
                media_type=string(source.get("media_type")) or string(item.get("media_type")),
                availability="raw_only" if embedded else "external_unverified" if ref else "unknown",
            )
            result.append(Block(kind="attachment", resource=resource, native_type=kind))
            state.note(
                "attachment_not_materialized",
                line,
                "Attachment bytes were not extracted or fetched; inspect resource availability.",
            )
        else:
            result.append(Block(kind="unknown", native_type=kind[:128]))
            state.note("unknown_content_block", line, "Unrecognized content block retained in original.")
    return result
