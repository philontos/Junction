from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from junction.api import create_app
from junction.store import Store, new_token

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def claude_bytes():
    return (FIXTURES / "claude-handoff.jsonl").read_bytes()


@pytest.fixture
def codex_bytes():
    return (FIXTURES / "codex-handoff.jsonl").read_bytes()


@pytest.fixture
def service(tmp_path):
    store = Store(tmp_path / "data")
    tokens = {name: new_token() for name in ("alice", "bob", "eve")}
    for name, token in tokens.items():
        store.add_user(name, token)
    with TestClient(create_app(store.root)) as client:
        yield client, store, {u: {"Authorization": "Bearer " + token} for u, token in tokens.items()}


def upload(client, headers, data, provider="claude", **params):
    result = client.post(
        "/v1/imports",
        params={"provider": provider, **params},
        content=data,
        headers={**headers, "Content-Type": "application/x-ndjson"},
    )
    assert result.status_code in {200, 201}, result.text
    body = result.json()
    return body, f"/v1/contexts/{body['context_id']}/revisions/{body['id']}"
