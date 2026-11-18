"""Optional, provider-independent observations; never executable permissions.

Validate the envelope without rewriting it. Unknown groups and additive fields
survive imports and exports, and missing groups mean not collected.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import Field, ValidationError, field_validator, model_validator

from .errors import Problem
from .models import PortableModel

ENVIRONMENT_EXTENSION = "junction.environment/1"
Key = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_.-]*$")]


def timestamp(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("Use an ISO timestamp with a time zone") from None
    return value


class Evidence(PortableModel):
    kind: Key
    reference: str | None = Field(None, max_length=1024)
    line: int | None = Field(None, ge=1, strict=True)
    observed_at: str | None = Field(None, json_schema_extra={"format": "date-time"})

    @field_validator("observed_at")
    @classmethod
    def valid_time(cls, value):
        return timestamp(value) if value is not None else value


class Observation(PortableModel):
    status: Literal["present", "missing", "unknown"]
    value: Any = None
    source: Evidence


class Requirement(PortableModel):
    level: Literal["required", "optional", "unknown"] = "unknown"
    constraint: Any = None


class EnvironmentItem(PortableModel):
    id: str = Field(min_length=1, max_length=512)
    observed: Observation
    requirement: Requirement | None = None


class EnvironmentGroup(PortableModel):
    coverage: Literal["not_collected", "partial", "collected", "not_applicable"]
    items: list[EnvironmentItem] = Field(default_factory=list, max_length=64)
    reason: str | None = Field(None, max_length=512)

    @model_validator(mode="after")
    def unique_items(self):
        if len({item.id for item in self.items}) != len(self.items):
            raise ValueError("Item IDs must be unique within a group")
        return self


class Collector(PortableModel):
    name: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=128)


class Environment(PortableModel):
    schema_version: Literal["junction.environment/1"]
    captured_at: str = Field(json_schema_extra={"format": "date-time"})
    collector: Collector
    scope: dict[str, Any] = Field(default_factory=dict)
    groups: dict[Key, EnvironmentGroup] = Field(max_length=32)

    @field_validator("captured_at")
    @classmethod
    def valid_time(cls, value):
        return timestamp(value)


def validate_environment(extensions: dict) -> None:
    if ENVIRONMENT_EXTENSION not in extensions:
        return
    try:
        Environment.model_validate(extensions[ENVIRONMENT_EXTENSION])
    except ValidationError:
        # Validation errors may contain input data. Do not echo it into responses.
        raise Problem(400, "invalid_environment", "Invalid junction.environment/1 manifest.") from None


def environment_schema() -> dict:
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", **Environment.model_json_schema()}
