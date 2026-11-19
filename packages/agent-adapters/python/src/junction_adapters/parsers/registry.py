"""Explicit, versioned adapters. Importing an archive never loads executable plugins."""

from collections.abc import Callable
from dataclasses import dataclass

from junction_adapters.models import PARSER_VERSION

from .claude import parse_claude
from .codex import parse_codex
from .common import ParseState
from .pi import parse_pi


@dataclass(frozen=True)
class Adapter:
    id: str
    version: str
    source_format: str
    parse: Callable[[list[tuple[int, dict]], ParseState], None]

    @property
    def parser_version(self) -> str:
        # Both interpretation layers participate in the immutable revision fingerprint.
        return f"{PARSER_VERSION}+{self.id}.{self.version}"

    def describe(self) -> dict:
        return {"id": self.id, "version": self.version, "source_format": self.source_format,
                "parser_version": self.parser_version}


ADAPTERS = {
    adapter.id: adapter for adapter in (
        Adapter("claude", "1", "claude-code.jsonl", parse_claude),
        Adapter("codex", "1", "codex-rollout.jsonl", parse_codex),
        Adapter("pi", "1", "pi-session.jsonl", parse_pi),
    )
}


def get_adapter(provider: str) -> Adapter:
    if not isinstance(provider, str) or provider not in ADAPTERS:
        raise ValueError(f"No installed adapter for {provider!r}.")
    return ADAPTERS[provider]


def providers() -> list[dict]:
    return [adapter.describe() for _, adapter in sorted(ADAPTERS.items())]
