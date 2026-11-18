import copy
import json

import jsonschema
import pytest
from conftest import upload

from junction.environment import ENVIRONMENT_EXTENSION as KEY


def manifest():
    return {
        "schema_version": KEY,
        "captured_at": "2026-11-18T06:00:00Z",
        "collector": {"name": "switchyard", "version": "1"},
        "scope": {"cwd": "/source/worktree", "probe_context": "switchyard_process"},
        "groups": {
            "runtimes": {"coverage": "partial", "items": [{
                "id": "node", "observed": {
                    "status": "present", "value": {"version": "24.15.0"},
                    "source": {"kind": "local_probe"},
                },
            }]},
            "access": {"coverage": "not_collected", "items": [], "reason": "not_checked"},
            "future-category": {"coverage": "partial", "items": [], "future": {"retain": True}},
        },
        "future-field": ["retained"],
    }


def test_environment_roundtrip_dedup_revision_and_shared_raw_boundary(service, claude_bytes):
    client, store, auth = service
    original = manifest()
    params = {"extensions": json.dumps({KEY: original}), "source_key": "task:environment", "shared": True}
    first, path = upload(client, auth["alice"], claude_bytes, **params)
    repeated, _ = upload(client, auth["alice"], claude_bytes, **params)
    assert repeated["reused"] and repeated["id"] == first["id"]
    assert client.get(path, headers=auth["bob"]).json()["revision"]["normalized"]["extensions"][KEY] == original
    assert store.export("bob", first["context_id"], first["id"])["extensions"][KEY] == original
    assert client.get(path + "/raw", headers=auth["bob"]).status_code == 404
    newer = copy.deepcopy(original)
    newer["captured_at"] = "2026-11-19T06:00:00Z"
    newer["groups"]["runtimes"]["items"][0]["observed"]["value"]["version"] = "24.16.0"
    second, _ = upload(client, auth["alice"], claude_bytes, **{**params, "extensions": json.dumps({KEY: newer})})
    assert second["context_id"] == first["context_id"] and second["id"] != first["id"]
    assert second["source_sha256"] == first["source_sha256"]
    assert store.export("alice", first["context_id"], first["id"])["extensions"][KEY] == original
    schema = client.get("/v1/schema/environment").json()
    jsonschema.Draft202012Validator(schema).validate(original)


@pytest.mark.parametrize("mutation", [
    lambda m: m.update(schema_version="junction.environment/2"),
    lambda m: m.update(captured_at="yesterday"),
    lambda m: m.update(captured_at="2026-11-18T06:00:00"),
    lambda m: m["groups"]["access"].update(coverage="authorized"),
    lambda m: m["groups"]["runtimes"]["items"][0]["observed"].update(status="trusted"),
    lambda m: m["groups"]["runtimes"]["items"][0]["observed"]["source"].update(observed_at="unknown"),
    lambda m: m["groups"]["runtimes"]["items"].append(m["groups"]["runtimes"]["items"][0]),
    lambda m: m["groups"]["runtimes"]["items"][0].update(requirement={"level": "inherited_permission"}),
])
def test_invalid_environment_is_rejected_without_echoing_input(service, claude_bytes, mutation):
    client, store, auth = service
    value = manifest()
    mutation(value)
    value["private_extra"] = "INPUT_CANARY"
    result = client.post("/v1/imports", params={"provider": "claude", "extensions": json.dumps({KEY: value})},
                         content=claude_bytes, headers={**auth["alice"], "Content-Type": "application/x-ndjson"})
    assert result.status_code == 400
    assert result.json()["error"]["code"] == "invalid_environment"
    assert "INPUT_CANARY" not in result.text
    assert store.list_contexts("alice")["items"] == []


def test_missing_environment_or_unknown_extension_stays_compatible(service, claude_bytes):
    client, _, auth = service
    first, _ = upload(client, auth["alice"], claude_bytes)
    assert KEY not in first["normalized"]["extensions"]
    future = {"junction.environment/2": {"opaque": "retain for a future reader"}}
    second, _ = upload(client, auth["alice"], claude_bytes, extensions=json.dumps(future))
    assert second["normalized"]["extensions"]["junction.environment/2"] == future["junction.environment/2"]
