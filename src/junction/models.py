"""The portable read contract. Provider records remain in the original archive."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "junction.context/1"
PARSER_VERSION = "0.1.0"
Provider = Literal["claude", "codex"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Diagnostic(Model):
    code: str
    severity: Literal["info", "warning", "error"] = "warning"
    line: int | None = None
    detail: str


class SourceLocation(Model):
    lines: list[int]
    native_id: str | None = None
    native_message_id: str | None = None
    native_parent_id: str | None = None
    native_logical_parent_id: str | None = None
    native_turn_id: str | None = None
    native_session_id: str | None = None
    record_type: str


class Resource(Model):
    kind: Literal["path", "url", "embedded", "unknown"]
    reference: str | None = None
    media_type: str | None = None
    availability: Literal["external_unverified", "raw_only", "unknown"]


class Block(Model):
    kind: Literal["text", "reasoning", "tool_call", "tool_result", "attachment", "marker", "unknown"]
    text: str | None = None
    name: str | None = None
    call_id: str | None = None
    arguments: Any = None
    output: Any = None
    is_error: bool | None = None
    resource: Resource | None = None
    native_type: str | None = None
    pair_status: Literal["matched", "missing_call", "missing_result", "ambiguous", "missing_id"] | None = None
    related_messages: list[str] = Field(default_factory=list)


class Message(Model):
    id: str
    sequence: int
    turn_id: str
    role: Literal["user", "assistant", "tool", "system", "developer", "unknown"]
    timestamp: str | None = None
    content: list[Block]
    source: SourceLocation
    is_meta: bool = False
    is_sidechain: bool = False


class Turn(Model):
    id: str
    sequence: int
    boundary: Literal["native", "inferred", "preamble"]
    native_id: str | None = None
    first_message_id: str
    message_count: int
    preview: str


class Session(Model):
    native_id: str | None = None
    source_version: str | None = None
    cwd: str | None = None
    history_semantics: Literal["recorded_history"] = "recorded_history"
    effective_history: Literal["not_reconstructed"] = "not_reconstructed"
    turns: list[Turn]
    messages: list[Message]


class NormalizedContext(Model):
    schema_version: Literal["junction.context/1"] = SCHEMA_VERSION
    provider: Provider
    parser_version: str = PARSER_VERSION
    status: Literal["ready", "partial", "failed"]
    source_sha256: str
    source_bytes: int
    record_count: int
    recognized_record_count: int
    session: Session
    diagnostics: list[Diagnostic]
    extensions: dict[str, Any] = Field(default_factory=dict)


def context_schema() -> dict:
    schema = NormalizedContext.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    return schema
